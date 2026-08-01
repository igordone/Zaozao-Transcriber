import { readdirSync, writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execFile, spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const SILENCE_GAP_SECONDS = 2;
const SILENCE_VOLUME_THRESHOLD_DB = -40;

function parseFilename(filename) {
  const match = filename.match(/^(\d+)-(\d+)\.wav$/);
  if (!match) return null;
  return { userId: match[1], timestamp: Number(match[2]) };
}

function execFileAsync(args) {
  return new Promise((res, rej) => {
    const proc = execFile(ffmpegPath, args, (err, stdout, stderr) => {
      if (err) rej(Object.assign(err, { stderr }));
      else res({ stdout, stderr });
    });
    proc.stdout?.resume();
    proc.stderr?.resume();
  });
}

function spawnAsync(args) {
  return new Promise((res, rej) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.resume();
    proc.on('close', (code) => {
      if (code === 0) res({ stderr });
      else rej(Object.assign(new Error(`ffmpeg exited with code ${code}`), { stderr }));
    });
    proc.on('error', rej);
  });
}

async function getDurationSecondsReliable(filePath) {
  try {
    await execFileAsync(['-i', filePath]);
  } catch (err) {
    const stderr = err.stderr?.toString() ?? '';
    const match = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (match) {
      const [, h, m, s] = match;
      return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
    }
  }
  return 0;
}

function generateSilenceFile(outputPath, seconds) {
  return execFileAsync([
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
    '-t', String(seconds),
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
}

async function isMostlySilence(filePath, thresholdDb = SILENCE_VOLUME_THRESHOLD_DB) {
  const result = await spawnAsync([
    '-i', filePath,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ]);

  const stderr = result.stderr?.toString() ?? '';
  const match = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);

  if (!match) return false;

  const maxVolume = parseFloat(match[1]);
  return maxVolume < thresholdDb;
}

export async function mergeSessionAudio(sessionFolder, { forceRemerge = false } = {}) {
  const files = readdirSync(sessionFolder).filter((f) => f.endsWith('.wav'));
  const byUser = {};

  for (const file of files) {
    const parsed = parseFilename(file);
    if (!parsed) continue;
    if (!byUser[parsed.userId]) byUser[parsed.userId] = [];
    byUser[parsed.userId].push({ ...parsed, filename: file });
  }

  for (const userId in byUser) {
    byUser[userId].sort((a, b) => a.timestamp - b.timestamp);
  }

  const mergedFolder = join(sessionFolder, 'merged');
  if (!existsSync(mergedFolder)) mkdirSync(mergedFolder, { recursive: true });

  const result = {};
  const userIdsToMerge = [];

  for (const userId of Object.keys(byUser)) {
    const wavPath = join(mergedFolder, `${userId}.wav`);
    const mp3Path = join(mergedFolder, `${userId}.mp3`);
    const offsetsPath = join(mergedFolder, `${userId}.offsets.json`);
    const hasMerged = existsSync(wavPath) && existsSync(mp3Path) && existsSync(offsetsPath);

    const hasBrutes = byUser[userId].some((c) => existsSync(join(sessionFolder, c.filename)));

    if (hasMerged && (!forceRemerge || !hasBrutes)) {
      console.log(`♻️ Reaproveitando fusão existente de ${userId}...`);
      const offsets = JSON.parse(readFileSync(offsetsPath, 'utf-8'));
      result[userId] = { wavPath, mp3Path, offsets };
    } else {
      userIdsToMerge.push(userId);
    }
  }

  if (userIdsToMerge.length === 0) {
    console.log('✅ Todos os áudios já estavam fundidos - nada a refazer.');
    return result;
  }

  const silencePath = resolve(join(mergedFolder, '_silence.wav'));
  await generateSilenceFile(silencePath, SILENCE_GAP_SECONDS);

  for (const userId of userIdsToMerge) {
    const allChunks = byUser[userId];
    console.log(`🔎 Analisando ${allChunks.length} arquivo(s) de ${userId} (filtrando silêncio/ruído)...`);

    const chunks = [];
    let skippedCount = 0;

    for (const chunk of allChunks) {
      const chunkPath = resolve(join(sessionFolder, chunk.filename));
      if (await isMostlySilence(chunkPath)) {
        skippedCount++;
        try { unlinkSync(chunkPath); } catch {}
        continue;
      }
      chunks.push(chunk);
    }

    console.log(`🔗 Fundindo ${chunks.length} arquivo(s) de ${userId} (${skippedCount} descartado(s) como silêncio/ruído)...`);

    if (chunks.length === 0) {
      console.log(`⚠️ ${userId}: nenhum fragmento com fala real encontrado, pulando.`);
      continue;
    }

    const concatListPath = join(mergedFolder, `${userId}-list.txt`);
    const wavPath = join(mergedFolder, `${userId}.wav`);
    const mp3Path = join(mergedFolder, `${userId}.mp3`);
    const offsets = [];

    let cumulativeSeconds = 0;
    const listLines = [];

    for (const [index, chunk] of chunks.entries()) {
      const chunkPath = resolve(join(sessionFolder, chunk.filename));
      offsets.push({ timestamp: chunk.timestamp, offsetSec: cumulativeSeconds });

      listLines.push(`file '${chunkPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
      cumulativeSeconds += await getDurationSecondsReliable(chunkPath);

      if (index < chunks.length - 1) {
        listLines.push(`file '${silencePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
        cumulativeSeconds += SILENCE_GAP_SECONDS;
      }
    }

    writeFileSync(concatListPath, listLines.join('\n'), 'utf-8');

    await execFileAsync([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c:a', 'pcm_s16le',
      wavPath,
    ]);

    console.log(`🗜️ Comprimindo ${userId} para upload...`);
    await execFileAsync([
      '-y',
      '-i', wavPath,
      '-ar', '16000',
      '-ac', '1',
      '-b:a', '32k',
      '-codec:a', 'libmp3lame',
      mp3Path,
    ]);

    writeFileSync(join(mergedFolder, `${userId}.offsets.json`), JSON.stringify(offsets, null, 2), 'utf-8');

    result[userId] = { wavPath, mp3Path, offsets };
    console.log(`✅ ${userId}: fundido (${cumulativeSeconds.toFixed(1)}s totais)`);

    for (const chunk of chunks) {
      const chunkPath = resolve(join(sessionFolder, chunk.filename));
      try { unlinkSync(chunkPath); } catch {}
    }
    try { unlinkSync(concatListPath); } catch {}
    console.log(`🧹 ${userId}: ${chunks.length} arquivo(s) .wav bruto(s) removido(s) após fusão.`);
  }

  return result;
}

if (process.argv[1] && process.argv[1].endsWith('mergeAudio.js')) {
  const folder = process.argv[2];
  const forceRemerge = process.argv.includes('--force');
  if (!folder) {
    console.error('Uso: node src/mergeAudio.js "caminho/da/pasta/da/sessao" [--force]');
    process.exit(1);
  }
  mergeSessionAudio(folder, { forceRemerge }).catch((err) => {
    console.error('❌ Erro na fusão:', err);
    process.exit(1);
  });
}