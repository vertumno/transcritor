# Transcritor

Baixa e transcreve vídeos. Você passa o que tem — link do YouTube, link do
Instagram ou arquivo no disco — e ele escolhe sozinho a rota mais barata.

---

## Índice

- [Uso rápido](#uso-rápido)
- [As duas rotas](#as-duas-rotas)
- [Opções](#opções)
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
# YouTube: usa as legendas do próprio site — custo zero
node src/index.js https://www.youtube.com/watch?v=abc123

# Instagram, TikTok e afins: baixa o áudio e transcreve
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

O programa detecta o tipo de entrada e decide sozinho:

| Você passa | Rota | Custo |
|---|---|---|
| URL do YouTube | legendas do próprio YouTube via `yt-dlp` | **zero** |
| URL do YouTube sem legendas | baixa o áudio e manda para a API | ~$0,006/min |
| URL de outro site (Instagram, TikTok…) | baixa o áudio e manda para a API | ~$0,006/min |
| Arquivo local (`.mp4`, `.mp3`…) | API da OpenAI | ~$0,006/min |
| Qualquer URL + `--baixar` | só baixa o vídeo, não transcreve | **zero** |

> **Se o vídeo está no YouTube, passe a URL** — não baixe o arquivo antes.
> Pela URL o custo tende a zero; pelo arquivo você paga a transcrição.

Arquivos locais e links fora do YouTube sempre usam a API: não existe legenda
pronta para o reel do Instagram nem para o vídeo que veio do WhatsApp.

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
| `--api-key <chave>` | chave da OpenAI (ou `OPENAI_API_KEY` no `.env`) |
| `--stdout` | imprime no terminal em vez de salvar |
| `--concat` | junta todas as transcrições num arquivo único |
| `-h, --help` | mostra a ajuda |

```bash
node src/index.js url --stdout | clip          # copia direto para o clipboard
node src/index.js url --stdout > saida.md      # redireciona para arquivo
```

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
(`youtube_manual_captions`, `youtube_auto_captions`, `whisper_api`,
`arquivo_local (gpt-transcribe)`).

---

## Como funciona internamente

### Rota YouTube (`src/youtube.js`)

1. `yt-dlp` extrai título e duração sem baixar o vídeo
2. Tenta legendas **manuais** (revisadas por humanos)
3. Tenta legendas **auto-geradas**
4. Se não houver nenhuma: baixa o áudio e manda para a Whisper API,
   fatiando em blocos de 10 min se passar de 25 MB

### Rota local (`src/arquivo-local.js`)

1. `ffmpeg` extrai só o áudio: mono, 16 kHz, 64 kbps — leve para enviar
2. Fatia em pedaços de 20 min (a API aceita no máximo 25 MB por envio)
3. O fim de cada pedaço vai como contexto do seguinte, para não perder o fio
   da frase no corte
4. Junta o texto e aplica as correções do vocabulário

**Modelos:** o padrão é `gpt-transcribe`, o mais preciso para fala. Ele **não
transcreve áudio cantado** — devolve texto vazio. Quando isso acontece, o
programa cai sozinho no `whisper-1`, que dá conta de música. Com `--srt` usa
`whisper-1` direto, o único que devolve os tempos das legendas.

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
├── .env                  # sua chave da OpenAI — NÃO versionar
├── cookies.txt           # sessão p/ Instagram (opcional) — NÃO versionar
│
├── src/                  # o código (você não precisa mexer)
│   ├── index.js          #   CLI: decide a rota, cuida da fila e dos arquivos
│   ├── youtube.js        #   rota YouTube: legendas + fallback Whisper
│   ├── arquivo-local.js  #   rota local: ffmpeg + API
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

| Ferramenta | Para quê |
|---|---|
| **Node.js 18+** | runtime |
| **yt-dlp** | legendas e download de áudio do YouTube |
| **ffmpeg** | extração e fatiamento de áudio |
| **OPENAI_API_KEY** no `.env` | arquivos locais e vídeos sem legenda |

```bash
npm install
```

```env
# .env
OPENAI_API_KEY=sk-...
```

---

## Custo

| Cenário | Custo |
|---|---|
| Vídeo do YouTube com legendas | **$0,00** |
| Lote de 50 vídeos com legendas | **$0,00** |
| 10 min via API (local ou sem legenda) | ~$0,06 |
| 1 hora via API | ~$0,36 |

---

## Troubleshooting

| Mensagem | O que fazer |
|---|---|
| `yt-dlp: command not found` | `winget install yt-dlp.yt-dlp` |
| `ffmpeg: command not found` | `winget install ffmpeg` e reabrir o terminal |
| `OPENAI_API_KEY não configurada` | conferir o `.env` |
| `nada encontrado para "x"` | o programa lista os arquivos disponíveis — confira o nome |
| `yt-dlp saiu com código N` | link privado, apagado ou que exige login — veja cookies abaixo |
| `nenhuma fala reconhecida` | o arquivo pode não ter fala; tente `--lang auto` |
| `HTTP 401` | a chave venceu ou foi revogada |
| Legenda em idioma errado | `--lang en pt es` para mudar a prioridade |
| Saída com texto duplicado | comum em legenda auto-gerada; force a API baixando o áudio |

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
| Legenda auto-gerada de baixa qualidade | apagar e refazer forçando a API |
| `gpt-transcribe` não transcreve canto | tratado: fallback automático para `whisper-1` |
| Sem identificação de quem fala | a OpenAI tem `gpt-4o-transcribe-diarize`; não integrado |
