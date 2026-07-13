import { statSync, readFileSync } from 'fs';

const GROQ_MAX_FILE_SIZE_BYTES = 24 * 1024 * 1024; // 24MB, com margem de segurança (limite real: 25MB)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelay(errorText, fallbackMs = 5000) {
  const combined = errorText.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (combined) {
    const minutes = combined[1] ? parseInt(combined[1], 10) : 0;
    const seconds = parseFloat(combined[2]);
    return (minutes * 60 + seconds) * 1000 + 500;
  }
  return fallbackMs;
}

const HALLUCINATION_PATTERNS = [
  /^obrigado\.?$/i,
  /^e a[íi]\.?$/i,
  /^tchau\.?$/i,
  /^oi\.?$/i,
  /^ol[áa]\.?$/i,
  /legenda(do)? (por|pela)/i,
  /inscreva-se/i,
];

/**
 * Transcreve o arquivo MP3 comprimido (já fundido) via Groq e retorna os
 * segmentos brutos (start/end/text em segundos, relativos ao arquivo).
 *
 * Lança 'GROQ_FILE_TOO_LARGE' se mesmo comprimido o arquivo exceder 25MB
 * (sessões extremamente longas), e 'GROQ_RATE_LIMITED' se o rate limit
 * persistir - ambos sinalizam para o caller usar o Whisper local (no .wav).
 */
export async function transcribeMergedWithGroq(mp3Path, config, attempt = 1) {
  const MAX_QUICK_ATTEMPTS = 2;

  const fileSize = statSync(mp3Path).size;
  if (fileSize > GROQ_MAX_FILE_SIZE_BYTES) {
    throw new Error('GROQ_FILE_TOO_LARGE');
  }

  const fileBuffer = readFileSync(mp3Path);
  const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });

  const form = new FormData();
  form.append('file', blob, mp3Path.split(/[\\/]/).pop());
  form.append('model', config.groq.model);
  form.append('language', 'pt');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });

  if (response.status === 413) {
    throw new Error('GROQ_FILE_TOO_LARGE');
  }

  if (response.status === 429) {
    const errorText = await response.text();
    const delay = parseRetryDelay(errorText);

    if (attempt >= MAX_QUICK_ATTEMPTS || delay > 30000) {
      throw new Error('GROQ_RATE_LIMITED');
    }

    console.log(`⏳ Groq rate limit curto. Aguardando ${(delay / 1000).toFixed(1)}s...`);
    await sleep(delay);
    return transcribeMergedWithGroq(mp3Path, config, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Groq API retornou ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const segments = (data.segments ?? []).filter((s) => {
    if (s.no_speech_prob > 0.4) return false;
    if (s.avg_logprob < -1.0) return false;
    if (s.compression_ratio > 2.4) return false;
    const text = s.text.trim();
    return text.length >= 3 && !HALLUCINATION_PATTERNS.some((p) => p.test(text));
  });

  return segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
}