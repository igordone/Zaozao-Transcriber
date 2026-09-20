import { transcribeMergedWithGroq } from './transcribeGroq.js';
import { transcribeMergedWithLocalWhisper } from './transcribeLocal.js';
import { transcribeMergedWithCustomWhisper } from './transcribeCustom.js';

function resolveChain(config) {
  const chain = config?.chain;
  if (Array.isArray(chain) && chain.length > 0) return chain;
  return [];
}

export async function transcribeMergedWithFallback({ wavPath, mp3Path }, config) {
  const chain = resolveChain(config);

  if (chain.length === 0) {
    try {
      return await transcribeMergedWithGroq(mp3Path, config);
    } catch (err) {
      if (err.message === 'GROQ_RATE_LIMITED' || err.message === 'GROQ_FILE_TOO_LARGE') {
        console.log('🔀 Groq indisponível — usando Whisper local...');
        return transcribeMergedWithLocalWhisper(wavPath, config);
      }
      throw err;
    }
  }

  let lastError;
  for (const provider of chain) {
    const label = provider.name || provider.type;
    try {
      if (provider.type === 'groq') {
        return await transcribeMergedWithGroq(mp3Path, { provider });
      }
      if (provider.type === 'local') {
        return await transcribeMergedWithLocalWhisper(wavPath, { local: provider });
      }
      if (provider.type === 'custom') {
        return await transcribeMergedWithCustomWhisper(mp3Path, provider);
      }
      throw new Error(`Tipo de transcrição desconhecido: ${provider.type}`);
    } catch (err) {
      lastError = err;
      console.log(`🔀 ${label} indisponível (${err.message}) — tentando próximo...`);
    }
  }

  console.log('🔀 Todos os provedores de transcrição falharam — usando Whisper local como último recurso...');
  try {
    return await transcribeMergedWithLocalWhisper(wavPath, config);
  } catch (localErr) {
    throw lastError || localErr;
  }
}
