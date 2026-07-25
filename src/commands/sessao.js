import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { startRecording, stopRecording, isRecording, findResumableSession } from '../voice/recordAudio.js';

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

      const resumable = findResumableSession();

      if (resumable) {
        const ageMinutes = Math.round((Date.now() - resumable.timestamp) / 60000);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('sessao_continuar')
            .setLabel('▶️ Continuar sessão anterior')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('sessao_nova')
            .setLabel('🆕 Nova sessão')
            .setStyle(ButtonStyle.Secondary)
        );

        const response = await interaction.reply({
          content: `Encontrei uma sessão de **${ageMinutes} minuto(s) atrás**. Isso foi uma pausa, ou você quer começar uma sessão nova?`,
          components: [row],
          withResponse: true,
        });

        const collector = response.resource.message.createMessageComponentCollector({
          time: 30_000,
          max: 1,
        });

        collector.on('collect', async (buttonInteraction) => {
          if (buttonInteraction.user.id !== interaction.user.id) {
            return buttonInteraction.reply({
              content: '⚠️ Só quem iniciou o comando pode responder.',
              ephemeral: true,
            });
          }

          const useExisting = buttonInteraction.customId === 'sessao_continuar';
          const folder = startRecording(voiceChannel, {
            existingFolder: useExisting ? resumable.fullPath : null,
          });

          await buttonInteraction.update({
            content: useExisting
              ? `🔴 Continuando a gravação em **${voiceChannel.name}**.\nUsando a pasta: \`${folder}\``
              : `🔴 Nova gravação iniciada em **${voiceChannel.name}**.\nArquivos serão salvos em: \`${folder}\``,
            components: [],
          });
        });

        collector.on('end', (collected) => {
          if (collected.size === 0) {
            // Ninguém respondeu a tempo - assume nova sessão por segurança
            const folder = startRecording(voiceChannel, {});
            interaction.editReply({
              content: `⏱️ Sem resposta - iniciando **nova sessão** por padrão em **${voiceChannel.name}**.\nArquivos serão salvos em: \`${folder}\``,
              components: [],
            });
          }
        });

        return;
      }

      const folder = startRecording(voiceChannel, {});
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