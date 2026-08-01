import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

import { loadConfig } from './config.js';
import { mergeSessionAudio } from './mergeAudio.js';
import { transcribeMergedWithGroq } from './providers/transcribeGroq.js';
import { transcribeMergedWithLocalWhisper } from './providers/transcribeLocal.js';
import { transcribeMergedWithFallback } from './providers/transcribeFallback.js';
import { generateNarrative } from './narrate.js';

function loadCharacterMap() {
  const path = join(process.cwd(), 'src', 'characters.json');
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Converte o offset (em segundos, dentro do arquivo fundido) para o timestamp
 * absoluto real, usando o mapa de offsets gerado no merge.
 */
function resolveAbsoluteTimestamp(offsetSec, offsets) {
  let best = offsets[0];
  for (const o of offsets) {
    if (o.offsetSec <= offsetSec) best = o;
    else break;
  }
  const deltaSec = offsetSec - best.offsetSec;
  return best.timestamp + deltaSec * 1000;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour12: false });
}

function buildMarkdown(entries, characterMap, sessionFolder) {
  const MERGE_GAP_MS = 20_000;
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const blocks = [];

  for (const entry of sorted) {
    const character = characterMap[entry.userId];
    const displayName = character?.name ?? `Usuário ${entry.userId}`;
    const isMaster = character?.role === 'master';
    const last = blocks[blocks.length - 1];
    const gap = last ? entry.timestamp - last.lastTimestamp : Infinity;

    if (last && last.userId === entry.userId && gap <= MERGE_GAP_MS) {
      last.text += ' ' + entry.text;
      last.lastTimestamp = entry.timestamp;
    } else {
      blocks.push({
        userId: entry.userId,
        displayName,
        isMaster,
        timestamp: entry.timestamp,
        lastTimestamp: entry.timestamp,
        text: entry.text,
      });
    }
  }

  const lines = blocks.map((b) => {
    const time = formatTime(b.timestamp);
    return b.isMaster
      ? `> *[${time}]* **${b.displayName} (Master):** ${b.text}`
      : `*[${time}]* **${b.displayName}:** ${b.text}`;
  });

  return `# Sessão de RPG — ${basename(sessionFolder)}\n\n---\n\n` + lines.join('\n\n');
}

export async function transcribeAudio(sessionFolder, onProgress) {
  const startTime = Date.now();
  console.log(`⏱️ Transcrição (modo fundido) iniciada em: ${new Date(startTime).toLocaleString('pt-BR')}`);

  const config = loadConfig();
  const characterMap = loadCharacterMap();

  console.log('🔗 Fundindo áudios por pessoa...');
  const merged = await mergeSessionAudio(sessionFolder);

  const transcribeFn =
    config.transcription.provider === 'local' ? (paths, cfg) => transcribeMergedWithLocalWhisper(paths.wavPath, cfg) :
    config.transcription.provider === 'fallback' ? transcribeMergedWithFallback :
    (paths, cfg) => transcribeMergedWithGroq(paths.mp3Path, cfg);

  const entries = [];
  const outputPath = join(sessionFolder, 'transcricao.md');
  const userIds = Object.keys(merged);
  const totalUsers = userIds.length;

  for (const [index, userId] of userIds.entries()) {
    const { wavPath, mp3Path, offsets } = merged[userId];
    console.log(`🎧 [${index + 1}/${totalUsers}] Transcrevendo ${userId}...`);

    if (onProgress) onProgress({
      phase: 'transcribing',
      current: index + 1,
      total: totalUsers,
      message: `Transcrevendo ${userId} (${index + 1}/${totalUsers})...`,
    });

    try {
      const segments = await transcribeFn({ wavPath, mp3Path }, config.transcription);
      console.log(`✅ ${userId}: ${segments.length} segmento(s) de fala reconhecidos`);

      for (const seg of segments) {
        const absoluteTimestamp = resolveAbsoluteTimestamp(seg.start, offsets);
        entries.push({ userId, timestamp: absoluteTimestamp, text: seg.text });
      }
    } catch (err) {
      console.error(`❌ Erro ao transcrever ${userId}:`, err.message);
    }

    writeFileSync(outputPath, buildMarkdown(entries, characterMap, sessionFolder), 'utf-8');
  }

  console.log(`\n📄 Transcrição salva em: ${outputPath}`);
  console.log(`⏱️ Tempo total de transcrição: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutos\n`);

  if (onProgress) onProgress({ phase: 'done', message: 'Transcrição concluída!' });
  return outputPath;
}

export async function generateSessionNarrative(sessionFolder, onProgress) {
  const config = loadConfig();
  const outputPath = join(sessionFolder, 'transcricao.md');

  if (!existsSync(outputPath)) {
    throw new Error('Transcrição não encontrada. Transcreva os áudios primeiro.');
  }

  if (!config.narrative || !config.narrative.provider) {
    throw new Error('Narrativa desabilitada ou sem provedor na configuração (config.yaml).');
  }

  const narrativeStart = Date.now();
  console.log(`✨ Gerando versão narrativa (provedor: ${config.narrative.provider})...`);

  if (onProgress) onProgress({
    phase: 'condensing',
    current: 0,
    total: 0,
    message: 'Iniciando condensação da narrativa...',
  });

  const rawMarkdown = readFileSync(outputPath, 'utf-8');
  const narrativePath = join(sessionFolder, 'narrativa.md');

  const narrative = await generateNarrative(rawMarkdown, config.narrative, (partial) => {
    writeFileSync(narrativePath, partial, 'utf-8');
    if (onProgress) onProgress({
      phase: 'condensing',
      message: 'Condensando pedaços da transcrição...',
      partial: true,
    });
  });

  writeFileSync(narrativePath, narrative, 'utf-8');
  console.log(`📖 Narrativa salva em: ${narrativePath}`);
  console.log(`⏱️ Tempo total de narrativa: ${((Date.now() - narrativeStart) / 1000 / 60).toFixed(1)} minutos`);

  if (onProgress) onProgress({ phase: 'done', message: 'Narrativa concluída!' });
  return narrativePath;
}

export async function transcribeMergedSession(sessionFolder) {
  await transcribeAudio(sessionFolder);
  await generateSessionNarrative(sessionFolder);
}

if (process.argv[1] && process.argv[1].endsWith('transcribe.js')) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Uso: node src/transcribeMerged.js "caminho/da/pasta/da/sessao"');
    process.exit(1);
  }
  transcribeMergedSession(folder).catch((err) => {
    console.error('❌ Erro geral:', err);
    process.exit(1);
  });
}