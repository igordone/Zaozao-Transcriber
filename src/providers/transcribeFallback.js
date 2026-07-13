import { transcribeMergedWithGroq } from './transcribeGroq.js';
import { transcribeMergedWithLocalWhisper } from './transcribeLocal.js';

/**
 * Tenta a Groq (usando o .mp3 comprimido) primeiro; cai automaticamente
 * para o Whisper local (usando o .wav original, sem compressão) quando:
 * - o rate limit da Groq persiste
 * - o arquivo excede o limite de tamanho da Groq mesmo comprimido
 *
 * Recebe um objeto { wavPath, mp3Path } em vez de um único filePath, pois
 * cada provedor precisa de um formato diferente.
 */
export async function transcribeMergedWithFallback({ wavPath, mp3Path }, config) {
  try {
    return await transcribeMergedWithGroq(mp3Path, config);
  } catch (err) {
    if (err.message === 'GROQ_RATE_LIMITED') {
      console.log('🔀 Groq indisponível (rate limit) — usando Whisper local para este arquivo...');
      return transcribeMergedWithLocalWhisper(wavPath, config);
    }

    if (err.message === 'GROQ_FILE_TOO_LARGE') {
      console.log('🔀 Arquivo grande demais mesmo comprimido — usando Whisper local...');
      return transcribeMergedWithLocalWhisper(wavPath, config);
    }

    throw err;
  }
}