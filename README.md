# Discord RPG Transcriber

Bot que entra em um canal de voz do Discord, grava a sessão (um arquivo `.wav` por
pessoa, por trecho de fala) e transcreve tudo em texto narrativo, separado por
personagem/jogador.

Feito pensando em sessões de RPG de mesa jogadas por voz no Discord — a ideia é que,
no final da sessão, você tenha um `.md` legível com a narrativa da mesa, sem precisar
anotar nada durante o jogo.

## Status atual

- [x] Bot entra no canal de voz via `/sessao iniciar`
- [x] Grava cada pessoa separadamente em `.wav`
- [x] Sai do canal via `/sessao parar`
- [x] Transcrição via API da Groq (Whisper)
- [x] Filtro de alucinações do Whisper (silêncio/ruído)
- [x] Mapeamento de ID do Discord → nome de personagem
- [x] Retry automático em caso de rate limit da API
- [x] Salvamento incremental (nunca perde progresso se a transcrição falhar no meio)
- [ ] Resumo automático da sessão (`/sessao resumo`) — não implementado ainda
- [ ] Detecção automática de novos personagens no `characters.json`

## Requisitos

- **Node.js 18+** (o projeto usa `fetch`, `FormData` e `Blob` nativos do Node — se
  você está no Node 22 como no desenvolvimento original, não precisa instalar nada
  extra pra isso)
- **ffmpeg** instalado no sistema (usado para inspecionar/validar arquivos de áudio
  durante o desenvolvimento; não é uma dependência direta do bot em runtime)
