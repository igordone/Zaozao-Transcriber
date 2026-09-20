const CHUNK_SIZE_CHARS = 6000;
let groqCooldownUntil = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitIntoChunks(markdown, maxChars) {
  const blocks = markdown.split(/\n\n+/).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const block of blocks) {
    if ((current + '\n\n' + block).length > maxChars && current) {
      chunks.push(current.trim());
      current = block;
    } else {
      current = current ? current + '\n\n' + block : block;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

function parseRetryDelay(errorText, fallbackMs = 10000) {
  const combined = errorText.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  if (combined) {
    const minutes = combined[1] ? parseInt(combined[1], 10) : 0;
    const seconds = parseFloat(combined[2]);
    return (minutes * 60 + seconds) * 1000 + 500;
  }
  return fallbackMs;
}

function removeDuplicateLines(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];

  for (const line of lines) {
    const normalized = line.toLowerCase().replace(/[^\wà-ú\s]/gi, '');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(line);
    }
  }

  return unique.join('\n');
}

// ============================================================
// Chamadas por tipo de provedor
// ============================================================

async function callGroq(systemPrompt, userContent, provider, attempt = 1) {
  const MAX_QUICK_ATTEMPTS = 2;

  if (Date.now() < groqCooldownUntil) {
    throw new Error('GROQ_RATE_LIMITED');
  }

  const baseUrl = (provider.base_url || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const apiKey = provider.api_key || process.env.GROQ_API_KEY;
  const model = provider.model || 'llama-3.1-8b-instant';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
      frequency_penalty: 0.5,
      max_tokens: 800,
    }),
  });

  if (response.status === 429) {
    const errorText = await response.text();
    const delay = parseRetryDelay(errorText);

    if (attempt >= MAX_QUICK_ATTEMPTS || delay > 30000) {
      groqCooldownUntil = Date.now() + Math.min(delay, 120000);
      throw new Error('GROQ_RATE_LIMITED');
    }

    console.log(`⏳ Rate limit. Aguardando ${(delay / 1000).toFixed(1)}s...`);
    await sleep(delay);
    return callGroq(systemPrompt, userContent, provider, attempt + 1);
  }

  if (response.status === 413) {
    throw new Error('GROQ_RATE_LIMITED');
  }

  if (!response.ok) throw new Error(`Groq retornou ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

async function callOpenRouter(systemPrompt, userContent, provider) {
  const baseUrl = provider.base_url || 'https://openrouter.ai/api/v1';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) throw new Error(`OpenRouter retornou ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

async function callOllama(systemPrompt, userContent, provider) {
  const baseUrl = provider.base_url || 'http://localhost:11434/v1';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) throw new Error(`Ollama (${provider.model}) retornou ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

async function call9Router(systemPrompt, userContent, provider) {
  const baseUrl = provider.base_url || 'http://localhost:20128/v1';
  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) {
    headers.Authorization = `Bearer ${provider.api_key}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.4,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`9Router retornou ${response.status}: ${await response.text()}`);
    const text = await response.text();
    const jsonText = text.replace(/^data: \[DONE\].*/s, '').trim();
    const data = JSON.parse(jsonText);
    return data.choices[0].message.content;
  } finally {
    clearTimeout(timeout);
  }
}

