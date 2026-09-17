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

### Baixar um vídeo

```bash
node src/index.js https://www.instagram.com/reel/abc123/ --baixar
node src/index.js https://www.youtube.com/watch?v=abc123 --baixar
```

O arquivo vai para `videos/`. Funciona com YouTube, Instagram, TikTok, Facebook
e os [outros sites que o yt-dlp suporta](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).
Se o vídeo já estiver lá, ele avisa em vez de baixar de novo.

### Transcrever

```bash
# YouTube: usa as legendas do próprio site — instantâneo
node src/index.js https://www.youtube.com/watch?v=abc123

# Instagram, TikTok e afins: baixa o áudio e transcreve na sua máquina
node src/index.js https://www.instagram.com/reel/abc123/

# Arquivo local: chame por um pedaço do nome
node src/index.js whatsapp
node src/index.js energia --srt

# Tudo que está em videos/ e ainda não foi transcrito
node src/index.js

# Lote de links
node src/index.js --file links.txt --concat
```

No Windows há também o atalho `transcrever.bat` — no PowerShell use `.\transcrever`,
no cmd basta `transcrever`. As saídas vão para `transcricoes/`.

---

## As rotas

O programa detecta o tipo de entrada e decide sozinho. **Tudo custa zero:**

| Você passa | Rota | Velocidade |
|---|---|---|
| URL do YouTube | legendas do próprio YouTube via `yt-dlp` | instantâneo |
| URL do YouTube sem legendas | baixa o áudio e transcreve na sua máquina | ~10x tempo real¹ |
| URL de outro site (Instagram, TikTok…) | baixa o áudio e transcreve na sua máquina | ~10x tempo real¹ |
| Arquivo local (`.mp4`, `.mp3`…) | transcreve na sua máquina | ~10x tempo real¹ |
| Qualquer URL + `--baixar` | só baixa o vídeo, não transcreve | — |

