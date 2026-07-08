import "dotenv/config";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const NO_SPEECH_THRESHOLD = 0.5;

// Espaçamento mínimo entre requisições, pra não estourar o limite de RPM.
// Free tier = 20 req/min → 1 a cada 3s é seguro (20 * 3s = 60s)
const MIN_DELAY_BETWEEN_REQUESTS_MS = 3100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCharacterMap() {
  const path = join(__dirname, "characters.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function parseFilename(filename) {
  const match = filename.match(/^(\d+)-(\d+)\.wav$/);
  if (!match) return null;
  return { userId: match[1], timestamp: Number(match[2]) };
}

/**
 * Extrai o número de segundos sugerido pela mensagem de erro da Groq,
 * ex: "Please try again in 3s" → 3000ms. Se não encontrar, usa um padrão.
 */
function parseRetryDelay(errorText, fallbackMs = 5000) {
  const match = errorText.match(/try again in ([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500; // +500ms de margem
  return fallbackMs;
}

async function transcribeFile(filePath, attempt = 1) {
  const fileBuffer = readFileSync(filePath);
  const blob = new Blob([fileBuffer], { type: "audio/wav" });

  const form = new FormData();
  form.append("file", blob, basename(filePath));
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "pt");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });

  if (response.status === 429) {
    const errorText = await response.text();
    const delay = parseRetryDelay(errorText);
    console.log(
      `⏳ Rate limit atingido. Aguardando ${(delay / 1000).toFixed(1)}s (tentativa ${attempt})...`,
    );
    await sleep(delay);
    return transcribeFile(filePath, attempt + 1); // tenta de novo, recursivamente
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API retornou ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const segments = data.segments ?? [];

  const validSegments = segments.filter((s) => {
    // Filtro combinado: três sinais que juntos indicam alucinação com mais confiança
    if (s.no_speech_prob > 0.4) return false;
    if (s.avg_logprob < -1.0) return false; // confiança baixa do modelo no texto gerado
    if (s.compression_ratio > 2.4) return false; // texto repetitivo/sem sentido

    // Lista negra de frases clássicas de alucinação do Whisper em PT-BR
    const hallucinations = [
      /obrigado\.?$/i,
      /legenda(do)? (por|pela)/i,
      /legendas? (pela|da) comunidade/i,
      /inscreva-se/i,
      /amara\.org/i,
    ];
    const isHallucination = hallucinations.some((pattern) =>
      pattern.test(s.text.trim()),
    );
    if (isHallucination) return false;

    return true;
  });

  if (validSegments.length === 0) return "";
  return validSegments
    .map((s) => s.text.trim())
    .join(" ")
    .trim();
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("pt-BR", { hour12: false });
}

/**
 * Monta o markdown narrativo a partir das entries já transcritas até agora.
 */
function buildMarkdown(entries, characterMap, sessionFolder) {
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);

  const blocks = [];
  for (const entry of sorted) {
    const character = characterMap[entry.userId];
    const displayName = character?.name ?? `Usuário ${entry.userId}`;
    const isMaster = character?.role === "master";

    const last = blocks[blocks.length - 1];
    if (last && last.userId === entry.userId) {
      last.text += " " + entry.text;
    } else {
      blocks.push({
        userId: entry.userId,
        displayName,
        isMaster,
        timestamp: entry.timestamp,
        text: entry.text,
      });
    }
  }

  const lines = blocks.map((b) => {
    const time = formatTime(b.timestamp);
    return b.isMaster
      ? `> *[${time}]* **${b.displayName} (Master):** ${b.text}`
      : `**${b.displayName}:** ${b.text}`;
  });

  const header = `# Sessão de RPG — ${basename(sessionFolder)}\n\n---\n\n`;
  return header + lines.join("\n\n");
}

export async function transcribeSession(sessionFolder) {
  const characterMap = loadCharacterMap();
  const files = readdirSync(sessionFolder).filter((f) => f.endsWith(".wav"));

  if (files.length === 0) {
    console.log("⚠️ Nenhum arquivo .wav encontrado nessa pasta.");
    return;
  }

  console.log(
    `🔎 Encontrados ${files.length} arquivos. Iniciando transcrição...`,
  );

  const entries = [];
  const outputPath = join(sessionFolder, "transcricao.md");

  for (const file of files) {
    const parsed = parseFilename(file);
    if (!parsed) {
      console.log(`⏭️ Ignorando arquivo com nome inesperado: ${file}`);
      continue;
    }

    const filePath = join(sessionFolder, file);
    console.log(`🎧 Transcrevendo: ${file}...`);

    try {
      const text = await transcribeFile(filePath);
      if (text) {
        entries.push({ ...parsed, text });
        console.log(
          `✅ OK: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`,
        );
      } else {
        console.log(`⏭️ Trecho descartado (silêncio/ruído): ${file}`);
      }
    } catch (err) {
      console.error(`❌ Erro ao transcrever ${file}:`, err.message);
      console.log("↪️ Continuando com os próximos arquivos...");
    }

    // Salva o progresso a cada arquivo processado — nunca mais perde tudo
    writeFileSync(
      outputPath,
      buildMarkdown(entries, characterMap, sessionFolder),
      "utf-8",
    );

    // Respeita o limite de requisições por minuto
    await sleep(MIN_DELAY_BETWEEN_REQUESTS_MS);
  }

  console.log(`\n📄 Transcrição narrativa salva em: ${outputPath}`);
}

if (process.argv[1] && process.argv[1].endsWith("transcribe.js")) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Uso: node src/transcribe.js "caminho/da/pasta/da/sessao"');
    process.exit(1);
  }
  transcribeSession(folder).catch((err) => {
    console.error("❌ Erro geral na transcrição:", err);
    process.exit(1);
  });
}
