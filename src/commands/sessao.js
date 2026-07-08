import { SlashCommandBuilder } from 'discord.js';
import { startRecording, stopRecording, isRecording } from '../voice/recordAudio.js';

export default {
  data: new SlashCommandBuilder()
    .setName('sessao')
    .setDescription('Controla a gravação da sessão de RPG')
    .addSubcommand((sub) =>
      sub.setName('iniciar').setDescription('Entra no canal de voz e começa a gravar')
    )
    .addSubcommand((sub) =>
      sub.setName('parar').setDescription('Para a gravação e sai do canal de voz')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (subcommand === 'iniciar') {
      const member = interaction.member;
      const voiceChannel = member.voice.channel;

      if (!voiceChannel) {
        return interaction.reply({
          content: '⚠️ Você precisa estar em um canal de voz para iniciar a gravação.',
          ephemeral: true,
        });
      }

      if (isRecording(guildId)) {
        return interaction.reply({
          content: '⚠️ Já existe uma gravação em andamento neste servidor.',
          ephemeral: true,
        });
      }

      const folder = startRecording(voiceChannel);
      return interaction.reply(
        `🔴 Gravação iniciada em **${voiceChannel.name}**.\nArquivos serão salvos em: \`${folder}\``
      );
    }

    if (subcommand === 'parar') {
      if (!isRecording(guildId)) {
        return interaction.reply({
          content: '⚠️ Nenhuma gravação em andamento.',
          ephemeral: true,
        });
      }

      const folder = stopRecording(guildId);
      return interaction.reply(
        `⏹️ Gravação encerrada.\nÁudios salvos em: \`${folder}\`\n\nPróximo passo: rodar a transcrição sobre esses arquivos.`
      );
    }
  },
};