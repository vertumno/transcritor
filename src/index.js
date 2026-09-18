#!/usr/bin/env node

/**
 * Transcritor - CLI unificada
 *
 * Aceita as duas coisas e organiza cada processamento como um trabalho:
 *   - URL do YouTube  -> legendas do próprio YouTube (custo zero)
 *   - arquivo local   -> motor local (vídeo do WhatsApp, aula gravada, áudio)
 *
 * Uso:
 *   node index.js <url>                  # vídeo do YouTube
 *   node index.js video.mp4              # arquivo local
 *   node index.js energia                # busca pelo trecho do nome em _inbox/
 *   node index.js                        # transcreve todos os arquivos da _inbox/
 *   node index.js --file links.txt       # lote de URLs
 */

const path = require("path");

// A raiz do projeto é um nível acima: o código mora em src/
const ROOT_DIR = path.join(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT_DIR, ".env") });
const fs = require("fs");
const os = require("os");
const { transcribe } = require("./youtube");
const { transcribeLocal, isMediaFile } = require("./arquivo-local");
const {
  transcribeLocalWhisper,
  motorLocalDisponivel,
  MODELO_PADRAO,
  MODELO_RAPIDO,
} = require("./local-whisper");
const { loadVocabulary, applyFixesToResult } = require("./vocabulario");
const {
  formatarDataHora,
  caminhoArquivoUnico,
  estaDentro,
  moverArquivo,
  criarTrabalho,
} = require("./fluxo-arquivos");
const {
  downloadVideo,
  downloadAudio,
  getTitle,
  getMetadata,
  readCaption,
  isUrl,
  isYouTubeUrl,
} = require("./download");

const BASE_DIR = ROOT_DIR;
const VIDEOS_DIR = path.join(ROOT_DIR, "videos");
const INBOX_DIR = path.join(ROOT_DIR, "_inbox");
const PROCESSED_DIR = path.join(ROOT_DIR, "_processados");
const CONFIG_DIR = path.join(ROOT_DIR, "config");

/**
 * Classifica cada alvo da linha de comando:
 *   youtube -> tem legenda de graça
 *   link    -> qualquer outro site (Instagram, TikTok...): baixa o áudio
 *   local   -> arquivo no disco
 */
function classifyTarget(target) {
  if (isYouTubeUrl(target)) return "youtube";
  if (isUrl(target)) return "link";
  return "local";
}

/** Lista mídias nas pastas informadas; videos/ continua como acervo legado. */
function listLocalMedia(dirs = [INBOX_DIR]) {
  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile() && isMediaFile(full)) found.push(full);
    }
  }
  return found;
}

/**
 * Resolve um argumento local: caminho direto ou trecho do nome do arquivo.
 */
function resolveLocalTarget(target) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    return [path.resolve(target)];
  }

  const candidates = listLocalMedia([INBOX_DIR, VIDEOS_DIR, BASE_DIR]);
  const needle = target.toLowerCase();
  const matches = candidates.filter((p) =>
    path.basename(p).toLowerCase().includes(needle)
  );

  if (matches.length === 0) {
    const disponiveis =
      candidates.map((p) => "  " + path.basename(p)).join("\n") ||
      "  (nenhum arquivo de vídeo/áudio encontrado)";
    throw new Error(
      `nada encontrado para "${target}".\nArquivos disponíveis:\n${disponiveis}`
    );
  }
  return matches;
}

function formatTimestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n, size = 2) => String(n).padStart(size, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

function buildSRT(segments) {
  const blocks = [];
  let index = 1;
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) continue;
    const start = formatTimestamp(seg.start);
    const end = formatTimestamp(seg.start + seg.duration);
    blocks.push(`${index}\n${start} --> ${end}\n${text}\n`);
    index++;
  }
  return blocks.join("\n");
}

/** Monta o .md no mesmo formato usado pela rota do YouTube. */
function formatLocal(title, sourcePath, result, caption = "") {
  const lines = [`# ${title}`, `Fonte: ${sourcePath}`, `Método: ${result.source}`, ""];

  // A legenda do post é o texto escrito pelo autor — vale tanto quanto a fala
  if (caption) {
    lines.push("## Legenda do post", "", caption, "", "## Transcrição do áudio", "");
  }

  const segments = result.segments || [];
  if (segments.length === 0) {
    lines.push(result.text);
    return lines.join("\n");
  }

  let block = [];
  let lastStamp = -60;
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) continue;
    if (seg.start - lastStamp >= 60) {
      if (block.length > 0) {
        lines.push(block.join(" "));
        block = [];
      }
      const m = Math.floor(seg.start / 60);
      const s = Math.floor(seg.start % 60);
      lines.push("");
      lines.push(`[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`);
      lastStamp = seg.start;
    }
    block.push(text);
  }
  if (block.length > 0) lines.push(block.join(" "));

  return lines.join("\n");
}

