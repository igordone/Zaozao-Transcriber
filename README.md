# Discord RPG Transcriber

Bot que entra em um canal de voz do Discord, grava a sessão e transcreve tudo em texto
narrativo, separado por personagem/jogador — com uma etapa opcional que reescreve a
transcrição bruta como um capítulo de livro de fantasia, resumindo mecânica de jogo,
combates repetitivos e conversa fora de personagem.

Feito pensando em sessões de RPG de mesa jogadas por voz no Discord — a ideia é que, no
final da sessão, você tenha um `.md` legível com a narrativa da mesa, sem precisar
anotar nada durante o jogo.

## Status atual

- [x] Bot entra no canal de voz via `/sessao iniciar` e grava cada pessoa separadamente
- [x] Fusão de áudio por pessoa antes da transcrição (grande ganho de velocidade)
- [x] Transcrição com fallback em cascata (Groq → Whisper local)
- [x] Narrativa com fallback em cascata (Groq → Ollama Cloud → Ollama local)
- [x] Filtro de alucinações do Whisper (silêncio, ruído, frases genéricas repetidas)
- [x] Mapeamento de ID do Discord → nome de personagem
- [x] Salvamento incremental em cada etapa (nunca perde progresso se travar no meio)
- [x] Marcadores de tempo de início/fim de cada etapa no console
- [ ] Resumo automático via comando `/sessao resumo` — não implementado ainda
- [ ] Detecção automática de personagens novos (hoje exige edição manual do `characters.json`)

## Requisitos

- **Node.js 18+**
- **ffmpeg** (via `ffmpeg-static`, já incluso nas dependências — não precisa instalar
  separadamente no sistema, embora não tenha problema se você já tiver um)
