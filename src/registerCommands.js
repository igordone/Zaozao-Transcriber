import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('sessao')
    .setDescription('Controla a gravação da sessão de RPG')
    .addSubcommand((sub) =>
      sub.setName('iniciar').setDescription('Entra no canal de voz e começa a gravar')
    )
    .addSubcommand((sub) =>
      sub.setName('parar').setDescription('Para a gravação e sai do canal de voz')
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

try {
  console.log('🔄 Registrando slash commands...');

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );

  console.log('✅ Slash commands registrados com sucesso.');
} catch (error) {
  console.error(error);
}