async function callCustom(systemPrompt, userContent, provider) {
  const baseUrl = (provider.base_url || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('Base URL é obrigatória para provedores customizados.');

  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) {
    headers.Authorization = `Bearer ${provider.api_key}`;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model || '',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) throw new Error(`${provider.name || 'Custom'} retornou ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

async function callSingleProvider(systemPrompt, userContent, provider) {
  switch (provider.type) {
    case 'groq':
      return callGroq(systemPrompt, userContent, provider);
    case '9router':
      return call9Router(systemPrompt, userContent, provider);
    case 'openrouter':
      return callOpenRouter(systemPrompt, userContent, provider);
    case 'ollama':
    case 'ollama_cloud':
    case 'ollama_local':
      return callOllama(systemPrompt, userContent, provider);
    case 'custom':
      return callCustom(systemPrompt, userContent, provider);
    default:
      throw new Error(`Tipo de provedor desconhecido: ${provider.type}`);
  }
}

// ============================================================
// Resolve a cadeia de provedores (formato novo ou legado)
// ============================================================

function resolveChain(config) {
  if (config.chain && Array.isArray(config.chain) && config.chain.length > 0) {
    return config.chain;
  }

  // Compatibilidade com o formato legado (provider + groq/ollama_cloud/ollama)
  if (config.provider === 'ollama' && config.ollama) {
    return [{ type: 'ollama_local', ...config.ollama }];
  }

  if (config.provider === 'fallback' || !config.provider) {
    const chain = [];
    if (config.groq) chain.push({ type: 'groq', ...config.groq });
    if (config.ollama_cloud) chain.push({ type: 'ollama_cloud', ...config.ollama_cloud });
    if (config.ollama) chain.push({ type: 'ollama_local', ...config.ollama });
    return chain;
  }

  if (config.provider === 'groq' && config.groq) {
    return [{ type: 'groq', ...config.groq }];
  }

  return [];
}

async function callProvider(systemPrompt, userContent, config) {
  const chain = resolveChain(config);

  if (chain.length === 0) {
    throw new Error('Nenhum provedor de narrativa configurado.');
  }

  let lastError;

  for (const [index, provider] of chain.entries()) {
    const label = provider.name || (provider.type === 'ollama_local' ? 'Ollama local' :
                  provider.type === 'ollama_cloud' ? 'Ollama Cloud' :
                  provider.type === 'openrouter' ? 'OpenRouter' :
                  provider.type === '9router' ? '9Router' :
                  provider.type === 'custom' ? (provider.base_url || 'Custom') :
                  provider.type);

    try {
      return await callSingleProvider(systemPrompt, userContent, provider);
    } catch (err) {
      lastError = err;
      const isLast = index === chain.length - 1;
      if (!isLast) {
        console.log(`\u23AF\u23AF ${label} indispon\u00EDvel (${err.message}) \u2014 tentando pr\u00F3ximo provedor...`);
      }
    }
  }

  throw lastError || new Error('Todos os provedores falharam.');
}

async function condenseChunks(chunks, config, onProgress) {
  const summaries = [];

  for (const [index, chunk] of chunks.entries()) {
    console.log(`\uD83D\uDcdd Condensando peda\u00E7o ${index + 1}/${chunks.length}...`);
    try {
      const summary = await callProvider(config.condense_prompt, chunk, config);
      summaries.push(removeDuplicateLines(summary.trim()));
    } catch (err) {
      console.error(`\u274C Erro ao condensar peda\u00E7o ${index + 1}:`, err.message);
      summaries.push('');
    }
    if (onProgress) onProgress(summaries.filter(Boolean).join('\n\n---\n\n'));
  }

  return summaries.filter(Boolean);
}

async function composeFinalNarrative(summaries, config) {
  const combined = summaries.map((s, i) => `[Trecho ${i + 1}]\n${s}`).join('\n\n');
  console.log('\uD83D\uDCD6 Compondo narrativa final a partir de todos os resumos...');
  return callProvider(config.final_prompt, combined, config);
}

export async function generateNarrative(transcript, config, onProgress) {
  const chunks = splitIntoChunks(transcript, CHUNK_SIZE_CHARS);
  console.log(`\uD83D\uDDC2 Transcri\u00E7\u00E3o dividida em ${chunks.length} peda\u00E7o(s) para condensa\u00E7\u00E3o.`);

  const summaries = await condenseChunks(chunks, config, onProgress);

  if (summaries.length === 0) {
    return '\u26A0\uFE0F N\u00E3o foi poss\u00EDvel gerar a narrativa: nenhum resumo v\u00E1lido foi produzido.';
  }

  const finalNarrative = await composeFinalNarrative(summaries, config);
  return finalNarrative.trim();
}
