let currentFolder = null;
let pendingChannelId = null;
let isTranscribing = false;
let isNarrating = false;

const setupScreen = document.getElementById('setup-screen');
const mainScreen = document.getElementById('main-screen');

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
// Iniciar
// ============================================================

init();
