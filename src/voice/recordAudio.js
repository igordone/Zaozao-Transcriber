import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import prism from 'prism-media';
import wav from 'wav';
import { createWriteStream, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { Transform } from 'stream';


const RESUMABLE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 horas
const activeSessions = new Map();

// Filtra pacotes Opus pequenos demais, que o prism-media não consegue processar
// sem quebrar (bug conhecido: https://github.com/amishshah/prism-media/issues/104)
function createSafeOpusFilter() {
  return new Transform({
    transform(chunk, encoding, callback) {
      if (chunk.length < 8) {
        // Descarta silenciosamente — é um frame de silêncio, sem áudio real
        callback();
        return;
      }
      callback(null, chunk);
    },
  });
}

export function startRecording(options = {}, voiceChannel) {
  const guildId = voiceChannel.guild.id;

  const sessionFolder = options.existingFolder
    ? options.existingFolder
    : join(
        process.cwd(),
        'src',
        'output',
        `sessao-${new Date().toISOString().replace(/[:.]/g, '-')}`
      );

  if (!existsSync(sessionFolder)) mkdirSync(sessionFolder, { recursive: true });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`🔄 Conexão mudou de estado: ${oldState.status} → ${newState.status}`);
  });
  connection.on('error', (err) => console.error('❌ Erro na conexão de voz:', err));

  entersState(connection, VoiceConnectionStatus.Ready, 20000)
    .then(() => console.log('🟢 Conexão confirmada como Ready.'))
    .catch((err) => console.error('❌ TIMEOUT na conexão de voz:', err.message));

  const receiver = connection.receiver;
  //-------------Debug-------------------------------
  receiver.connection?.on?.('error', (err) => console.error('❌ Erro no receiver:', err));

  // Alguns eventos de erro de decriptação passam pelo socket UDP interno
  connection.receiver.voiceConnection?.on?.('debug', (msg) => {
    if (msg.includes('Decryption') || msg.includes('decrypt')) {
      console.log('🔐 Debug de decriptação:', msg);
    }
  });
  //--------------------------------------------

  const userStreams = new Map();

  console.log('👂 Escutando eventos de fala...');

  receiver.speaking.on('start', (userId) => {
    if (userStreams.has(userId)) return;
    console.log(`🎤 Detectado início de fala: ${userId}`);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });

    const safeFilter = createSafeOpusFilter();

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const filename = join(sessionFolder, `${userId}-${Date.now()}.wav`);
    const wavWriter = new wav.FileWriter(filename, {
      sampleRate: 48000,
      channels: 2,
      bitDepth: 16,
    });

    opusStream.on('error', (err) => console.error(`❌ Erro no opusStream de ${userId}:`, err));
    decoder.on('error', (err) => console.error(`❌ Erro no decoder de ${userId}:`, err));
    wavWriter.on('error', (err) => console.error(`❌ Erro ao escrever WAV de ${userId}:`, err));
    wavWriter.on('done', () => console.log(`💾 Arquivo salvo: ${filename}`));

    opusStream.pipe(safeFilter).pipe(decoder).pipe(wavWriter);
    safeFilter.on('error', (err) => console.warn(`⚠️ Erro no filtro de ${userId}:`, err.message));

    userStreams.set(userId, { opusStream, filename });

    opusStream.once('end', () => {
      console.log(`⏹️ Stream de fala encerrado para ${userId}`);
      userStreams.delete(userId);
    });
  });

  activeSessions.set(guildId, { connection, sessionFolder, userStreams });
  return sessionFolder;
}

export function stopRecording(guildId) {
  const session = activeSessions.get(guildId);
  if (!session) return null;
  session.connection.destroy();
  activeSessions.delete(guildId);
  return session.sessionFolder;
}

export function isRecording(guildId) {
  return activeSessions.has(guildId);
}

export function findResumableSession() {
  const outputDir = join(process.cwd(), 'src', 'output');
  if (!existsSync(outputDir)) return null;

  const folders = readdirSync(outputDir)
    .filter((name) => name.startsWith('sessao-'))
    .map((name) => {
      const match = name.match(/^sessao-(.+)Z$/);
      if (!match) return null;
      const isoLike = match[1].replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/,
        '$1-$2-$3T$4:$5:$6.$7'
      );
      const timestamp = new Date(isoLike + 'Z').getTime();
      return { name, timestamp, fullPath: join(outputDir, name) };
    })
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (folders.length === 0) return null;

  const mostRecent = folders[0];
  const age = Date.now() - mostRecent.timestamp;

  if (age < RESUMABLE_WINDOW_MS) {
    return mostRecent;
  }

  return null;
}