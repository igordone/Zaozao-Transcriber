import dotenv from 'dotenv';
import { getEnvPath } from './paths.js';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || getEnvPath() });
import { createServer } from 'http';
import { createBotClient } from './index.js';
import {
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  isRecording,
  isPaused,
  findResumableSession,
} from './voice/recordAudio.js';

const PORT = 4741;

let client = null;
let currentGuildId = process.env.GUILD_ID;

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  // Permite requisições vindas do renderer do Electron (localhost)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  try {
    if (req.url === '/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        connected: !!client,
        botTag: client?.user?.tag ?? null,
        isRecording: isRecording(currentGuildId),
        isPaused: isPaused(currentGuildId),
      });
    }

    if (req.url === '/connect' && req.method === 'POST') {
      if (client) return sendJson(res, 200, { success: true, alreadyConnected: true });
      client = await createBotClient();
      return sendJson(res, 200, { success: true, botTag: client.user.tag });
    }

    if (req.url === '/active-voice-channels' && req.method === 'GET') {
      if (!client) return sendJson(res, 400, { success: false, error: 'Bot não conectado.' });

      const guild = await client.guilds.fetch(currentGuildId);
      const channels = await guild.channels.fetch();

      const active = [...channels.values()]
        .filter((c) => c && c.isVoiceBased() && c.members.size > 0)
        .map((c) => ({ id: c.id, name: c.name, memberCount: c.members.size }));

      return sendJson(res, 200, { success: true, channels: active });
    }

    if (req.url === '/resumable' && req.method === 'GET') {
      const resumable = findResumableSession();
      if (!resumable) return sendJson(res, 200, { resumable: false });

      const ageMinutes = Math.round((Date.now() - resumable.timestamp) / 60000);
      return sendJson(res, 200, { resumable: true, ageMinutes, folderName: resumable.name });
    }

    if (req.url === '/start' && req.method === 'POST') {
      if (!client) return sendJson(res, 400, { success: false, error: 'Bot não conectado.' });

      const { channelId, useExistingFolder } = await readBody(req);
      const guild = await client.guilds.fetch(currentGuildId);
      const voiceChannel = await guild.channels.fetch(channelId);

      const resumable = useExistingFolder ? findResumableSession() : null;
      const folder = startRecording(voiceChannel, {
        existingFolder: resumable ? resumable.fullPath : null,
      });

      return sendJson(res, 200, { success: true, folder });
    }

    if (req.url === '/pause' && req.method === 'POST') {
      pauseRecording(currentGuildId);
      return sendJson(res, 200, { success: true });
    }

    if (req.url === '/resume' && req.method === 'POST') {
      resumeRecording(currentGuildId);
      return sendJson(res, 200, { success: true });
    }

    if (req.url === '/stop' && req.method === 'POST') {
      const folder = stopRecording(currentGuildId);
      return sendJson(res, 200, { success: true, folder });
    }

    sendJson(res, 404, { error: 'Rota não encontrada.' });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Servidor de controle do bot rodando em http://localhost:${PORT}`);
});