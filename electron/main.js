import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, readdirSync, statSync } from 'fs';
import { spawn } from 'child_process';

import { transcribeAudio, generateSessionNarrative } from '../src/transcribe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
const BOT_SERVER_URL = 'http://localhost:4741';

let mainWindow;
let botProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startBotProcess() {
  return new Promise((resolve, reject) => {
    const projectRoot = join(__dirname, '..');
    botProcess = spawn('node', ['src/botServer.js'], {
      cwd: projectRoot,
      shell: false,
    });

    botProcess.stdout.on('data', (data) => {
      const text = data.toString();
      console.log('[bot]', text.trim());
      sendToRenderer('process:log', text.trim());

      if (text.includes('Servidor de controle do bot rodando')) {
        resolve();
      }
    });

    botProcess.stderr.on('data', (data) => {
      console.error('[bot erro]', data.toString().trim());
    });

    botProcess.on('exit', (code) => {
      console.log(`Processo do bot encerrado (código ${code})`);
      botProcess = null;
    });

    setTimeout(() => reject(new Error('Timeout esperando o bot iniciar.')), 15000);
  });
}

async function botFetch(path, options = {}) {
  const response = await fetch(`${BOT_SERVER_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return response.json();
}

ipcMain.handle('config:has-credentials', () => {
  return existsSync(envPath);
});

ipcMain.handle('config:save-credentials', async (_event, { discordToken, clientId, guildId, groqApiKey }) => {
  const content = [
    `DISCORD_TOKEN=${discordToken}`,
    `CLIENT_ID=${clientId}`,
    `GUILD_ID=${guildId}`,
    `GROQ_API_KEY=${groqApiKey}`,
  ].join('\n');

  writeFileSync(envPath, content, 'utf-8');
  return { success: true };
});

// ---------- Bot / conexão com o Discord ----------

ipcMain.handle('bot:connect', async () => {
  try {
    if (!botProcess) {
      await startBotProcess();
    }
    return botFetch('/connect', { method: 'POST' });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('bot:find-active-voice-channel', async () => {
  return botFetch('/active-voice-channels');
});

// ---------- Controle de gravação ----------

ipcMain.handle('recording:check-resumable', async () => {
  return botFetch('/resumable');
});

ipcMain.handle('recording:start', async (_event, { channelId, useExistingFolder }) => {
  return botFetch('/start', {
    method: 'POST',
    body: JSON.stringify({ channelId, useExistingFolder }),
  });
});

ipcMain.handle('recording:pause', async () => {
  return botFetch('/pause', { method: 'POST' });
});

ipcMain.handle('recording:resume', async () => {
  return botFetch('/resume', { method: 'POST' });
});

ipcMain.handle('recording:stop', async () => {
  return botFetch('/stop', { method: 'POST' });
});

ipcMain.handle('recording:status', async () => {
  return botFetch('/status');
});

// ---------- Transcrição e narrativa ----------

ipcMain.handle('process:transcribe', async (_event, { folder }) => {
  const originalLog = console.log;
  console.log = (...args) => {
    originalLog(...args);
    sendToRenderer('process:log', args.join(' '));
  };

  try {
    await transcribeAudio(folder, (progress) => {
      sendToRenderer('transcribe:progress', progress);
    });
    return { success: true };
  } catch (err) {
    sendToRenderer('process:log', `❌ Erro: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    console.log = originalLog;
  }
});

ipcMain.handle('process:narrate', async (_event, { folder }) => {
  const originalLog = console.log;
  console.log = (...args) => {
    originalLog(...args);
    sendToRenderer('process:log', args.join(' '));
  };

  try {
    await generateSessionNarrative(folder, (progress) => {
      sendToRenderer('narrate:progress', progress);
    });
    return { success: true };
  } catch (err) {
    sendToRenderer('process:log', `❌ Erro: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    console.log = originalLog;
  }
});

// ---------- Sessões ----------

const outputDir = join(__dirname, '..', 'src', 'output');

function parseSessionTimestamp(name) {
  const match = name.match(/^sessao-(.+)Z$/);
  if (!match) return null;
  const isoLike = match[1].replace(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/,
    '$1-$2-$3T$4:$5:$6.$7'
  );
  const ts = new Date(isoLike + 'Z').getTime();
  return isNaN(ts) ? null : ts;
}

ipcMain.handle('session:list', () => {
  try {
    if (!existsSync(outputDir)) return { success: true, sessions: [] };

    const sessions = readdirSync(outputDir)
      .filter((name) => name.startsWith('sessao-'))
      .map((name) => {
        const fullPath = join(outputDir, name);
        if (!statSync(fullPath).isDirectory()) return null;
        const timestamp = parseSessionTimestamp(name);
        if (timestamp === null) return null;
        return {
          name,
          fullPath,
          createdAt: timestamp,
          hasTranscription: existsSync(join(fullPath, 'transcricao.md')),
          hasNarrative: existsSync(join(fullPath, 'narrativa.md')),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);

    return { success: true, sessions };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('session:check-status', (_event, { folder }) => {
  return {
    hasTranscription: existsSync(join(folder, 'transcricao.md')),
    hasNarrative: existsSync(join(folder, 'narrativa.md')),
  };
});

// ---------- Utilitário ----------

ipcMain.handle('shell:open-folder', (_event, folderPath) => {
  shell.openPath(folderPath);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (botProcess) botProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (botProcess) botProcess.kill();
});