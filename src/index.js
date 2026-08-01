import 'dotenv/config';
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createBotClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.commands = new Collection();

  // Carrega todos os comandos da pasta /commands automaticamente
  const commandsPath = join(__dirname, 'commands');
  const commandFiles = readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

  for (const file of commandFiles) {
    const commandModule = await import(`./commands/${file}`);
    const command = commandModule.default;
    client.commands.set(command.data.name, command);
  }

  client.once('clientReady', () => {
    console.log(`✅ Bot conectado como ${client.user.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      const reply = { content: '❌ Ocorreu um erro ao executar o comando.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  });

  await client.login(process.env.DISCORD_TOKEN);

  return client;
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  createBotClient().catch((err) => {
    console.error('❌ Erro ao iniciar o bot:', err);
    process.exit(1);
  });
}