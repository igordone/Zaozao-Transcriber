const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Configuração
  hasCredentials: () => ipcRenderer.invoke('config:has-credentials'),
  saveCredentials: (data) => ipcRenderer.invoke('config:save-credentials', data),

  // Bot / Discord
  connectBot: () => ipcRenderer.invoke('bot:connect'),
  findActiveVoiceChannel: () => ipcRenderer.invoke('bot:find-active-voice-channel'),

  // Gravação
  checkResumable: () => ipcRenderer.invoke('recording:check-resumable'),
  startRecording: (data) => ipcRenderer.invoke('recording:start', data),
  pauseRecording: () => ipcRenderer.invoke('recording:pause'),
  resumeRecording: () => ipcRenderer.invoke('recording:resume'),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  recordingStatus: () => ipcRenderer.invoke('recording:status'),

  // Processamento
  runTranscribe: (data) => ipcRenderer.invoke('process:transcribe', data),
  runNarrate: (data) => ipcRenderer.invoke('process:narrate', data),
  onProcessLog: (callback) => ipcRenderer.on('process:log', (_event, message) => callback(message)),
  onTranscribeProgress: (callback) => ipcRenderer.on('transcribe:progress', (_event, progress) => callback(progress)),
  onNarrateProgress: (callback) => ipcRenderer.on('narrate:progress', (_event, progress) => callback(progress)),

  // Sessões
  listSessions: () => ipcRenderer.invoke('session:list'),
  checkSessionStatus: (folder) => ipcRenderer.invoke('session:check-status', { folder }),

  // Utilitário
  openFolder: (path) => ipcRenderer.invoke('shell:open-folder', path),
});
