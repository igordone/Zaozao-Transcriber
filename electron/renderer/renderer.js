let currentFolder = null;
let pendingChannelId = null;
let isTranscribing = false;
let isNarrating = false;

let editingConfig = null;
let editingCharacters = null;

const setupScreen = document.getElementById('setup-screen');
const mainScreen = document.getElementById('main-screen');

const PROVIDER_TYPES = [
  { value: 'groq', label: 'Groq' },
  { value: '9router', label: '9Router' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama_cloud', label: 'Ollama Cloud' },
  { value: 'ollama_local', label: 'Ollama Local' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
];

const CHARACTER_ROLES = [
  { value: 'player', label: 'Jogador' },
  { value: 'master', label: 'Mestre' },
];

// ============================================================
// Utilitários
// ============================================================

function log(message) {
  const logBox = document.getElementById('log');
  logBox.textContent += message + '\n';
  logBox.scrollTop = logBox.scrollHeight;
}

function logTranscribe(message) {
  const logBox = document.getElementById('transcribe-log');
  logBox.style.display = 'block';
  logBox.textContent += message + '\n';
  logBox.scrollTop = logBox.scrollHeight;
}

function showScreen(screen) {
  setupScreen.classList.remove('active');
  mainScreen.classList.remove('active');
  screen.classList.add('active');
}

// ============================================================
// Tabs
// ============================================================

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.tab-content[data-tab="${tab.dataset.tab}"]`).classList.add('active');

    if (tab.dataset.tab === 'transcription') {
      loadSessionList();
    }
  });
});

// ============================================================
// Overlay de Configurações
// ============================================================

function openSettings() {
  document.getElementById('settings-overlay').classList.add('active');
  loadSettings();
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('active');
}

document.getElementById('btn-open-settings').addEventListener('click', openSettings);
document.getElementById('btn-close-settings').addEventListener('click', closeSettings);

// ============================================================
// Status de gravação
// ============================================================

function setStatus(state) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const btnStart = document.getElementById('btn-start');
  const btnPause = document.getElementById('btn-pause');
  const btnStop = document.getElementById('btn-stop');

  dot.className = 'status-dot';

  if (state === 'recording') {
    dot.classList.add('recording');
    text.textContent = 'Gravando';
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnPause.textContent = '⏸ Pausar';
    btnStop.disabled = false;
  } else if (state === 'paused') {
    dot.classList.add('paused');
    text.textContent = 'Pausado';
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnPause.textContent = '▶ Retomar';
    btnStop.disabled = false;
  } else {
    text.textContent = 'Parado';
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnStop.disabled = true;
  }
}

// ============================================================
// Inicialização
// ============================================================

async function init() {
  const hasCredentials = await window.api.hasCredentials();

  if (!hasCredentials) {
    showScreen(setupScreen);
    return;
  }

  showScreen(mainScreen);
  await connectToDiscord();

  // Listening para progresso de transcrição/narrativa
  window.api.onTranscribeProgress((progress) => {
    updateProgress('transcribe', progress);
    if (progress.message) logTranscribe(progress.message);
  });

  window.api.onNarrateProgress((progress) => {
    updateProgress('narrate', progress);
    if (progress.message) logTranscribe(progress.message);
  });

  window.api.onProcessLog((message) => logTranscribe(message));
}

async function connectToDiscord() {
  const subtitle = document.getElementById('connection-subtitle');
  const result = await window.api.connectBot();

  if (result.success) {
    if (result.alreadyConnected) {
      subtitle.textContent = 'Bot já estava conectado.';
    } else {
      subtitle.textContent = 'Conectado ao Discord';
    }
  } else {
    subtitle.textContent = `Falha ao conectar: ${result.error}`;
  }

  setStatus('idle');
}

// ============================================================
// Tela de configuração
// ============================================================

document.getElementById('btn-save-config').addEventListener('click', async () => {
  const data = {
    discordToken: document.getElementById('input-token').value.trim(),
    clientId: document.getElementById('input-client-id').value.trim(),
    guildId: document.getElementById('input-guild-id').value.trim(),
    groqApiKey: document.getElementById('input-groq-key').value.trim(),
  };

  if (!data.discordToken || !data.clientId || !data.guildId || !data.groqApiKey) {
    alert('Preencha todos os campos.');
    return;
  }

  await window.api.saveCredentials(data);
  showScreen(mainScreen);
  await connectToDiscord();
});

// ============================================================
// Gravação - Botão Iniciar
// ============================================================

document.getElementById('btn-start').addEventListener('click', async () => {
  const channelResult = await window.api.findActiveVoiceChannel();

  if (!channelResult.success || channelResult.channels.length === 0) {
    alert('Nenhum canal de voz com pessoas foi encontrado. Entre em um canal no Discord primeiro.');
    return;
  }

  if (channelResult.channels.length === 1) {
    pendingChannelId = channelResult.channels[0].id;
    await checkResumableAndStart();
  } else {
    showChannelPicker(channelResult.channels);
  }
});

function showChannelPicker(channels) {
  const listEl = document.getElementById('channel-list');
  listEl.innerHTML = '';

  channels.forEach((ch) => {
    const btn = document.createElement('button');
    btn.className = 'btn-secondary';
    btn.style.display = 'block';
    btn.style.width = '100%';
    btn.style.marginBottom = '6px';
    btn.textContent = `${ch.name} (${ch.memberCount} pessoa(s))`;
    btn.addEventListener('click', async () => {
      document.getElementById('modal-channel').classList.remove('active');
      pendingChannelId = ch.id;
      await checkResumableAndStart();
    });
    listEl.appendChild(btn);
  });

  document.getElementById('modal-channel').classList.add('active');
}

async function checkResumableAndStart() {
  const resumable = await window.api.checkResumable();

  if (resumable.resumable) {
    document.getElementById('modal-resume-text').textContent =
      `Encontrei uma sessão de ${resumable.ageMinutes} minuto(s) atrás. Isso foi uma pausa?`;
    document.getElementById('modal-resume').classList.add('active');
  } else {
    await beginRecording(false);
  }
}

document.getElementById('btn-modal-continue').addEventListener('click', async () => {
  document.getElementById('modal-resume').classList.remove('active');
  await beginRecording(true);
});

document.getElementById('btn-modal-new').addEventListener('click', async () => {
  document.getElementById('modal-resume').classList.remove('active');
  await beginRecording(false);
});

async function beginRecording(useExistingFolder) {
  const result = await window.api.startRecording({
    channelId: pendingChannelId,
    useExistingFolder,
  });

  if (result.success) {
    currentFolder = result.folder;
    log(`Gravação iniciada em: ${result.folder}`);
    setStatus('recording');
  } else {
    alert(`Erro ao iniciar: ${result.error}`);
  }
}

// ============================================================
// Gravação - Pausar/Retomar
// ============================================================

document.getElementById('btn-pause').addEventListener('click', async () => {
  const status = await window.api.recordingStatus();

  if (status.isPaused) {
    await window.api.resumeRecording();
    log('Gravação retomada.');
    setStatus('recording');
  } else {
    await window.api.pauseRecording();
    log('Gravação pausada.');
    setStatus('paused');
  }
});

// ============================================================
// Gravação - Parar
// ============================================================

document.getElementById('btn-stop').addEventListener('click', async () => {
  const result = await window.api.stopRecording();
  log(`Gravação encerrada: ${result.folder}`);
  setStatus('idle');
  currentFolder = null;
});

// ============================================================
// Aba: Transcrição & Narrativa
// ============================================================

async function loadSessionList() {
  const listEl = document.getElementById('session-list');
  listEl.innerHTML = '<div class="session-empty">Carregando sessões...</div>';

  const result = await window.api.listSessions();

  if (!result.success) {
    listEl.innerHTML = `<div class="session-empty">Erro ao carregar: ${result.error}</div>`;
    return;
  }

  if (result.sessions.length === 0) {
    listEl.innerHTML = '<div class="session-empty">Nenhuma sessão encontrada. Grave algo primeiro!</div>';
    return;
  }

  listEl.innerHTML = '';

  result.sessions.forEach((session) => {
    const card = document.createElement('div');
    card.className = 'session-card';

    const dateStr = new Date(session.createdAt).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const header = document.createElement('div');
    header.className = 'session-card-header';

    const name = document.createElement('div');
    name.className = 'session-name';
    name.textContent = `Sessão de ${dateStr}`;

    const badges = document.createElement('div');
    badges.className = 'session-badges';
    badges.innerHTML = `
      <span class="badge ${session.hasTranscription ? 'transcribed' : 'pending'}">${session.hasTranscription ? 'Transcrito' : 'Sem Transcrição'}</span>
      <span class="badge ${session.hasNarrative ? 'narrated' : 'pending'}">${session.hasNarrative ? 'Narrado' : 'Sem Narrativa'}</span>
    `;

    header.appendChild(name);
    header.appendChild(badges);
    card.appendChild(header);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    // Botão: Transcrever
    const btnTranscribe = document.createElement('button');
    btnTranscribe.className = 'btn-secondary btn-small';
    btnTranscribe.textContent = session.hasTranscription ? 'Re-transcrever' : 'Transcrever';
    btnTranscribe.addEventListener('click', () => startTranscription(session));
    actions.appendChild(btnTranscribe);

    // Botão: Narrar (só se já tem transcrição)
    const btnNarrate = document.createElement('button');
    btnNarrate.className = 'btn-secondary btn-small';
    btnNarrate.textContent = session.hasNarrative ? 'Re-narrar' : 'Narrar';
    btnNarrate.disabled = !session.hasTranscription;
    btnNarrate.addEventListener('click', () => startNarration(session));
    actions.appendChild(btnNarrate);

    // Botão: Abrir pasta
    const btnOpen = document.createElement('button');
    btnOpen.className = 'btn-secondary btn-small btn-open';
    btnOpen.textContent = 'Abrir pasta';
    btnOpen.addEventListener('click', () => window.api.openFolder(session.fullPath));
    actions.appendChild(btnOpen);

    card.appendChild(actions);
    card.dataset.sessionName = session.name;
    listEl.appendChild(card);
  });

  // Atualizar badges em tempo real após operações
  listEl._sessions = result.sessions;
}

async function refreshSessionStatus(session) {
  const status = await window.api.checkSessionStatus(session.fullPath);
  session.hasTranscription = status.hasTranscription;
  session.hasNarrative = status.hasNarrative;
  await loadSessionList();
}

// ============================================================
// Progresso visual
// ============================================================

function showProgress(type) {
  const section = document.getElementById('progress-section');
  const label = document.getElementById('progress-label');
  const bar = document.getElementById('progress-bar');

  section.classList.remove('hidden');
  bar.className = `progress-bar indeterminate ${type}`;
  bar.style.width = '';

  if (type === 'transcribe') {
    label.textContent = 'Transcrevendo áudios...';
  } else {
    label.textContent = 'Montando a narrativa...';
  }
}

function updateProgress(type, progress) {
  const label = document.getElementById('progress-label');
  const bar = document.getElementById('progress-bar');

  bar.className = `progress-bar ${type}`;

  if (progress.phase === 'transcribing' && progress.total > 0) {
    const pct = Math.round((progress.current / progress.total) * 100);
    bar.style.width = `${pct}%`;
    label.textContent = `Transcrevendo áudios (${progress.current}/${progress.total})`;
  } else if (progress.phase === 'condensing') {
    bar.classList.add('indeterminate');
    bar.style.width = '';
    label.textContent = 'Montando a narrativa...';
    if (progress.message) label.textContent = progress.message;
  } else if (progress.phase === 'done') {
    bar.style.width = '100%';
    bar.classList.remove('indeterminate');
    label.textContent = progress.message || 'Concluído!';
    setTimeout(() => {
      document.getElementById('progress-section').classList.add('hidden');
    }, 3000);
  } else {
    if (progress.message) label.textContent = progress.message;
  }
}

function hideProgress() {
  document.getElementById('progress-section').classList.add('hidden');
}

function setAllButtonsDisabled(disabled) {
  const cards = document.querySelectorAll('.session-card');
  cards.forEach((card) => {
    card.querySelectorAll('button:not(.btn-open)').forEach((btn) => {
      btn.disabled = disabled;
    });
  });
}

async function startTranscription(session) {
  if (isTranscribing || isNarrating) {
    alert('Já há um processamento em andamento. Aguarde concluir.');
    return;
  }

  isTranscribing = true;
  document.getElementById('transcribe-log').textContent = '';
  document.getElementById('transcribe-log').style.display = 'block';
  showProgress('transcribe');
  setAllButtonsDisabled(true);

  logTranscribe(`Iniciando transcrição de "${session.name}"...`);

  const result = await window.api.runTranscribe({ folder: session.fullPath });

  if (result.success) {
    logTranscribe('Transcrição concluída com sucesso!');
  } else {
    logTranscribe(`Erro na transcrição: ${result.error}`);
  }

  isTranscribing = false;
  setAllButtonsDisabled(false);
  await refreshSessionStatus(session);
}

async function startNarration(session) {
  if (isTranscribing || isNarrating) {
    alert('Já há um processamento em andamento. Aguarde concluir.');
    return;
  }

  isNarrating = true;
  document.getElementById('transcribe-log').textContent = '';
  document.getElementById('transcribe-log').style.display = 'block';
  showProgress('narrate');
  setAllButtonsDisabled(true);

  logTranscribe(`Iniciando narrativa de "${session.name}"...`);

  const result = await window.api.runNarrate({ folder: session.fullPath });

  if (result.success) {
    logTranscribe('Narrativa concluída com sucesso!');
  } else {
    logTranscribe(`Erro na narrativa: ${result.error}`);
  }

  isNarrating = false;
  setAllButtonsDisabled(false);
  await refreshSessionStatus(session);
}

// Refresh button
document.getElementById('btn-refresh-sessions').addEventListener('click', () => {
  loadSessionList();
});

// ============================================================
// Aba: Configurações
// ============================================================

async function loadSettings() {
  const config = await window.api.getConfig();
  const characters = await window.api.getCharacters();

  if (config.success === false) {
    console.error('Erro ao carregar config:', config.error);
    return;
  }
  if (characters.success === false) {
    console.error('Erro ao carregar characters:', characters.error);
    return;
  }

  editingConfig = config;
  editingCharacters = characters;

  renderProviderChain('narrative', 'provider-chain-list', 'narrative');
  renderProviderChain('transcription', 'transcription-chain-list', 'transcription');
  renderPrompts();
  renderCharactersTable();
}

const TRANSCRIPTION_TYPES = [
  { value: 'groq', label: 'Groq (Whisper)' },
  { value: 'local', label: 'Whisper Local' },
  { value: 'custom', label: 'Custom (OpenAI Whisper-compatible)' },
];

function renderProviderChain(section, listId, context) {
  const list = document.getElementById(listId);
  list.innerHTML = '';

  const chain = editingConfig[section]?.chain;
  if (!chain || !Array.isArray(chain) || chain.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'subtitle';
    empty.textContent = 'Nenhum provedor configurado. Adicione o primeiro.';
    list.appendChild(empty);
    return;
  }

  const types = context === 'transcription' ? TRANSCRIPTION_TYPES : PROVIDER_TYPES;

  chain.forEach((provider, index) => {
    const item = document.createElement('div');
    item.className = 'provider-chain-item';

    const header = document.createElement('div');
    header.className = 'provider-chain-item-header';

    const modelGroup = document.createElement('div');
    modelGroup.className = 'provider-field-group';
    modelGroup.innerHTML = '<label>Modelo</label>';
    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.value = provider.model || '';
    modelInput.placeholder = provider.type === 'local' && context === 'transcription'
      ? 'ex: small, medium, large'
      : context === 'transcription'
        ? 'ex: whisper-large-v3-turbo'
        : 'ex: llama-3.1-8b-instant';
    modelInput.addEventListener('input', () => updateProviderField(section, index, 'model', modelInput.value));
    modelGroup.appendChild(modelInput);
    header.appendChild(modelGroup);

    const moveBtns = document.createElement('div');
    moveBtns.className = 'chain-move-btns';

    const btnUp = document.createElement('button');
    btnUp.textContent = '▲';
    btnUp.title = 'Mover para cima';
    btnUp.disabled = index === 0;
    btnUp.addEventListener('click', () => moveProvider(section, index, -1));

    const btnDown = document.createElement('button');
    btnDown.textContent = '▼';
    btnDown.title = 'Mover para baixo';
    btnDown.disabled = index === chain.length - 1;
    btnDown.addEventListener('click', () => moveProvider(section, index, 1));

    moveBtns.appendChild(btnUp);
    moveBtns.appendChild(btnDown);

    const btnRemove = document.createElement('button');
    btnRemove.className = 'btn-remove-provider';
    btnRemove.textContent = '✕';
    btnRemove.title = 'Remover provedor';
    btnRemove.addEventListener('click', () => removeProvider(section, index));

    header.appendChild(moveBtns);
    header.appendChild(btnRemove);

    const fields = document.createElement('div');
    fields.className = 'provider-row-fields';

    const rowTop = document.createElement('div');
    rowTop.className = 'provider-row-top';

    const rowBottom = document.createElement('div');
    rowBottom.className = 'provider-row-bottom';

    const rowLast = document.createElement('div');
    rowLast.className = 'provider-row-last';

    const typeGroup = document.createElement('div');
    typeGroup.className = 'provider-field-group';
    typeGroup.innerHTML = '<label>Tipo</label>';
    const typeSelect = document.createElement('select');
    types.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === provider.type) o.selected = true;
      typeSelect.appendChild(o);
    });
    typeSelect.addEventListener('change', () => {
      updateProviderField(section, index, 'type', typeSelect.value);
      const placeholder = typeSelect.value === 'local' && context === 'transcription'
        ? 'ex: small, medium, large'
        : context === 'transcription'
          ? 'ex: whisper-large-v3-turbo'
          : 'ex: llama-3.1-8b-instant';
      modelInput.placeholder = placeholder;
      urlInput.disabled = typeSelect.value === 'local' && context === 'transcription';
      urlInput.placeholder = typeSelect.value === 'local' && context === 'transcription'
        ? '(não usa URL)'
        : 'Ex: http://localhost:1234/v1';
    });
    typeGroup.appendChild(typeSelect);
    rowTop.appendChild(typeGroup);

    const keyGroup = document.createElement('div');
    keyGroup.className = 'provider-field-group';
    keyGroup.innerHTML = '<label>Chave de API</label>';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.value = provider.api_key || '';
    keyInput.placeholder = '(vazio se não usar auth)';
    keyInput.addEventListener('input', () => updateProviderField(section, index, 'api_key', keyInput.value));
    keyGroup.appendChild(keyInput);
    rowTop.appendChild(keyGroup);

    const urlGroup = document.createElement('div');
    urlGroup.className = 'provider-field-group';
    urlGroup.innerHTML = '<label>Base URL</label>';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = provider.base_url || '';
    urlInput.placeholder = provider.type === 'local' && context === 'transcription'
      ? '(não usa URL)'
      : 'Ex: http://localhost:1234/v1';
    urlInput.disabled = provider.type === 'local' && context === 'transcription';
    urlInput.addEventListener('input', () => updateProviderField(section, index, 'base_url', urlInput.value));
    urlGroup.appendChild(urlInput);
    rowLast.appendChild(urlGroup);

    fields.appendChild(rowTop);
    fields.appendChild(rowLast);

    item.appendChild(header);
    item.appendChild(fields);
    list.appendChild(item);
  });
}

function ensureChain(section) {
  if (!editingConfig) return;
  if (!editingConfig[section]) editingConfig[section] = {};
  if (!editingConfig[section].chain) editingConfig[section].chain = [];
}

document.getElementById('btn-add-provider').addEventListener('click', () => {
  ensureChain('narrative');
  editingConfig.narrative.chain.push({
    type: 'custom',
    model: '',
    api_key: '',
    base_url: '',
  });
  renderProviderChain('narrative', 'provider-chain-list', 'narrative');
});

document.getElementById('btn-add-transcription-provider').addEventListener('click', () => {
  ensureChain('transcription');
  editingConfig.transcription.chain.push({
    type: 'custom',
    model: '',
    api_key: '',
    base_url: '',
  });
  renderProviderChain('transcription', 'transcription-chain-list', 'transcription');
});

function updateProviderField(section, index, prop, value) {
  if (editingConfig[section].chain[index]) {
    editingConfig[section].chain[index][prop] = value;
  }
}

function moveProvider(section, index, direction) {
  const chain = editingConfig[section].chain;
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= chain.length) return;
  [chain[index], chain[newIndex]] = [chain[newIndex], chain[index]];
  renderProviderChain(section, section === 'narrative' ? 'provider-chain-list' : 'transcription-chain-list', section);
}

function removeProvider(section, index) {
  editingConfig[section].chain.splice(index, 1);
  renderProviderChain(section, section === 'narrative' ? 'provider-chain-list' : 'transcription-chain-list', section);
}

function renderPrompts() {
  const narrative = editingConfig.narrative || {};
  document.getElementById('settings-condense-prompt').value = narrative.condense_prompt || '';
  document.getElementById('settings-final-prompt').value = narrative.final_prompt || '';
}

function renderCharactersTable() {
  const tbody = document.getElementById('characters-tbody');
  tbody.innerHTML = '';

  const entries = Object.entries(editingCharacters);
  entries.forEach(([discordId, char]) => {
    const row = document.createElement('tr');

    const idCell = document.createElement('td');
    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.value = discordId;
    idInput.placeholder = 'ID do Discord';
    idInput.dataset.originalId = discordId;
    idInput.dataset.prop = 'discordId';
    idInput.addEventListener('change', () => {
      const oldId = idInput.dataset.originalId;
      const newId = idInput.value.trim();
      if (newId && newId !== oldId) {
        editingCharacters[newId] = editingCharacters[oldId];
        delete editingCharacters[oldId];
        idInput.dataset.originalId = newId;
      }
    });
    idCell.appendChild(idInput);

    const nameCell = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = char.name || '';
    nameInput.placeholder = 'Nome do personagem';
    nameInput.addEventListener('change', () => {
      if (editingCharacters[discordId]) {
        editingCharacters[discordId].name = nameInput.value;
      }
    });
    nameCell.appendChild(nameInput);

    const roleCell = document.createElement('td');
    const roleSelect = document.createElement('select');
    CHARACTER_ROLES.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === char.role) o.selected = true;
      roleSelect.appendChild(o);
    });
    roleSelect.addEventListener('change', () => {
      if (editingCharacters[discordId]) {
        editingCharacters[discordId].role = roleSelect.value;
      }
    });
    roleCell.appendChild(roleSelect);

    const actionsCell = document.createElement('td');
    const btnRemove = document.createElement('button');
    btnRemove.className = 'btn-remove-char';
    btnRemove.textContent = '✕';
    btnRemove.title = 'Remover personagem';
    btnRemove.addEventListener('click', () => {
      delete editingCharacters[discordId];
      renderCharactersTable();
    });
    actionsCell.appendChild(btnRemove);

    row.append(idCell, nameCell, roleCell, actionsCell);
    tbody.appendChild(row);
  });
}

document.getElementById('btn-add-character').addEventListener('click', () => {
  const newId = 'new-' + Date.now();
  editingCharacters[newId] = { name: '', role: 'player' };
  renderCharactersTable();
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const narrative = editingConfig.narrative || {};

  narrative.condense_prompt = document.getElementById('settings-condense-prompt').value;
  narrative.final_prompt = document.getElementById('settings-final-prompt').value;

  const cleanedCharacters = {};
  for (const [id, char] of Object.entries(editingCharacters)) {
    if (id.startsWith('new-')) continue;
    if (!char.name && !char.role) continue;
    cleanedCharacters[id] = { name: char.name || '', role: char.role || 'player' };
  }

  const configResult = await window.api.saveConfig(editingConfig);
  const charResult = await window.api.saveCharacters(cleanedCharacters);

  const feedback = document.getElementById('settings-save-feedback');

  if (configResult.success && charResult.success) {
    feedback.className = 'settings-feedback success';
    feedback.textContent = 'Configurações salvas com sucesso!';
    editingCharacters = cleanedCharacters;
    setTimeout(() => { feedback.textContent = ''; }, 3000);
  } else {
    feedback.className = 'settings-feedback error';
    feedback.textContent = 'Erro ao salvar: ' + (configResult.error || charResult.error);
  }
});

document.getElementById('btn-reload-settings').addEventListener('click', () => {
  loadSettings();
});

// ============================================================
// Iniciar
// ============================================================

init();
