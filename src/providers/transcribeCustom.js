import { statSync, readFileSync } from 'fs';

const MAX_FILE_SIZE_BYTES = 24 * 1024 * 1024;

const HALLUCINATION_PATTERNS = [
  /^obrigado\.?$/i,
  /^e a[íi]\.?$/i,
  /^tchau\.?$/i,
  /^oi\.?$/i,
  /^ol[áa]\.?$/i,
  /legenda(do)? (por|pela)/i,
  /inscreva-se/i,
];

export async function transcribeMergedWithCustomWhisper(mp3Path, provider) {
  const baseUrl = (provider.base_url || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('Base URL é obrigatória para Whisper customizado.');

  const fileSize = statSync(mp3Path).size;
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    throw new Error('CUSTOM_WHISPER_FILE_TOO_LARGE');
  }

  const fileBuffer = readFileSync(mp3Path);
  const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });

  const form = new FormData();
  form.append('file', blob, mp3Path.split(/[\\/]/).pop());
  form.append('model', provider.model || 'whisper-1');
  form.append('language', 'pt');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');

  const headers = {};
  if (provider.api_key) {
    headers.Authorization = `Bearer ${provider.api_key}`;
  }

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!response.ok) {
    throw new Error(`${provider.name || 'Custom Whisper'} retornou ${response.status}: ${await response.text()}`);
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