function normalizarIdiomaLocal(language) {
  const value = (language || "pt").trim();
  if (/^pt[-_]br$/i.test(value) || /^pt[-_]pt$/i.test(value)) return "pt";
  return value;
}

/**
 * Escolhe quem transcreve um arquivo de mídia.
 *
 * O padrão é o motor local (sem custo, sem enviar seu áudio para fora).
 * A API só entra quando o usuário pede explicitamente com --api.
 */
function transcreverMidia(caminho, { args, vocabulary, apiKey }) {
  if (args.api) {
    return transcribeLocal(caminho, {
      apiKey,
      language: args.lang[0] || "pt",
      wantSegments: args.srt,
      vocabularyPrompt: vocabulary.prompt,
    });
  }

  return transcribeLocalWhisper(caminho, {
    modelo: args.modelo,
    language: normalizarIdiomaLocal(args.lang[0]),
    device: args.device,
    compute: args.compute,
    perfil: args.perfil,
    vad: args.vad,
    vocabularyPrompt: vocabulary.prompt,
  });
}

function parseArgs(argv) {
  const args = {
    targets: [],
    file: null,
    output: PROCESSED_DIR,
    lang: ["pt", "pt-BR", "en", "es"],
    apiKey: null,
    stdout: false,
    concat: false,
    srt: false,
    force: false,
    download: false,
    cookies: null,
    browser: null,
    api: false,
    modelo: null,
    device: "auto",
    compute: "auto",
    perfil: "qualidade",
    vad: "auto",
    refazer: false,
    help: false,
  };

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--file" || arg === "-f") args.file = argv[++i];
    else if (arg === "--output" || arg === "-o") args.output = argv[++i];
    else if (arg === "--lang" || arg === "-l") {
      args.lang = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        args.lang.push(argv[++i]);
      }
    } else if (arg === "--api-key") args.apiKey = argv[++i];
    else if (arg === "--stdout") args.stdout = true;
    else if (arg === "--concat") args.concat = true;
    else if (arg === "--srt") args.srt = true;
    else if (arg === "--forcar" || arg === "--force") args.force = true;
    else if (arg === "--baixar" || arg === "--download") args.download = true;
    else if (arg === "--cookies") args.cookies = argv[++i];
    else if (arg === "--navegador" || arg === "--browser") args.browser = argv[++i];
    else if (arg === "--api") args.api = true;
    else if (arg === "--modelo" || arg === "--model") args.modelo = argv[++i];
    else if (arg === "--device" || arg === "--dispositivo") args.device = argv[++i];
    else if (arg === "--compute") args.compute = argv[++i];
    else if (arg === "--perfil") args.perfil = argv[++i];
    else if (arg === "--vad") args.vad = argv[++i];
    else if (arg === "--refazer") args.refazer = true;
    else if (!arg.startsWith("-")) args.targets.push(arg);
    i++;
  }
  if (!args.modelo) {
    args.modelo = args.perfil === "rapido" ? MODELO_RAPIDO : MODELO_PADRAO;
  }
  if (!['qualidade', 'rapido'].includes(args.perfil)) {
    throw new Error("--perfil deve ser qualidade ou rapido");
  }
  if (!['auto', 'on', 'off'].includes(args.vad)) {
    throw new Error("--vad deve ser auto, on ou off");
  }
  return args;
}

