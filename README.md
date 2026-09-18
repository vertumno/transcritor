# Transcritor

Baixa e transcreve vídeos **na sua máquina**. Você passa o que tem — link do
YouTube, link do Instagram ou arquivo no disco — e ele resolve sozinho.

Sem API, sem chave, sem custo por minuto. O áudio não sai do seu computador.

---

## Índice

- [Uso rápido](#uso-rápido)
- [As rotas](#as-rotas)
- [Opções](#opções)
- [O motor local](#o-motor-local)
- [Vocabulário: corrigindo nomes e siglas](#vocabulário-corrigindo-nomes-e-siglas)
- [Formato de saída](#formato-de-saída)
- [Como funciona internamente](#como-funciona-internamente)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Pré-requisitos](#pré-requisitos)
- [Custo](#custo)
- [Troubleshooting](#troubleshooting)

---

## Uso rápido

### Processar a pasta de entrada

```bash
# 1. Coloque vídeos e áudios em _inbox/
# 2. Execute sem argumentos
node src/index.js
```

Cada arquivo só sai da `_inbox/` depois de ser transcrito com sucesso. Ele é
movido para uma pasta própria em `_processados/`, junto com o Markdown, SRT
opcional e metadados.

### Transcrever

```bash
# YouTube: usa legenda humana; sem ela, transcreve o melhor áudio localmente
node src/index.js https://www.youtube.com/watch?v=abc123

# Instagram, TikTok e afins: baixa o áudio e transcreve na sua máquina
node src/index.js https://www.instagram.com/reel/abc123/

# Arquivo local fora da inbox também funciona (não é movido)
node src/index.js "C:\caminho\aula.mp4" --srt

# Lote de links
node src/index.js --file links.txt --concat
```

### Os três modos

```bash
# 1. Somente baixar o vídeo do YouTube ou Instagram em _processados/
node src/index.js URL --baixar

# 2. Baixar a melhor faixa de áudio e transcrever localmente
node src/index.js URL

# 3. Somente transcrever um arquivo que já está no computador
node src/index.js arquivo.mp4
# ou coloque os arquivos em _inbox/ e execute sem argumentos
node src/index.js
```

No segundo modo, a mídia mantida junto do trabalho é a melhor faixa de áudio,
não uma segunda cópia do vídeo completo. No YouTube, uma legenda humana é usada
diretamente quando estiver disponível; nesse caso não é necessário baixar a
mídia. O modo `--baixar` sempre baixa o vídeo e não produz transcrição.

No Windows há também o atalho `transcrever.bat` — no PowerShell use `.\transcrever`,
no cmd basta `transcrever`.

Uma saída típica fica assim:

```text
_processados/
└── 2026-09-18-1711 - Nome da aula/
    ├── 2026-09-18-1711 - Nome da aula.mp4
    ├── 2026-09-18-1711 - Nome da aula.md
    ├── 2026-09-18-1711 - Nome da aula.srt
    └── 2026-09-18-1711 - Nome da aula.metadados.json
```

---

## As rotas

O programa detecta o tipo de entrada e decide sozinho. **Tudo custa zero:**

| Você passa | Rota | Velocidade |
|---|---|---|
| URL do YouTube com legenda humana | legenda revisada do YouTube | instantâneo |
| URL do YouTube sem legenda humana | preserva o melhor áudio e transcreve localmente | depende do perfil |
| URL de outro site (Instagram, TikTok…) | baixa o áudio e transcreve na sua máquina | ~10x tempo real¹ |
| Arquivo local (`.mp4`, `.mp3`…) | transcreve na sua máquina | ~10x tempo real¹ |
| Qualquer URL + `--baixar` | só baixa o vídeo, não transcreve | — |

¹ Com GPU NVIDIA. Sem GPU, aproximadamente 1x — uma hora de vídeo leva uma
hora. Veja [O motor local](#o-motor-local).

> Legenda automática do YouTube não é mais preferida sobre o motor local. A
> prioridade é legenda humana e depois Whisper local.

### Somente baixar um vídeo

```bash
node src/index.js https://www.instagram.com/reel/abc123/ --baixar
```

Esse modo cria um trabalho timestampado em `_processados/`, com o vídeo,
metadados e a legenda/descrição do post quando disponível, sem transcrever.

---

## Opções

| Opção | O que faz |
|---|---|
| `--baixar` | baixa o vídeo para um trabalho em `_processados/`, sem transcrever |
| `--cookies <arquivo>` | cookies para sites que exigem login (padrão: `cookies.txt` da pasta) |
| `--navegador <nome>` | lê os cookies do navegador — use `firefox` |
| `-f, --file <arquivo>` | arquivo `.txt` com uma URL por linha |
| `-o, --output <pasta>` | raiz dos trabalhos (padrão: `_processados/`) |
| `-l, --lang <idiomas...>` | idiomas (padrão: `pt pt-BR en es`; use `auto` para detectar) |
| `--srt` | gera também legenda `.srt` com marcação de tempo |
| `--forcar` | compatibilidade; cada execução já cria uma nova versão timestampada |
| `--stdout` | imprime no terminal em vez de salvar |
| `--concat` | junta todas as transcrições num arquivo único |
| `-h, --help` | mostra a ajuda |

### Motor de transcrição

| Opção | O que faz |
|---|---|
| `--perfil <nome>` | `qualidade` (padrão) ou `rapido` |
| `--modelo <nome>` | sobrescreve o modelo escolhido pelo perfil |
| `--compute <tipo>` | `auto`, `float16`, `int8_float16` ou `int8` |
| `--device <alvo>` | `auto`, `cuda` ou `cpu` (padrão: `auto`) |
| `--vad <modo>` | `auto`, `on` ou `off`; use `off` para canto/fala muito baixa |
| `--refazer` | no YouTube, ignora a legenda pronta e transcreve o áudio |
| `--api` | usa a API da OpenAI em vez do motor local (**pago**) |
| `--api-key <chave>` | chave da OpenAI (ou `OPENAI_API_KEY` no `.env`) |

```bash
node src/index.js url --stdout | clip          # copia direto para o clipboard
node src/index.js url --stdout > saida.md      # redireciona para arquivo
```

---

## O motor local

Quem transcreve é o [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
— o Whisper executado com CTranslate2, inteiramente na sua máquina.

### Modelos

O padrão é o perfil **`qualidade`**, com `large-v3`. Para trabalhos menos
críticos, `--perfil rapido` usa `large-v3-turbo`.

| Modelo | Disco | Qualidade |
|---|---|---|
| `large-v3` **(padrão)** | ~3,1 GB | maior precisão disponível neste pipeline |
| `large-v3-turbo` | ~1,6 GB | muito mais rápido, com pequena perda potencial |
| `small` | ~0,5 GB | erra nomes e palavras² |
| `tiny` | ~0,1 GB | só para teste rápido |

² Medido neste projeto, mesmo trecho de áudio: `small` devolveu "ler **ciência**
sua mente" (era "ler sim a sua mente"), "**Divisão** computacional" (era "visão
computacional") e "Ozaka" (era "Osaka"). O `large-v3-turbo` acertou os três.

O modelo é baixado sozinho no primeiro uso e fica em cache
(`~/.cache/huggingface`). Depois disso funciona **offline**.

### Velocidade

Medido neste projeto, 104 s de áudio falado em português:

| Onde roda | Velocidade | 1 hora de vídeo leva |
|---|---|---|
| GPU NVIDIA (RTX 2050, 4 GB) | 9,9x tempo real | ~6 min |
| CPU (i5-12450H) | 0,9x tempo real | ~66 min |

A GPU é detectada sozinha. Sem GPU, cai para a CPU sem você fazer nada — e sem
falhar no meio do caminho: se a placa não tiver memória suficiente, ele repete
na CPU automaticamente.

### Áudio cantado

O detector de voz usa parâmetros conservadores para reter fala baixa e curta.
No perfil de qualidade, uma segunda leitura sensível identifica possíveis
lacunas e registra seus tempos em `.metadados.json`.

O perfil de qualidade faz uma única segunda passagem, sem VAD e sem o contexto
do trecho anterior, somente nos intervalos marcados como baixa confiança ou
possível lacuna. A nova versão só substitui a original quando melhora a
confiança ou recupera fala que estava ausente.

O `.metadados.json` registra a cobertura do VAD, os intervalos suspeitos, cada
tentativa, sua pontuação, a decisão e quantas substituições foram aceitas. Para
canto ou fala muito baixa, ainda é possível desativar o VAD na execução inteira:

```bash
node src/index.js arquivo.mp4 --vad off
```

### Ainda dá para usar a API

O caminho antigo continua inteiro, atrás da flag `--api`:

```bash
node src/index.js video.mp4 --api        # gpt-transcribe, com fallback whisper-1
```

Faz sentido quando a máquina está ocupada e você quer o resultado agora.

---

## Vocabulário: corrigindo nomes e siglas

Edite **`config/vocabulario.txt`** quando a IA erra sempre o mesmo nome. Vale para as
duas rotas.

**1. Dicas de grafia** — o termo correto, um por linha. A IA *tenta* seguir:

```
Equipe DIJ, FEEES, evangelizacao espirita
```

**2. Correções garantidas** — no formato `errado => certo`:

```
equipe EJ => Equipe DIJ
```

A correção é aplicada por código no texto final, sem depender da IA. **É o
método confiável.** Testado: com um vídeo em que a IA insistia em "equipe EJ",
a dica sozinha não resolveu nem com instrução explícita — a regra `=>` resolveu.

Use a dica para orientar, e a regra `=>` para o que precisa sair certo.

> Detalhe: as dicas são enviadas como frase terminada em ponto. Sem isso o
> modelo imita o estilo e devolve a transcrição inteira sem pontuação.

---

## Formato de saída

Markdown denso, pensado para gastar poucos tokens quando um LLM lê:

```markdown
# Título do vídeo
Fonte: https://www.youtube.com/watch?v=abc123
Método: youtube_manual_captions

[00:00]
Texto corrido do primeiro minuto, sem quebras desnecessárias.

[01:02]
Texto do minuto seguinte.
```

| Decisão | Motivo |
|---|---|
| Cabeçalho de 3 linhas | contexto mínimo, sem desperdiçar tokens |
| Timestamps a cada ~60s | dá para citar `[03:15]` sem poluir o texto |
| Texto corrido entre marcas | densidade máxima |
| Deduplicação linha a linha | a legenda auto-gerada do YouTube é *rolling*: repete |

O campo **Método** registra como aquela transcrição foi obtida
(`youtube_manual_captions`, `local (large-v3/cuda)` ou o modo legado com
`--api`). O arquivo `.metadados.json` também registra modelo, dispositivo,
quantização, cobertura do VAD, intervalos suspeitos e todos os caminhos.

---

## Como funciona internamente

### Rota YouTube (`src/youtube.js`)

1. `yt-dlp` extrai título e duração sem baixar o vídeo
2. Tenta legendas **manuais** (revisadas por humanos)
3. Se não houver: preserva a melhor faixa de áudio e passa para o motor local
4. Legenda automática só é usada no modo legado sem motor local

> Pedindo vários idiomas de uma vez, o `yt-dlp` às vezes baixa `pt` e `en` e
> só então toma `HTTP 429` no terceiro — saindo com código de erro. O programa
> confere os arquivos no disco **depois** do erro e aproveita a legenda que já
> baixou, em vez de descartar tudo e transcrever à toa.

> **Por que a deduplicação é linha a linha, e não por bloco?**
> A legenda auto-gerada do YouTube é *rolling*: cada bloco reexibe as linhas
> do bloco anterior e acrescenta uma nova, para o texto subir na tela.
> Comparar o bloco inteiro com o anterior não descarta nada — a concatenação
> nunca se repete — e o texto final sai com cada frase duplicada ou
> triplicada. Medido aqui, numa live de 2h20: 326 mil caracteres viraram
> 110 mil, sem perder uma frase sequer.

### Rota local (`src/local-whisper.js` + `src/transcricao_local.py`)

1. O Node acha o Python e injeta as DLLs de CUDA no `PATH` do subprocesso
2. O Python carrega o modelo e transcreve, reportando progresso pelo `stderr`
3. Registra confiança, palavras, cobertura e possíveis lacunas do VAD
4. Não refaz trechos automaticamente; a decisão fica visível nos metadados
5. O resultado recebe as correções do vocabulário

Não há extração nem fatiamento de áudio: o faster-whisper lê o vídeo direto
(via PyAV) e processa em janela deslizante, sem limite de tamanho. O `ffmpeg`
continua necessário só para a rota `--api` e para o `yt-dlp`.

> **Por que as DLLs vão no `PATH`, e não via `os.add_dll_directory()`?**
> O CTranslate2 carrega `cublas64_12.dll` com o `LoadLibrary` legado do
> Windows, que só consulta o `%PATH%`. Sem isso a GPU falha com
> `Library cublas64_12.dll is not found` na hora de rodar o encoder — e não
> no carregamento do modelo, o que torna o erro confuso.

### Rota API (`src/arquivo-local.js`) — só com `--api`

1. `ffmpeg` extrai só o áudio: mono, 16 kHz, 64 kbps — leve para enviar
2. Fatia em pedaços de 20 min (a API aceita no máximo 25 MB por envio)
3. O fim de cada pedaço vai como contexto do seguinte, para não perder o fio
   da frase no corte
4. Junta o texto e aplica as correções do vocabulário

**Modelos:** o padrão é `gpt-transcribe`, com fallback automático para
`whisper-1` em áudio cantado. Com `--srt` usa `whisper-1` direto, o único que
devolve os tempos das legendas. *(O motor local devolve tempos sempre.)*

---

## Estrutura do projeto

A raiz só tem o que você usa. O código fica fora do caminho, em `src/`.

```
transcritor/
├── transcrever.bat       # ATALHO — é isso que você digita
├── README.md             # este arquivo
│
├── _inbox/               # FILA: coloque aqui áudio e vídeo ainda não processados
├── _processados/         # um diretório timestampado para cada trabalho concluído
│   ├── .processando/     # área temporária; não conta como concluído
│   └── _falhas/          # diagnóstico e downloads parciais quando algo falha
├── quality/              # corpus humano e avaliação WER/CER
├── videos/               # acervo legado; continua pesquisável pelo nome
├── config/               # O QUE VOCÊ EDITA
│   ├── vocabulario.txt   #   termos e correções de grafia
│   └── links.txt         #   lista de URLs para processar em lote
│
├── .env                  # chave da OpenAI (só p/ --api) — NÃO versionar
├── cookies.txt           # sessão p/ Instagram (opcional) — NÃO versionar
│
├── src/                  # o código (você não precisa mexer)
│   ├── index.js          #   CLI: decide a rota, cuida da fila e dos arquivos
│   ├── youtube.js        #   rota YouTube: legendas + fallback local
│   ├── local-whisper.js  #   MOTOR LOCAL: acha o Python, cuida do CUDA
│   ├── transcricao_local.py # MOTOR LOCAL: faster-whisper de fato
│   ├── fluxo-arquivos.js #   nomenclatura, staging e movimentação segura
│   ├── metricas-qualidade.js # WER, CER e termos críticos
│   ├── arquivo-local.js  #   rota --api: ffmpeg + OpenAI
│   ├── download.js       #   download por link (yt-dlp)
│   ├── vocabulario.js    #   vocabulário compartilhado pelas rotas
│   └── filtrar-cookies.js#   limpeza de segurança do cookies.txt
│
├── versoes/              # snapshots antes de mudanças grandes
└── package.json
```

**A regra é simples:** arquivo entra por `_inbox/`; quando termina, mídia,
transcrição e metadados ficam juntos em `_processados/AAAA-MM-DD-HHmm - nome/`.

### Avaliação de qualidade

O diretório `quality/` contém um manifesto vazio e instruções para montar um
corpus humano. Depois de cadastrar referências e hipóteses:

```bash
npm run quality:evaluate
```

O relatório calcula WER, CER e recuperação de nomes/termos críticos. As
referências precisam ser revisadas por uma pessoa; o programa não fabrica um
"gabarito" usando outro modelo.

---

## Pré-requisitos

| Ferramenta | Para quê | Obrigatória? |
|---|---|---|
| **Node.js 18+** | runtime | sim |
| **Python 3.9+** | roda o motor local | sim |
| **faster-whisper** | a transcrição em si | sim |
| **yt-dlp** | legendas e download de vídeo/áudio | sim |
| **ffmpeg** | usado pelo yt-dlp e pela rota `--api` | sim |
| **GPU NVIDIA + CUDA** | ~10x mais rápido | não |
| **OPENAI_API_KEY** no `.env` | só para `--api` | não |

```bash
npm install
pip install faster-whisper
```

Para usar a GPU NVIDIA, instale também as bibliotecas de CUDA — não precisa do
CUDA Toolkit completo, os pacotes do pip bastam:

```bash
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

O programa acha essas DLLs sozinho. Se a GPU não estiver disponível, ele usa a
CPU sem reclamar.

Apontar um Python específico (venv, por exemplo): variável `PYTHON`.

```env
# .env — opcional, só se você for usar --api
OPENAI_API_KEY=sk-...
```

---

## Custo

**Zero.** Qualquer cenário, qualquer volume:

| Cenário | Custo |
|---|---|
| Vídeo do YouTube com legendas | **$0,00** |
| Lote de 50 vídeos, com ou sem legenda | **$0,00** |
| 1 hora de arquivo local | **$0,00** |
| Qualquer coisa com `--api` | ~$0,36/hora |

O que você gasta é tempo de máquina, não dinheiro. E o áudio nunca sai daqui —
o que importa quando o material é de cliente, consulta ou reunião interna.

---

## Troubleshooting

| Mensagem | O que fazer |
|---|---|
| `yt-dlp: command not found` | `winget install yt-dlp.yt-dlp` |
| `ffmpeg: command not found` | `winget install ffmpeg` e reabrir o terminal |
| `motor local indisponível` | `pip install faster-whisper` |
| `Library cublas64_12.dll is not found` | `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` |
| Está lento demais | conferir se a GPU foi usada: a linha `Motor:` mostra `cuda` ou `cpu` |
| `nada encontrado para "x"` | o programa lista os arquivos disponíveis — confira o nome |
| `yt-dlp saiu com código N` | link privado, apagado ou que exige login — veja cookies abaixo |
| `nenhuma fala reconhecida` | tente explicitamente `--vad off` ou `--lang auto` |
| `OPENAI_API_KEY não configurada` | só afeta `--api`; sem a flag, não é necessária |
| `HTTP 401` | a chave venceu ou foi revogada (só com `--api`) |
| Legenda em idioma errado | `--lang en pt es` para mudar a prioridade |
| Metadados apontam intervalos suspeitos | confira os tempos e decida se vale rodar novamente com `--vad off` |

### A GPU não está sendo usada

A linha `Motor:` no cabeçalho e a linha `Carregando modelo` mostram o que foi
escolhido. Se aparecer `cpu` numa máquina com placa NVIDIA:

```bash
nvidia-smi                                          # a placa aparece?
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12    # bibliotecas do CUDA
node src/index.js arquivo.mp4 --device cuda         # força e mostra o erro real
```

Com `--device cuda` o programa ainda cai para a CPU se a placa falhar, mas
imprime o motivo antes — é assim que você descobre o que está faltando.

### Instagram pedindo login

O Instagram quase sempre exige sessão — mesmo em post público, ele responde
vazio para quem não está logado. Você verá:

```
Instagram sent an empty media response
```

Duas saídas. **A primeira é a recomendada no Windows.**

#### 1. Arquivo `cookies.txt` (funciona sempre)

1. Instale no navegador a extensão **"Get cookies.txt LOCALLY"**
2. Abra o `instagram.com` já logado
3. Exporte e salve como **`cookies.txt`** na raiz do projeto
4. **Rode o filtro** (passo obrigatório — veja o porquê logo abaixo):

```bash
node src/filtrar-cookies.js
```

Pronto — o programa acha o arquivo sozinho, sem precisar de flag:

```bash
node src/index.js https://www.instagram.com/p/ABC123/ --baixar
```

Para guardar em outro lugar: `--cookies C:\caminho\cookies.txt`

##### Por que filtrar é obrigatório

As extensões exportam os cookies de **toda a sua navegação** — banco, e-mail,
gov.br, pagamentos. Um `cookies.txt` cru é o molho de chaves das suas contas
sentado numa pasta de projeto.

O `filtrar-cookies.js` apaga tudo que não for site de vídeo e reescreve o
arquivo. Numa exportação real aqui: **8.002 cookies → 407**, de 1,2 MB para
55 KB, sobrando só `instagram.com`, `facebook.com`, `youtube.com`,
`tiktok.com` e `vimeo.com`.

`google.com` fica de fora de propósito: liberá-lo arrastaria Gmail, Drive e
Photos junto, e o download não precisa disso.

Rode o filtro **toda vez** que reexportar os cookies.

#### 2. Ler direto do navegador

```bash
node src/index.js <url> --baixar --navegador firefox
```

**Use Firefox, logado no Instagram.** Chrome e Edge normalmente **falham no
Windows** — testado nesta máquina:

| Navegador | Resultado |
|---|---|
| Chrome | `Could not copy Chrome cookie database` (o navegador aberto trava o arquivo) |
| Edge | `Failed to decrypt with DPAPI` — Chromium 127+ usa App-Bound Encryption |
| Firefox | lê os cookies normalmente |

> **`cookies.txt` é credencial de acesso à sua conta.** Já está no `.gitignore`.
> Não mande para ninguém e reexporte quando a sessão vencer (o sintoma é o
> download voltar a falhar).

Vale para qualquer site que exija sessão: conteúdo privado, restrito por idade
ou por região.

### Nomes de arquivo com colchetes

Vídeos baixados do YouTube costumam ter o ID entre colchetes
(`... [r8JvNskqqNM].mp4`). No PowerShell, colchetes são curinga: `Move-Item` e
`Copy-Item` **não** acham esses arquivos sem `-LiteralPath`. O programa lida
com isso internamente, mas vale lembrar ao mexer nos arquivos na mão.

---

## Limitações conhecidas

| Limitação | Contorno |
|---|---|
| Vídeos privados ou restritos por região | VPN ou cookies de autenticação no `yt-dlp` |
| Rate limit do YouTube | aguardar alguns minutos |
| Legenda automática de baixa qualidade | o fluxo padrão já prefere o motor local |
| Sem GPU, é lento (~1x tempo real) | deixar rodando, ou `--api` quando houver pressa |
| O modelo carrega a cada arquivo (~7 s) | irrelevante em vídeo longo; pesa em lote de clipes curtos |
| VAD pode não detectar canto/fala baixa | verifique os metadados e rode explicitamente com `--vad off` |
| Sem identificação de quem fala | o `faster-whisper` não faz diarização |