- Uma aplicação de bot criada no [Discord Developer Portal](https://discord.com/developers/applications)
- Uma chave de API da [Groq](https://console.groq.com/keys) (usada para transcrição
  via Whisper)

## Instalação

```powershell
npm install
```

Isso instala, entre outras coisas:

| Pacote | Para que serve |
|---|---|
| `discord.js` | Interação com a API do Discord (comandos, eventos) |
| `@discordjs/voice` | Conexão e captura de áudio em canais de voz |
| `@snazzah/davey` | Suporte ao protocolo DAVE (criptografia ponta-a-ponta obrigatória da Discord desde março de 2026) |
| `sodium-native` | Biblioteca de criptografia exigida pelo `@discordjs/voice` |
| `prism-media` | Decodificação do áudio Opus recebido do Discord |
| `wav` | Escrita de arquivos `.wav` válidos (com cabeçalho correto) a partir do PCM decodificado |
| `dotenv` | Carregamento de variáveis de ambiente do `.env` |

## Configuração

### 1. Criar o bot no Discord Developer Portal

1. Acesse https://discord.com/developers/applications → **New Application**
2. No menu lateral, vá em **Bot** → **Reset Token** (ou copie o token existente)
3. Ative os **Privileged Gateway Intents**: `Server Members Intent` e
   `Message Content Intent`
4. Em **OAuth2 → URL Generator**, marque os escopos `bot` e `applications.commands`
5. Em **Bot Permissions**, marque: `Connect`, `Speak`, `Use Voice Activity`,
   `Send Messages`, `View Channels`
6. Use a URL gerada para convidar o bot para o seu servidor

### 2. Preencher o `.env`

Copie o `.env.example` para `.env` e preencha:

```
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=
GROQ_API_KEY=
```

| Variável | Onde encontrar |
|---|---|
| `DISCORD_TOKEN` | Developer Portal → Bot → Token |
| `CLIENT_ID` | Developer Portal → General Information → Application ID |
| `GUILD_ID` | No Discord, com o Modo Desenvolvedor ativado: botão direito no servidor → Copiar ID do Servidor |
| `GROQ_API_KEY` | https://console.groq.com/keys → Create new secret key |

### 3. Registrar os slash commands

```powershell
npm run register
```

Isso registra o comando `/sessao` no servidor especificado em `GUILD_ID`. Precisa ser
rodado de novo sempre que a estrutura de comandos mudar (novos subcomandos, etc).

### 4. Preencher `src/characters.json`

Esse arquivo mapeia o ID de cada pessoa no Discord para o nome do personagem que
deve aparecer na transcrição final:

```json
{
  "128597385331998721": {
    "name": "Lucan",
    "role": "player"
  },
  "255699569042522112": {
    "name": "Mestre Aldric",
    "role": "master"
  }
}
```

- `role: "player"` → a fala aparece como `**Nome:** texto`
- `role: "master"` → a fala aparece destacada como narração: `> **Nome (Master):** texto`

Você descobre o ID de cada pessoa observando o console do bot na primeira vez que ela
fala durante uma gravação (aparece como `🎤 Detectado início de fala: [ID]`).

## Como usar

### 1. Subir o bot

```powershell
npm start
```

Deixe esse terminal aberto durante toda a sessão de RPG.

### 2. Gravar a sessão

No Discord, entre em um canal de voz e digite:

```
/sessao iniciar
```

O bot entra no canal e começa a gravar. Cada trecho de fala de cada pessoa é salvo
como um arquivo `.wav` separado, dentro de uma pasta nomeada com o timestamp da
sessão em `src/output/`.

Quando a sessão terminar:

```
/sessao parar
```

O bot sai do canal e confirma onde os arquivos foram salvos.

### 3. Transcrever a sessão

```powershell
npm run transcribe -- "src/output/sessao-2026-07-08T20-39-20-205Z"
```

(troque o caminho pelo nome real da pasta gerada no passo anterior)

Isso vai:
1. Enviar cada `.wav` para a API da Groq (modelo `whisper-large-v3-turbo`)
2. Filtrar trechos que o modelo classificou como silêncio/ruído/alucinação
3. Agrupar falas consecutivas da mesma pessoa em um único parágrafo
4. Aplicar os nomes definidos em `characters.json`
5. Salvar tudo em `transcricao.md`, dentro da própria pasta da sessão, ordenado
   cronologicamente

O progresso é salvo incrementalmente — se a API cair no meio ou você precisar
interromper, o `.md` gerado até aquele ponto não é perdido.

## Estrutura de pastas

```
discord-rpg-transcriber/
├─ src/
│  ├─ index.js               # ponto de entrada do bot
│  ├─ registerCommands.js    # registra os slash commands no Discord
│  ├─ transcribe.js          # script de transcrição (roda separado do bot)
│  ├─ characters.json        # mapeamento ID do Discord → nome do personagem
│  ├─ commands/
│  │  └─ sessao.js           # /sessao iniciar | parar
│  ├─ voice/
│  │  └─ recordAudio.js      # lógica de conexão e gravação por usuário
│  └─ output/                 # sessões gravadas (ignorado pelo git)
│     └─ sessao-.../
│        ├─ [id]-[timestamp].wav   # um arquivo por trecho de fala
│        └─ transcricao.md         # gerado após rodar npm run transcribe
├─ .env
├─ .env.example
├─ .gitignore
├─ package.json
└─ README.md
```

## Detalhes técnicos e decisões de design

### Por que `.wav` e não `.ogg`?

A primeira versão do projeto gravava em `.ogg` (container Ogg com stream Opus), que é
o formato mais "nativo" para áudio do Discord. Isso gerou uma cadeia de problemas:

- A classe `OggLogicalBitstream` do `prism-media` exige uma versão alpha específica
  do pacote (`2.0.0-alpha.0`), que não é a versão estável publicada
- O cálculo de CRC do container Ogg depende do pacote `node-crc`, que na versão atual
  publicada no npm é escrito em Rust e exige o toolchain do Cargo instalado — inviável
  para a maioria dos setups
- Desabilitar o CRC (`crc: false`) gera arquivos que tocam em players tolerantes (VLC)
  mas são rejeitados por ferramentas mais rigorosas (`ffmpeg`, `ffprobe`), o que
  também quebraria o envio para a API de transcrição

A solução foi decodificar o Opus para PCM (`prism.opus.Decoder`) e escrever
diretamente como `.wav` usando o pacote `wav`, que não depende de container Ogg nem
de checksum de página. Isso eliminou a cadeia de problemas por completo.

### Por que DAVE (`@snazzah/davey`)?

A partir de março de 2026, a Discord passou a exigir o protocolo DAVE (criptografia
ponta-a-ponta) em todos os canais de voz. Sem o pacote `@snazzah/davey` instalado, a
conexão de voz nunca sai do estado `Connecting`/`Signalling` e nunca chega a `Ready`.

Vale notar que, na época em que este projeto foi desenvolvido, havia relatos de bugs
conhecidos no suporte a DAVE do `@discordjs/voice` (principalmente relacionados à
recepção de áudio de participantes usando clientes desatualizados, que enviam áudio
sem a criptografia esperada e podem ter seus pacotes descartados). Se em algum
momento uma pessoa específica não estiver sendo gravada, o primeiro passo é confirmar
se o cliente Discord dela está atualizado.

### Por que o Node.js precisa de exceção no Firewall do Windows

O tráfego de voz do Discord usa UDP (diferente da sinalização, que usa WebSocket).
Se o Firewall do Windows não tiver uma regra explícita permitindo o `node.exe` em
redes **Privadas** (não só Públicas), a conexão de voz fica presa alternando entre
`Signalling` e `Connecting` indefinidamente, sem nunca reportar um erro claro.

### Filtro de alucinações do Whisper

Modelos Whisper tendem a "inventar" texto quando o áudio é silêncio, ruído de fundo,
ou som de fundo sem fala (jogos, música). O filtro combina três sinais retornados
pela API em modo `verbose_json`:

- `no_speech_prob` alto → provavelmente não há fala no trecho
- `avg_logprob` muito baixo → o modelo teve pouca confiança no texto gerado
- `compression_ratio` alto → texto repetitivo ou sem sentido

Além disso, há uma lista de expressões regulares para descartar frases clássicas de
alucinação (ex: "Legenda por...", "Obrigado." isolado, etc.), que aparecem com
frequência em transcrições de trechos sem fala real.

### Rate limit da API da Groq

O tier gratuito da Groq permite 20 requisições por minuto para o Whisper. O script de
transcrição:

- Espera ~3.1 segundos entre cada requisição, para não estourar o limite na maioria
  dos casos
- Se mesmo assim receber um erro `429`, lê o tempo de espera sugerido na própria
  mensagem de erro da API e tenta de novo automaticamente
- Salva o `.md` após cada arquivo processado, não apenas no final — então mesmo que o
  processo seja interrompido, o progresso não é perdido

## Solução de problemas

| Sintoma | Causa provável | Solução |
|---|---|---|
| `Missing Access` ao rodar `npm run register` | Bot convidado sem o escopo `applications.commands` | Gerar novo link de convite com esse escopo marcado e reconvidar o bot |
| `/sessao` não aparece no Discord | Comando registrado num servidor diferente do que você está testando | Confirmar que `GUILD_ID` corresponde ao servidor certo |
| Conexão de voz presa em `Signalling ↔ Connecting` | Firewall do Windows bloqueando UDP na rede Privada | Adicionar `node.exe` às exceções do Firewall para redes Privada e Pública |
| `.wav` gravado mas mudo/vazio para uma pessoa específica | Cliente Discord desatualizado dessa pessoa, causando falha de decriptação DAVE | Pedir para atualizar o app/cliente do Discord |
| Transcrição cheia de frases genéricas tipo "Obrigado" ou "Legenda por..." | Alucinação do Whisper em trechos de silêncio/ruído | Já mitigado pelo filtro combinado em `transcribe.js`; ajustar os limites (`NO_SPEECH_THRESHOLD`, etc.) se persistir |
| Erro `429` durante a transcrição | Rate limit da Groq atingido | O script já faz retry automático; se persistir, considerar aumentar o delay entre requisições |
| Nome do personagem não aparece na transcrição (mostra `Usuário [ID]`) | ID não cadastrado em `characters.json`, ou arquivo com nome/local errado | Confirmar que o arquivo se chama exatamente `characters.json` e está em `src/`, com o ID como chave exata |

## Próximos passos

1. **`/sessao resumo`**: gerar um resumo automático da sessão a partir da
   `transcricao.md`, usando a API da Groq ou Anthropic
2. **Detecção automática de personagens novos**: ao encontrar um `userId` sem entrada
   em `characters.json`, perguntar o nome via mensagem no Discord em vez de exigir
   edição manual do arquivo
3. **Processamento pós-transcrição com LLM**: limpar hesitações e reorganizar a fala
   em prosa narrativa mais próxima de um livro
4. **Migração para transcrição local** (`faster-whisper` ou `whisper.cpp`), caso o
   rate limit da API gratuita se torne um limitador real em sessões muito longas