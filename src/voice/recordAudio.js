import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import prism from 'prism-media';
import wav from 'wav';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const activeSessions = new Map();

export function startRecording(voiceChannel) {
  const guildId = voiceChannel.guild.id;

  const sessionFolder = join(
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

    opusStream.pipe(decoder).pipe(wavWriter);

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