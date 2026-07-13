const CHUNK_SIZE_CHARS = 6000;

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

/**
 * Tenta a Groq com poucas re-tentativas curtas (só pra falhas passageiras).
 * Se persistir (rate limit real, diário ou não), sinaliza pra cair no fallback.
 */
async function tryGroqChat(systemPrompt, userContent, config, attempt = 1) {
  const MAX_QUICK_ATTEMPTS = 2; // tentativas curtas antes de desistir e cair no local

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.groq.model,
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

    if (attempt >= MAX_QUICK_ATTEMPTS) {
      throw new Error('GROQ_RATE_LIMITED'); // sinal específico pro caller decidir usar fallback
    }

    const delay = parseRetryDelay(errorText);
    // Só vale esperar automaticamente se for uma espera curta (< 30s).
    // Esperas longas (rate limit diário) não compensam - cai direto pro local.
    if (delay > 30000) {
      throw new Error('GROQ_RATE_LIMITED');
    }

    console.log(`⏳ Groq rate limit curto. Aguardando ${(delay / 1000).toFixed(1)}s...`);
    await sleep(delay);
    return tryGroqChat(systemPrompt, userContent, config, attempt + 1);
  }

  if (!response.ok) throw new Error(`Groq retornou ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

async function callOllamaChat(systemPrompt, userContent, config) {
  const response = await fetch(`${config.ollama.base_url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) throw new Error(`Ollama retornou ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

async function callOllamaModel(systemPrompt, userContent, ollamaConfig) {
  const response = await fetch(`${ollamaConfig.base_url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
    }),
  });

  if (!response.ok) throw new Error(`Ollama (${ollamaConfig.model}) retornou ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

async function callProvider(systemPrompt, userContent, config) {
  if (config.provider === 'ollama') {
    return callOllamaModel(systemPrompt, userContent, config.ollama);
  }

  if (config.provider === 'fallback') {
    // Nível 1: Groq
    try {
      return await tryGroqChat(systemPrompt, userContent, config);
    } catch (err) {
      if (err.message !== 'GROQ_RATE_LIMITED') throw err;
    }

    // Nível 2: Ollama Cloud (gemma4:cloud - grátis, roda nos servidores da Ollama)
    console.log('🔀 Groq indisponível — tentando modelo em nuvem (Ollama Cloud)...');
    try {
      return await callOllamaModel(systemPrompt, userContent, config.ollama_cloud);
    } catch (err) {
      console.log(`🔀 Ollama Cloud indisponível (${err.message}) — usando modelo local...`);
    }

    // Nível 3: Ollama local (llama3.1 - sem limite, mas mais lento)
    return callOllamaModel(systemPrompt, userContent, config.ollama);
  }

  return tryGroqChat(systemPrompt, userContent, config);
}

async function condenseChunks(chunks, config, onProgress) {
  const summaries = [];

  for (const [index, chunk] of chunks.entries()) {
    console.log(`📝 Condensando pedaço ${index + 1}/${chunks.length}...`);
    try {
      const summary = await callProvider(config.condense_prompt, chunk, config);
      summaries.push(removeDuplicateLines(summary.trim()));
    } catch (err) {
      console.error(`❌ Erro ao condensar pedaço ${index + 1}:`, err.message);
      summaries.push('');
    }
    if (onProgress) onProgress(summaries.filter(Boolean).join('\n\n---\n\n'));
  }

  return summaries.filter(Boolean);
}

async function composeFinalNarrative(summaries, config) {
  const combined = summaries.map((s, i) => `[Trecho ${i + 1}]\n${s}`).join('\n\n');
  console.log('📖 Compondo narrativa final a partir de todos os resumos...');
  return callProvider(config.final_prompt, combined, config);
}

export async function generateNarrative(transcript, config, onProgress) {
  const chunks = splitIntoChunks(transcript, CHUNK_SIZE_CHARS);
  console.log(`📚 Transcrição dividida em ${chunks.length} pedaço(s) para condensação.`);

  const summaries = await condenseChunks(chunks, config, onProgress);

  if (summaries.length === 0) {
    return '⚠️ Não foi possível gerar a narrativa: nenhum resumo válido foi produzido.';
  }

  const finalNarrative = await composeFinalNarrative(summaries, config);
  return finalNarrative.trim();
}