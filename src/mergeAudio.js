import { readdirSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const SILENCE_GAP_SECONDS = 2;

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
 * Gera uma versão comprimida (MP3, 16kHz mono, 32kbps) do arquivo fundido,
 * especificamente para caber no limite de 25MB da Groq. O Whisper já
 * trabalha internamente em 16kHz mono, então essa compressão não perde
 * qualidade relevante para transcrição de voz.
 */
function compressForUpload(wavPath, mp3Path) {
  execFileSync(ffmpegPath, [
    '-y',
    '-i', wavPath,
    '-ar', '16000',
    '-ac', '1',
    '-b:a', '32k',
    '-codec:a', 'libmp3lame',
    mp3Path,
  ]);
}

/**
 * Funde todos os .wav de cada pessoa em um único arquivo grande por pessoa,
 * inserindo silêncio real entre trechos originais para evitar que o Whisper
 * misture falas de momentos diferentes.
 *
 * Gera duas versões de cada fusão:
 * - .wav (sem compressão): usado como entrada para o Whisper local
 * - .mp3 (comprimido, 32kbps mono 16kHz): usado para upload na Groq,
 *   já que WAV bruto estoura o limite de 25MB da API em poucos minutos
 *
 * Se a pasta merged/ já existir com os arquivos de um usuário (de uma
 * execução anterior), reaproveita em vez de refazer o merge do zero.
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
    const chunks = byUser[userId];
    console.log(`🔗 Fundindo ${chunks.length} arquivo(s) de ${userId}...`);

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
    compressForUpload(wavPath, mp3Path);

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