- Uma aplicação de bot criada no [Discord Developer Portal](https://discord.com/developers/applications)
- Uma chave de API da [Groq](https://console.groq.com/keys) (transcrição via Whisper e
  narrativa via LLM de texto)
- [Ollama](https://ollama.com) instalado (usado como respaldo local/nuvem quando a
  cota da Groq se esgota)

## Instalação

```powershell
npm install
```

Principais pacotes e para que servem:

| Pacote | Para que serve |
|---|---|
| `discord.js` | Interação com a API do Discord (comandos, eventos) |
| `@discordjs/voice` | Conexão e captura de áudio em canais de voz |
| `@snazzah/davey` | Suporte ao protocolo DAVE (criptografia ponta-a-ponta obrigatória em canais de voz da Discord desde março de 2026) |
| `sodium-native` | Criptografia exigida pelo `@discordjs/voice` |
| `prism-media` (versão `2.0.0-alpha.0`, **fixada**) | Decodificação do áudio Opus recebido do Discord |
| `wav` | Escrita de `.wav` válidos a partir do PCM decodificado |
| `ffmpeg-static` | Fusão e compressão dos áudios antes da transcrição |
| `@lumen-labs-dev/whisper-node` | Whisper local (binários pré-compilados no Windows, sem precisar compilar nada) |
| `yaml` | Leitura do arquivo de configuração `config.yaml` |
| `dotenv` | Carregamento de variáveis de ambiente do `.env` |

## Configuração

### 1. Criar o bot no Discord Developer Portal

1. Acesse https://discord.com/developers/applications → **New Application**
2. **Bot** → **Reset Token** (ou copie o token existente)
3. Ative os **Privileged Gateway Intents**: `Server Members Intent` e
   `Message Content Intent`
4. **OAuth2 → URL Generator** → marque os escopos `bot` e `applications.commands`
5. Em **Bot Permissions**, marque: `Connect`, `Speak`, `Use Voice Activity`,
   `Send Messages`, `View Channels`
6. Use a URL gerada para convidar o bot para o seu servidor

### 2. Preencher o `.env`

Copie `.env.example` para `.env`:

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
| `GUILD_ID` | Discord (Modo Desenvolvedor ativado) → botão direito no servidor → Copiar ID do Servidor |
| `GROQ_API_KEY` | https://console.groq.com/keys |

### 3. Registrar os slash commands

```powershell
npm run register
```

Só precisa rodar de novo se a estrutura de comandos mudar.

### 4. Preencher `src/characters.json`

Mapeia o ID de cada pessoa no Discord para o nome do personagem:

```json
{
  "128597385331998721": { "name": "Lucan", "role": "player" },
  "255699569042522112": { "name": "Mestre Aldric", "role": "master" }
}
```

- `role: "player"` → fala aparece como `**Nome:** texto`
- `role: "master"` → fala aparece destacada como narração: `> **Nome (Master):** texto`

Você descobre o ID de cada pessoa no console do bot, na primeira vez que ela fala
(`🎤 Detectado início de fala: [ID]`).

### 5. Configurar o `config.yaml`

Esse arquivo controla qual provedor cada etapa usa. Exemplo completo:

```yaml
transcription:
  # 'groq', 'local', ou 'fallback' (tenta Groq, cai pro Whisper local se precisar)
  provider: 'fallback'
  groq:
    model: 'whisper-large-v3-turbo'
  local:
    model: 'small'   # tiny | base | small | medium | large

narrative:
  enabled: true
  # 'groq', 'ollama', ou 'fallback' (Groq → Ollama Cloud → Ollama local)
  provider: 'fallback'
  groq:
    model: 'llama-3.1-8b-instant'
  ollama_cloud:
    base_url: 'http://localhost:11434/v1'
    model: 'gemma4:cloud'
  ollama:
    base_url: 'http://localhost:11434/v1'
    model: 'llama3.1'
  condense_prompt: |
    (resume cada pedaço da transcrição em tópicos enxutos, sem mecânica de jogo)
  final_prompt: |
    (funde todos os resumos numa narrativa única, estilo capítulo de livro)
```

### 6. Baixar os modelos do Whisper local e do Ollama

```powershell
npx @lumen-labs-dev/whisper-node download
```
Escolha `small` (ou o modelo definido em `transcription.local.model`).

```powershell
ollama pull llama3.1
```
Modelo local leve, usado como último nível de respaldo na narrativa. Rode
`ollama serve` (ou abra o app) antes de transcrever, e confirme que está de pé com
`curl http://localhost:11434`.

**Nota sobre modelos maiores:** modelos como `qwen3.6` (~23GB) podem não ser viáveis
dependendo da sua RAM/GPU — nesse projeto, uma GPU AMD sem suporte CUDA completo faz
esses modelos caírem para CPU pura, o que pode ser inviavelmente lento ou travar por
falta de memória. Prefira modelos menores localmente e use `gemma4:cloud` (ou outro
modelo `:cloud` do plano gratuito da Ollama) para qualidade melhor sem pesar na sua
máquina.

## Como usar

### 1. Subir o bot

```powershell
npm start
```

### 2. Gravar a sessão

No Discord, em um canal de voz:
```
/sessao iniciar
```
Joga normalmente. Ao final:
```
/sessao parar
```

Cada trecho de fala de cada pessoa é salvo como um `.wav` separado, em
`src/output/sessao-[timestamp]/`.

### 3. Transcrever e gerar a narrativa

```powershell
npm run transcribe -- "src/output/sessao-2026-07-12T17-12-51-165Z"
```

Isso executa o pipeline completo:

1. **Fusão** — junta os `.wav` de cada pessoa em um único arquivo grande, com ~2s de
   silêncio real inserido entre cada trecho original (evita que o Whisper misture
   falas de momentos diferentes). Reaproveita a fusão se já tiver sido feita antes.
2. **Compressão** — gera uma versão `.mp3` (16kHz, mono, 32kbps) de cada arquivo
   fundido, para caber no limite de 25MB de upload da Groq (um `.wav` bruto de 1h
   facilmente passa de 600MB).
3. **Transcrição** — cada arquivo `.mp3` é enviado à Groq; se o rate limit persistir ou
   o arquivo ainda for grande demais mesmo comprimido, cai automaticamente para o
   Whisper local usando o `.wav` original.
4. **Filtro de alucinação** — descarta segmentos identificados como silêncio, ruído, ou
   frases genéricas conhecidas (`"Legenda por..."`, `"Obrigado."` isolado, etc.).
5. **`transcricao.md`** — gerado com nomes de personagem, timestamps e falas agrupadas.
6. **Narrativa** (se `narrative.enabled: true`) — condensa a transcrição em pedaços
   menores, depois compõe tudo numa única narrativa contínua, salva em `narrativa.md`.

O console mostra o tempo total de cada etapa ao final.

### 4. Rodar só a narrativa (sem refazer a transcrição)

```powershell
npm run narrate -- "src/output/sessao-2026-07-12T17-12-51-165Z"
```

Útil para testar ajustes no prompt do `config.yaml` sem esperar a transcrição de novo.

## Estrutura de pastas

```
discord-rpg-transcriber/
├─ src/
│  ├─ index.js                    # ponto de entrada do bot
│  ├─ registerCommands.js         # registra os slash commands
│  ├─ config.js                   # carrega o config.yaml
│  ├─ mergeAudio.js                # funde + comprime os .wav por pessoa
│  ├─ transcribe.js                # orquestrador: merge → transcrição → narrativa
│  ├─ narrate.js                   # lógica de condensação + composição da narrativa
│  ├─ narrateOnly.js               # roda só a etapa de narrativa isoladamente
│  ├─ characters.json              # mapeamento ID do Discord → nome do personagem
│  ├─ commands/
│  │  └─ sessao.js                 # /sessao iniciar | parar
│  ├─ voice/
│  │  └─ recordAudio.js            # conexão de voz e gravação por usuário
│  ├─ providers/
│  │  ├─ transcribeGroq.js         # transcrição via Groq (arquivo fundido/mp3)
│  │  ├─ transcribeLocal.js        # transcrição via Whisper local (arquivo fundido/wav)
│  │  └─ transcribeFallback.js     # orquestra Groq → Whisper local
│  └─ output/                      # sessões gravadas (ignorado pelo git)
│     └─ sessao-.../
│        ├─ [id]-[timestamp].wav   # fragmentos originais, um por trecho de fala
│        ├─ merged/
│        │  ├─ [userId].wav        # áudio fundido, sem compressão (usado no fallback local)
│        │  ├─ [userId].mp3        # áudio fundido, comprimido (usado no upload à Groq)
│        │  └─ [userId].offsets.json  # mapa para reconstruir os timestamps reais
│        ├─ transcricao.md
│        └─ narrativa.md
├─ config.yaml                     # provedores e prompts de cada etapa
├─ .env / .env.example
├─ .gitignore
├─ package.json
└─ README.md
```

## Detalhes técnicos e decisões de design

### Por que fundir os áudios antes de transcrever

A gravação corta um arquivo novo a cada ~1s de silêncio, o que gera centenas ou
milhares de fragmentos minúsculos por sessão. Cada chamada de transcrição (Groq ou
Whisper local) tem um custo fixo de processamento de alguns segundos, *independente do
tamanho do áudio* — transcrever 3.500 fragmentos de menos de 1 segundo cada podia levar
mais de 3 horas só de overhead. Fundindo os fragmentos de cada pessoa em um único
arquivo grande antes de transcrever, esse custo fixo é pago uma única vez por pessoa,
não uma vez por frase — reduzindo sessões de horas para minutos (uma sessão de teste
caiu de ~4h para ~21 minutos com essa mudança).

Como efeito colateral positivo, arquivos maiores também dão mais contexto ao modelo de
transcrição, melhorando o reconhecimento de nomes próprios e termos específicos da
campanha.

### Por que existem dois formatos (.wav e .mp3) por pessoa

Um `.wav` sem compressão a 48kHz estéreo consome ~192KB por segundo — um áudio fundido
de poucos minutos já ultrapassa o limite de 25MB de upload da API da Groq. A versão
`.mp3` (16kHz, mono, 32kbps) é gerada especificamente para caber nesse limite mesmo em
sessões longas, e é usada como primeira tentativa. Se mesmo comprimida a Groq rejeitar
(sessões extremamente longas) ou o rate limit persistir, o `.wav` original é usado como
entrada para o Whisper local, que não tem essa restrição de tamanho.

### Por que `.wav` (e não `.ogg`) na gravação original

A gravação usa `.wav` em vez do container Ogg nativo do Discord porque a classe
`OggLogicalBitstream` do `prism-media` depende de um pacote de cálculo de checksum
(`node-crc`) cuja versão publicada atual exige compilação em Rust — inviável na maioria
dos setups Windows. Decodificar o Opus para PCM e escrever direto como `.wav` evitou
essa cadeia de dependências problemáticas.

### Por que DAVE (`@snazzah/davey`)

Desde março de 2026 a Discord exige o protocolo DAVE (criptografia ponta-a-ponta) em
canais de voz. Sem esse pacote, a conexão nunca sai do estado `Connecting`/`Signalling`.
Se uma pessoa específica não for gravada (áudio mudo/vazio), o primeiro passo é
confirmar se o cliente Discord dela está atualizado — clientes desatualizados podem
enviar áudio sem a criptografia esperada, sendo descartados silenciosamente.

### Firewall do Windows

O tráfego de voz do Discord usa UDP. Sem uma regra explícita permitindo o `node.exe` em
redes **Privadas** (não só Públicas) no Firewall do Windows, a conexão de voz fica presa
alternando entre `Signalling` e `Connecting` indefinidamente.

### Filtro de alucinações do Whisper

Tanto a Groq (via `no_speech_prob`, `avg_logprob`, `compression_ratio`) quanto o Whisper
local (via filtro de padrões de texto e remoção de marcações como `[MÚSICA]`) descartam
trechos identificados como silêncio, ruído de fundo, ou frases genéricas que o modelo
"inventa" quando não há fala real (`"Legenda por..."`, `"Obrigado."` isolado, etc.).

Um risco conhecido do Whisper local em áudios longos: o modelo usa o texto recém-gerado
como contexto para continuar a transcrição, e se ele errar e repetir uma frase, esse
erro se autorreforça, causando um loop de repetição até o fim do áudio. A compressão
para `.mp3` (que mantém a maioria das transcrições na Groq, menos suscetível a esse
comportamento) reduz bastante a exposição a esse problema.

### Fallback em cascata

Tanto a transcrição quanto a narrativa tentam a Groq primeiro (rápida, mas com cota
limitada) e caem automaticamente para alternativas locais/gratuitas quando o rate limit
é atingido — sem travar o processo nem exigir intervenção manual:

```
Transcrição:  Groq (mp3)  →  Whisper local (wav)

Narrativa:    Groq  →  Ollama Cloud (gemma4:cloud)  →  Ollama local (llama3.1)
```

Esperas curtas de rate limit (menos de 30s) são absorvidas com retry automático; esperas
longas (rate limit diário) fazem o processo cair direto para o próximo nível, em vez de
ficar parado esperando.

### Narrativa em duas etapas (map-reduce)

Uma transcrição de sessão inteira não cabe no contexto de uma única chamada de LLM.
A geração da narrativa funciona em duas etapas:

1. **Condensar**: cada pedaço da transcrição bruta (~6.000 caracteres) é resumido
   isoladamente em tópicos enxutos, sem mecânica de jogo.
2. **Compor**: todos os resumos são enviados juntos numa única chamada final, que
   escreve a narrativa completa com início, meio e fim — porque só nessa etapa o modelo
   tem visão da sessão inteira de uma vez, evitando repetições que apareceriam se cada
   pedaço fosse narrado isoladamente.

## Solução de problemas

| Sintoma | Causa provável | Solução |
|---|---|---|
| `Missing Access` ao rodar `npm run register` | Bot convidado sem o escopo `applications.commands` | Gerar novo link de convite com esse escopo e reconvidar o bot |
| `/sessao` não aparece no Discord | Comando registrado num servidor diferente do testado | Confirmar que `GUILD_ID` corresponde ao servidor certo |
| Conexão de voz presa em `Signalling ↔ Connecting` | Firewall do Windows bloqueando UDP na rede Privada | Adicionar `node.exe` às exceções do Firewall para redes Privada e Pública |
| `.wav` gravado mas mudo/vazio para uma pessoa específica | Cliente Discord desatualizado, falha de decriptação DAVE | Pedir para atualizar o app do Discord |
| Erro `413 Payload Too Large` na transcrição | Arquivo `.mp3` ainda excede 25MB (sessão extremamente longa) | O fallback já cai para o Whisper local automaticamente; não requer ação manual |
| Transcrição local presa repetindo a mesma frase | Bug de auto-condicionamento do Whisper em áudios longos | Mitigado pela compressão para `.mp3` (mantém mais transcrições na Groq); se persistir, considerar dividir o `.wav` em sub-blocos menores antes do Whisper local |
| Erro `429` na Groq | Rate limit (por minuto ou diário) | O fallback já lida automaticamente; se aparecer só no console sem interromper o processo, é esperado |
| Nome do personagem não aparece (`Usuário [ID]`) | ID não cadastrado em `characters.json` | Confirmar nome exato do arquivo (`characters.json`, em `src/`) e que a chave bate com o ID exato |
| `Cannot find module 'node-crc'` | Configuração antiga de gravação em `.ogg` | Já resolvido na versão atual (gravação em `.wav`); não deveria mais ocorrer |

## Under Construct 👷