function showHelp() {
  console.log(`
Transcritor - baixa e transcreve vídeos

Uso:
  node index.js <url|arquivo|trecho do nome> [...] [opções]
  node index.js                       Processa tudo que estiver em _inbox/
  node index.js <url>                 Baixa o áudio e transcreve localmente
  node index.js <url> --baixar        Só baixa o vídeo para _processados/
  node index.js <arquivo>             Só transcreve o arquivo local

Opções:
      --baixar             Baixa o vídeo e organiza em _processados/
      --cookies <arquivo>  Cookies para sites que exigem login
      --navegador <nome>   Pega os cookies do navegador (firefox recomendado)
  -f, --file <arquivo>     Arquivo .txt com uma URL por linha
  -o, --output <pasta>     Raiz dos trabalhos (padrão: _processados/)
  -l, --lang <idiomas...>  Idiomas (padrão: pt pt-BR en es; use auto p/ detectar)
      --srt                Gera também legenda .srt com marcação de tempo
      --forcar             Mantido por compatibilidade; cada execução cria uma versão
      --stdout             Imprime no terminal em vez de salvar
      --concat             Junta todas as transcrições num arquivo único
  -h, --help               Mostra esta ajuda

Motor de transcrição (padrão: local, custo zero):
      --perfil <nome>      qualidade | rapido (padrão: qualidade)
      --modelo <nome>      Sobrescreve o modelo do perfil (padrão: ${MODELO_PADRAO})
      --compute <tipo>     auto | float16 | int8_float16 | int8
      --device <alvo>      auto | cuda | cpu (padrão: auto)
      --vad <modo>         auto | on | off (padrão: auto)
      --refazer            No YouTube, ignora a legenda pronta e transcreve
                           o áudio localmente (melhor que legenda auto-gerada)
      --api                Usa a API da OpenAI em vez do motor local (pago)
      --api-key <chave>    OpenAI API key (ou OPENAI_API_KEY no .env)

Exemplos:
  node index.js https://instagram.com/reel/abc --baixar   # baixa o vídeo
  node index.js https://youtube.com/watch?v=abc123        # grátis, via legendas
  node index.js https://instagram.com/reel/abc            # transcreve o reel
  node index.js                                             # processa a _inbox
  node index.js "WhatsApp Video.mp4"                      # arquivo local
  node index.js energia --srt                             # busca nome + legenda
  node index.js --file links.txt --concat                 # lote de URLs

Rotas (escolhidas sozinho):
  URL do YouTube   -> legenda humana; senão transcreve local
  Outro site       -> baixa o áudio e transcreve na sua máquina
  Arquivo local    -> transcreve na sua máquina (faster-whisper)

Modos:
  Só baixar             URL + --baixar
  Baixar e transcrever  URL sem --baixar
  Só transcrever        arquivo local ou conteúdo da _inbox

Cada item gera _processados/AAAA-MM-DD-HHmm - nome/ com mídia, texto e metadados.
Arquivos da _inbox só são movidos depois da transcrição terminar com sucesso.
Tudo roda localmente e de graça. Seu áudio não sai da máquina.
Com --api o comportamento antigo volta (gpt-transcribe + whisper-1).

Vocabulário:
  Edite vocabulario.txt para corrigir nomes e siglas em todas as rotas.
`);
}

