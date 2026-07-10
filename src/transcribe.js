import 'dotenv/config';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

const NO_SPEECH_THRESHOLD = 0.4;
const MIN_SEGMENT_DURATION = 0.35; // segundos - descarta segmentos ínfimos (quase sempre ruído)
const MERGE_GAP_MS = 20_000; // só funde falas da mesma pessoa se estiverem a até 20s de distância

// Processa em lotes, respeitando o rate limit (20 req/min no tier gratuito da Groq)
const BATCH_SIZE = 8;
const DELAY_BETWEEN_BATCHES_MS = 25_000; // ~8 arquivos a cada 25s ≈ 19/min, seguro

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCharacterMap() {
  const path = join(__dirname, 'characters.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function parseFilename(filename) {
  const match = filename.match(/^(\d+)-(\d+)\.wav$/);
  if (!match) return null;
  return { userId: match[1], timestamp: Number(match[2]) };
}

function parseRetryDelay(errorText, fallbackMs = 5000) {
  const match = errorText.match(/try again in ([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500;
  return fallbackMs;
}

const HALLUCINATION_PATTERNS = [
  /^obrigado\.?$/i,
  /^e a[íi]\.?$/i,
  /^tchau\.?$/i,
  /^oi\.?$/i,
  /^ol[áa]\.?$/i,
  /legenda(do)? (por|pela)/i,
  /legendas? (pela|da) comunidade/i,
  /inscreva-se/i,
  /amara\.org/i,
];

async function transcribeFile(filePath, attempt = 1) {
  const fileBuffer = readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: 'audio/wav' });

  const form = new FormData();
  form.append('file', blob, basename(filePath));
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'pt');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });

  if (response.status === 429) {
    const errorText = await response.text();
    const delay = parseRetryDelay(errorText);
    console.log(`⏳ Rate limit. Aguardando ${(delay / 1000).toFixed(1)}s...`);
    await sleep(delay);
    return transcribeFile(filePath, attempt + 1);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API retornou ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const segments = data.segments ?? [];

  const validSegments = segments.filter((s) => {
    const duration = s.end - s.start;
    if (duration < MIN_SEGMENT_DURATION) return false;
    if (s.no_speech_prob > NO_SPEECH_THRESHOLD) return false;
    if (s.avg_logprob < -1.0) return false;
    if (s.compression_ratio > 2.4) return false;

    const text = s.text.trim();
    if (HALLUCINATION_PATTERNS.some((pattern) => pattern.test(text))) return false;

    return true;
  });

  if (validSegments.length === 0) return '';
  return validSegments.map((s) => s.text.trim()).join(' ').trim();
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour12: false });
}

function buildMarkdown(entries, characterMap, sessionFolder) {
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

  const header = `# Sessão de RPG — ${basename(sessionFolder)}\n\n---\n\n`;
  return header + lines.join('\n\n');
}

/**
 * Processa arquivos em lotes concorrentes, respeitando o rate limit por janela de tempo.
 */
async function processBatch(files, sessionFolder, entries, characterMap, outputPath) {
  const results = await Promise.allSettled(
    files.map(async (file) => {
      const parsed = parseFilename(file);
      if (!parsed) return null;

      const filePath = join(sessionFolder, file);
      const text = await transcribeFile(filePath);
      return text ? { ...parsed, text, file } : null;
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      entries.push(result.value);
      const { text, file } = result.value;
      console.log(`✅ ${file}: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);
    } else if (result.status === 'rejected') {
      console.error(`❌ Erro:`, result.reason?.message ?? result.reason);
    }
  }

  // Salva progresso após cada lote
  writeFileSync(outputPath, buildMarkdown(entries, characterMap, sessionFolder), 'utf-8');
}

export async function transcribeSession(sessionFolder) {
  const characterMap = loadCharacterMap();
  const files = readdirSync(sessionFolder).filter((f) => f.endsWith('.wav'));

  if (files.length === 0) {
    console.log('⚠️ Nenhum arquivo .wav encontrado nessa pasta.');
    return;
  }

  console.log(`🔎 Encontrados ${files.length} arquivos. Processando em lotes de ${BATCH_SIZE}...`);

  const entries = [];
  const outputPath = join(sessionFolder, 'transcricao.md');
  const totalBatches = Math.ceil(files.length / BATCH_SIZE);

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`\n📦 Lote ${batchNumber}/${totalBatches} (${batch.length} arquivos)...`);

    await processBatch(batch, sessionFolder, entries, characterMap, outputPath);

    if (i + BATCH_SIZE < files.length) {
      console.log(`⏳ Aguardando ${DELAY_BETWEEN_BATCHES_MS / 1000}s antes do próximo lote...`);
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log(`\n📄 Transcrição narrativa salva em: ${outputPath}`);
}

if (process.argv[1] && process.argv[1].endsWith('transcribe.js')) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Uso: node src/transcribe.js "caminho/da/pasta/da/sessao"');
    process.exit(1);
  }
  transcribeSession(folder).catch((err) => {
    console.error('❌ Erro geral na transcrição:', err);
    process.exit(1);
  });
}