¹ Com GPU NVIDIA. Sem GPU, aproximadamente 1x — uma hora de vídeo leva uma
hora. Veja [O motor local](#o-motor-local).

> **Se o vídeo está no YouTube, passe a URL** — não baixe o arquivo antes.
> A legenda pronta sai na hora; pelo arquivo você espera a transcrição rodar.

Quando a legenda do YouTube for ruim (auto-gerada costuma vir sem pontuação e
com repetições), force o motor local com `--refazer`.

### Baixar e transcrever

São dois passos, de propósito — assim você fica com o arquivo *e* o texto:

```bash
node src/index.js https://www.instagram.com/reel/abc123/ --baixar
node src/index.js                # transcreve o que acabou de cair em videos/
```

---

## Opções

| Opção | O que faz |
|---|---|
| `--baixar` | baixa o vídeo para `videos/` em vez de transcrever |
| `--cookies <arquivo>` | cookies para sites que exigem login (padrão: `cookies.txt` da pasta) |
| `--navegador <nome>` | lê os cookies do navegador — use `firefox` |
| `-f, --file <arquivo>` | arquivo `.txt` com uma URL por linha |
| `-o, --output <pasta>` | pasta de saída (padrão: `transcricoes/`) |
| `-l, --lang <idiomas...>` | idiomas (padrão: `pt pt-BR en es`; use `auto` para detectar) |
| `--srt` | gera também legenda `.srt` com marcação de tempo |
| `--forcar` | refaz transcrições que já existem |
| `--stdout` | imprime no terminal em vez de salvar |
| `--concat` | junta todas as transcrições num arquivo único |
| `-h, --help` | mostra a ajuda |

### Motor de transcrição

| Opção | O que faz |
|---|---|
| `--modelo <nome>` | modelo local (padrão: `large-v3-turbo`); veja a tabela abaixo |
| `--device <alvo>` | `auto`, `cuda` ou `cpu` (padrão: `auto`) |
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
— o Whisper da OpenAI reimplementado em CTranslate2, rodando na sua máquina.
O mesmo modelo que a API usa, só que local.

### Modelos

O padrão é **`large-v3-turbo`**: qualidade de `large-v3` e cerca de 3x mais
rápido. Trocar só faz sentido em máquina fraca — e sai caro em qualidade.

| Modelo | Disco | Qualidade |
|---|---|---|
| `large-v3-turbo` **(padrão)** | ~1,6 GB | igual à API |
| `large-v3` | ~3,1 GB | igual, porém ~3x mais lento |
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

O detector de voz (VAD) acelera a transcrição pulando trechos sem fala, mas
classifica **canto como silêncio** e devolveria texto vazio. Quando isso
acontece, o programa refaz sem o VAD sozinho e a música sai transcrita.

Isso é uma vantagem sobre a API: o `gpt-transcribe` simplesmente devolve vazio
para áudio cantado.

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
| Deduplicação de segmentos | legendas auto-geradas do YouTube repetem frases |

O campo **Método** registra como aquela transcrição foi obtida
(`youtube_manual_captions`, `youtube_auto_captions`,
`local (large-v3-turbo/cuda)`, `arquivo_local (gpt-transcribe)` com `--api`).

---

## Como funciona internamente

### Rota YouTube (`src/youtube.js`)

1. `yt-dlp` extrai título e duração sem baixar o vídeo
2. Tenta legendas **manuais** (revisadas por humanos)
3. Tenta legendas **auto-geradas**
4. Se não houver nenhuma: baixa só o áudio e passa para o motor local

> Pedindo vários idiomas de uma vez, o `yt-dlp` às vezes baixa `pt` e `en` e
> só então toma `HTTP 429` no terceiro — saindo com código de erro. O programa
> confere os arquivos no disco **depois** do erro e aproveita a legenda que já
> baixou, em vez de descartar tudo e transcrever à toa.

### Rota local (`src/local-whisper.js` + `src/transcricao_local.py`)

1. O Node acha o Python e injeta as DLLs de CUDA no `PATH` do subprocesso
2. O Python carrega o modelo e transcreve, reportando progresso pelo `stderr`
3. Sem fala detectada? Refaz sem VAD (áudio cantado)
4. O resultado volta como JSON e recebe as correções do vocabulário

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
├── videos/               # ENTRADA: largue os vídeos aqui
├── transcricoes/         # SAÍDA: os .md e .srt saem aqui
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
│   ├── arquivo-local.js  #   rota --api: ffmpeg + OpenAI
│   ├── download.js       #   download por link (yt-dlp)
│   ├── vocabulario.js    #   vocabulário compartilhado pelas rotas
│   └── filtrar-cookies.js#   limpeza de segurança do cookies.txt
│
├── versoes/              # snapshots antes de mudanças grandes
└── package.json
```

**A regra é simples:** vídeo entra por `videos/`, texto sai em `transcricoes/`,
e o que você ajusta está em `config/`.

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
| `nenhuma fala reconhecida` | o arquivo pode não ter fala; tente `--lang auto` |
| `OPENAI_API_KEY não configurada` | só afeta `--api`; sem a flag, não é necessária |
| `HTTP 401` | a chave venceu ou foi revogada (só com `--api`) |
| Legenda em idioma errado | `--lang en pt es` para mudar a prioridade |
| Saída com texto duplicado | comum em legenda auto-gerada; use `--refazer` |

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
| Legenda auto-gerada de baixa qualidade | `--refazer` transcreve o áudio localmente |
| Sem GPU, é lento (~1x tempo real) | deixar rodando, ou `--api` quando houver pressa |
| O modelo carrega a cada arquivo (~7 s) | irrelevante em vídeo longo; pesa em lote de clipes curtos |
| VAD não detecta canto | tratado: refaz sozinho sem VAD |
| Sem identificação de quem fala | o `faster-whisper` não faz diarização |