async function main() {
  const args = parseArgs(process.argv);

  fs.mkdirSync(INBOX_DIR, { recursive: true });

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // URLs vindas de um arquivo de links
  if (args.file) {
    // Aceita caminho direto ou só o nome, procurando em config/
    const candidatos = [args.file, path.join(CONFIG_DIR, args.file)];
    const encontrado = candidatos.find((c) => fs.existsSync(c));

    if (!encontrado) {
      console.error(`Erro: arquivo '${args.file}' não encontrado.`);
      console.error(`Procurei em: ${candidatos.join(" e ")}`);
      process.exit(1);
    }
    args.file = encontrado;

    for (const line of fs.readFileSync(args.file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) args.targets.push(trimmed);
    }
  }

  // Monta a fila: cada item sabe se é URL do YouTube ou arquivo local
  const queue = [];
  if (args.targets.length === 0) {
    // Sem alvo: a _inbox é a fila. Ao concluir, o arquivo sai dela.
    for (const file of listLocalMedia([INBOX_DIR])) {
      queue.push({ kind: "local", value: file });
    }
    if (queue.length === 0) {
      showHelp();
      console.log(`Dica: coloque seus vídeos ou áudios em ${INBOX_DIR}\n`);
      process.exit(1);
    }
  } else {
    for (const target of args.targets) {
      const kind = classifyTarget(target);
      if (kind === "local") {
        try {
          for (const file of resolveLocalTarget(target)) {
            queue.push({ kind: "local", value: file });
          }
        } catch (err) {
          console.error(`Erro: ${err.message}`);
          process.exit(1);
        }
      } else {
        queue.push({ kind, value: target });
      }
    }
  }

  if (!args.stdout) fs.mkdirSync(args.output, { recursive: true });

  const vocabulary = loadVocabulary(CONFIG_DIR);
  const apiKey = args.apiKey || process.env.OPENAI_API_KEY;
  const authOptions = {
    cookiesFile: args.cookies,
    browser: args.browser,
    baseDir: BASE_DIR,
  };
  const all = [];
  let success = 0;
  let failed = 0;
  let skipped = 0;

  // Sem --api o motor é local; avisa cedo se ele não estiver instalado,
  // em vez de deixar cada item da fila falhar com o mesmo erro
  if (!args.api && !args.download && !motorLocalDisponivel()) {
    console.error(
      "\nErro: motor local indisponível - não encontrei Python com faster-whisper.\n" +
        "  Instale com: pip install faster-whisper\n" +
        "  Ou use a API com --api (precisa de OPENAI_API_KEY).\n"
    );
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Transcritor`);
  console.log(`  ${queue.length} item(ns) na fila`);
  if (!args.download) {
    console.log(
      args.api
        ? `  Motor: API da OpenAI (pago)`
        : `  Motor: local - perfil ${args.perfil}, ${args.modelo} (${args.device}), custo zero`
    );
  }
  if (vocabulary.fixes.length > 0) {
    console.log(`  Vocabulário: ${vocabulary.fixes.length} correção(ões) ativa(s)`);
  }
  console.log(`${"=".repeat(60)}\n`);

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const label = item.kind === "local" ? path.basename(item.value) : item.value;
    console.log(`[${i + 1}/${queue.length}] ${label}`);

    let job = null;

    try {
      let title;
      let formatted;
      let result;
      let archivedMedia = null;
      let caption = "";
      let metadataSource = {};

      // --baixar: cria um trabalho organizado apenas com vídeo e metadados.
      if (args.download) {
        if (item.kind === "local") {
          console.log(`  Já é um arquivo local, nada a baixar\n`);
          skipped++;
          continue;
        }
        const meta = getMetadata(item.value, authOptions);
        job = criarTrabalho(args.output, meta.title);
        const { filePath: saved, captionPath } = downloadVideo(
          item.value,
          job.stagingDir,
          { ...authOptions, meta }
        );
        const archivedVideo = job.archiveMedia(saved);
        let archivedCaption = null;
        if (captionPath && fs.existsSync(captionPath)) {
          archivedCaption = moverArquivo(captionPath, job.file(".legenda.txt"));
        }
        fs.writeFileSync(
          job.file(".metadados.json"),
          JSON.stringify(
            {
              schemaVersion: 1,
              processedAt: new Date().toISOString(),
              job: job.baseName,
              title: meta.title,
              mode: "download_only",
              input: {
                kind: item.kind,
                url: item.value,
                uploader: meta.uploader,
                id: meta.id,
              },
              outputs: {
                video: path.join(job.finalDir, path.basename(archivedVideo)),
                caption: archivedCaption ? job.finalFile(".legenda.txt") : null,
              },
            },
            null,
            2
          ) + "\n",
          "utf-8"
        );
        const completedDir = job.complete();
        console.log(`  Download concluído em: ${completedDir}`);
        success++;
        continue;
      }

      if (item.kind === "link") {
        // Site sem legenda pronta (Instagram, TikTok...): preserva o melhor áudio.
        const meta = getMetadata(item.value, authOptions);
        title = meta.title;
        console.log(`  Título: ${title}`);
        if (meta.caption) console.log("  Legenda do post capturada");
        job = args.stdout ? null : criarTrabalho(args.output, title);
        const workDir = job
          ? job.stagingDir
          : fs.mkdtempSync(path.join(os.tmpdir(), "baixar-"));
        try {
          const audioPath = downloadAudio(item.value, workDir, authOptions);
          const raw = await transcreverMidia(audioPath, { args, vocabulary, apiKey });
          result = applyFixesToResult(raw, vocabulary.fixes);
          caption = meta.caption;
          formatted = formatLocal(title, item.value, result, caption);
          if (job) archivedMedia = job.archiveMedia(audioPath);
          console.log(`  OK - ${result.source}`);
        } finally {
          if (!job) fs.rmSync(workDir, { recursive: true, force: true });
        }
        metadataSource = { url: item.value, uploader: meta.uploader, id: meta.id };
      } else if (item.kind === "youtube") {
        const meta = getMetadata(item.value, authOptions);
        title = meta.title;
        job = args.stdout ? null : criarTrabalho(args.output, title);
        const data = await transcribe(item.value, {
          apiKey,
          languages: args.lang,
          // Sem --api, vídeo sem legenda cai no motor local em vez da API
          motorAudio: args.api
            ? null
              : (audioPath) => transcreverMidia(audioPath, { args, vocabulary, apiKey }),
          ignorarLegendas: args.refazer,
          audioDir: job ? job.stagingDir : null,
        });
        title = data.title;
        result = applyFixesToResult(data.result, vocabulary.fixes);
        formatted = require("./youtube").formatForLLM(title, data.url, result);
        if (job && data.mediaPath) archivedMedia = job.archiveMedia(data.mediaPath);
        metadataSource = { url: data.url, videoId: data.videoId };
      } else {
        title = path.basename(item.value, path.extname(item.value));
        job = args.stdout ? null : criarTrabalho(args.output, title);
        const raw = await transcreverMidia(item.value, { args, vocabulary, apiKey });
        result = applyFixesToResult(raw, vocabulary.fixes);

        // Se o vídeo veio de um link, a legenda do post foi salva ao lado dele
        caption = readCaption(item.value);
        if (caption) console.log("  Legenda do post encontrada");

        const sourceForDocument =
          job && estaDentro(item.value, INBOX_DIR)
            ? job.finalFile(path.extname(item.value))
            : item.value;
        formatted = formatLocal(title, sourceForDocument, result, caption);
        metadataSource = { originalPath: path.resolve(item.value) };
        console.log(`  OK - ${result.source}`);
      }

      if (args.stdout) {
        console.log("\n" + formatted);
        if (i < queue.length - 1) console.log("\n---\n");
      } else {
        const filepath = job.file(".md");
        fs.writeFileSync(filepath, formatted, "utf-8");

        if (args.srt && result.segments && result.segments.length > 0) {
          const srtPath = job.file(".srt");
          fs.writeFileSync(srtPath, buildSRT(result.segments), "utf-8");
        }

        if (caption) {
          fs.writeFileSync(job.file(".legenda.txt"), caption + "\n", "utf-8");
        }

        // A mídia da _inbox só sai da fila depois que a transcrição e seus
        // derivados foram gravados com sucesso.
        if (item.kind === "local" && estaDentro(item.value, INBOX_DIR)) {
          archivedMedia = job.archiveMedia(item.value);
          const captionPath = item.value.replace(/\.[^.]+$/, "") + ".legenda.txt";
          if (fs.existsSync(captionPath)) {
            moverArquivo(captionPath, job.file(".legenda-original.txt"));
          }
        }

        const finalMedia = archivedMedia
          ? path.join(job.finalDir, path.basename(archivedMedia))
          : null;
        const metadata = {
          schemaVersion: 1,
          processedAt: new Date().toISOString(),
          job: job.baseName,
          title,
          input: { kind: item.kind, value: item.value, ...metadataSource },
          archivedMedia: finalMedia,
          transcription: {
            source: result.source,
            model: result.model || null,
            device: result.device || null,
            compute: result.compute || null,
            profile: result.profile || args.perfil,
            language: result.language || normalizarIdiomaLocal(args.lang[0]),
            duration: result.duration || null,
            durationAfterVad: result.duration_after_vad || null,
            vadCoverage: result.vad_coverage ?? null,
            diagnostics: result.diagnostics || null,
          },
          vocabulary: {
            fixes: vocabulary.fixes.length,
            promptEnabled: Boolean(vocabulary.prompt),
          },
          outputs: {
            markdown: job.finalFile(".md"),
            srt: args.srt ? job.finalFile(".srt") : null,
            caption: caption ? job.finalFile(".legenda.txt") : null,
          },
        };
        fs.writeFileSync(
          job.file(".metadados.json"),
          JSON.stringify(metadata, null, 2) + "\n",
          "utf-8"
        );

        const completedDir = job.complete();
        console.log(`  Trabalho concluído em: ${completedDir}`);
      }

      all.push(formatted);
      success++;
    } catch (err) {
      console.error(`  ERRO: ${err.message}`);
      if (job) {
        try {
          const failureDir = job.fail(err);
          if (failureDir) console.error(`  Diagnóstico preservado em: ${failureDir}`);
        } catch (archiveError) {
          console.error(`  Não foi possível preservar a falha: ${archiveError.message}`);
        }
      }
      failed++;
    }

    console.log();
  }

  if (args.concat && !args.stdout && all.length > 1) {
    const concatPath = caminhoArquivoUnico(
      args.output,
      `${formatarDataHora()} - todas transcricoes.md`
    );
    fs.writeFileSync(concatPath, all.join("\n\n---\n\n"), "utf-8");
    console.log(`Concatenado em: ${concatPath}`);
  }

  console.log(`${"=".repeat(60)}`);
  console.log(
    `  Concluído: ${success} ok, ${failed} falha(s)` +
      (skipped > 0 ? `, ${skipped} pulado(s)` : "")
  );
  if (!args.stdout && success > 0) {
    console.log(`  Arquivos em: ${path.resolve(args.output)}/`);
  }
  console.log(`${"=".repeat(60)}`);

  process.exit(failed > 0 && success === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Erro fatal: ${err.message}`);
  process.exit(1);
});
