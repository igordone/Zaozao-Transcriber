import { readdirSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const SILENCE_GAP_SECONDS = 2;
const SILENCE_VOLUME_THRESHOLD_DB = -40; // fragmentos com pico abaixo disso são descartados

function parseFilename(filename) {
  const match = filename.match(/^(\d+)-(\d+)\.wav$/);
  if (!match) return null;
  return { userId: match[1], timestamp: Number(match[2]) };
}

function getDurationSecondsReliable(filePath) {
  try {
    execFileSync(ffmpegPath, ['-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  execFileSync(ffmpegPath, [
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
    '-t', String(seconds),
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
}

/**
 * Mede o pico de volume de um arquivo de áudio. Retorna true se o fragmento
 * for essencialmente silêncio/ruído de fundo (pico abaixo do limiar), caso
 * em que não vale a pena incluí-lo na fusão nem transcrevê-lo.
 *
 * Usa spawnSync (em vez de execFileSync) porque o filtro volumedetect escreve
 * as estatísticas no stderr mesmo quando o ffmpeg termina com sucesso.
 */
function isMostlySilence(filePath, thresholdDb = SILENCE_VOLUME_THRESHOLD_DB) {
  const result = spawnSync(ffmpegPath, [
    '-i', filePath,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ]);

  const stderr = result.stderr?.toString() ?? '';
  const match = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);

  if (!match) return false; // não conseguiu medir - por segurança, mantém o fragmento

  const maxVolume = parseFloat(match[1]);
  return maxVolume < thresholdDb;
}

/**
 * Funde todos os .wav de cada pessoa em um único arquivo grande por pessoa,
 * descartando antes fragmentos que são essencialmente silêncio/ruído de fundo
 * (evita alimentar o Whisper com trechos longos sem fala real, que podem
 * disparar loops de repetição, principalmente no Whisper local).
 *
 * Insere ~2s de silêncio real entre os trechos restantes, para evitar que o
 * Whisper misture falas de momentos diferentes.
 *
 * Gera duas versões de cada fusão:
 * - .wav (sem compressão): usado como entrada para o Whisper local
 * - .mp3 (comprimido, 32kbps mono 16kHz): usado para upload na Groq
 *
 * Reaproveita a fusão existente de uma execução anterior, se já tiver sido feita.
 *
 * Retorna: { userId: { wavPath, mp3Path, offsets } }
 */
export function mergeSessionAudio(sessionFolder, { forceRemerge = false } = {}) {
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

    if (!forceRemerge && existsSync(wavPath) && existsSync(mp3Path) && existsSync(offsetsPath)) {
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
  generateSilenceFile(silencePath, SILENCE_GAP_SECONDS);

  for (const userId of userIdsToMerge) {
    const allChunks = byUser[userId];
    console.log(`🔎 Analisando ${allChunks.length} arquivo(s) de ${userId} (filtrando silêncio/ruído)...`);

    const chunks = [];
    let skippedCount = 0;

    for (const chunk of allChunks) {
      const chunkPath = resolve(join(sessionFolder, chunk.filename));
      if (isMostlySilence(chunkPath)) {
        skippedCount++;
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

    chunks.forEach((chunk, index) => {
      const chunkPath = resolve(join(sessionFolder, chunk.filename));
      offsets.push({ timestamp: chunk.timestamp, offsetSec: cumulativeSeconds });

      listLines.push(`file '${chunkPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
      cumulativeSeconds += getDurationSecondsReliable(chunkPath);

      if (index < chunks.length - 1) {
        listLines.push(`file '${silencePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
        cumulativeSeconds += SILENCE_GAP_SECONDS;
      }
    });

    writeFileSync(concatListPath, listLines.join('\n'), 'utf-8');

    execFileSync(ffmpegPath, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c:a', 'pcm_s16le',
      wavPath,
    ]);

    console.log(`🗜️ Comprimindo ${userId} para upload...`);
    execFileSync(ffmpegPath, [
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
  mergeSessionAudio(folder, { forceRemerge });
}