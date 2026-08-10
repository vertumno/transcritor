#!/usr/bin/env node

/**
 * Transcritor - CLI unificada
 *
 * Aceita as duas coisas e escolhe sozinho a rota mais barata:
 *   - URL do YouTube  -> legendas do próprio YouTube (custo zero)
 *   - arquivo local   -> API da OpenAI (vídeo do WhatsApp, aula gravada, áudio)
 *
 * Uso:
 *   node index.js <url>                  # vídeo do YouTube
 *   node index.js video.mp4              # arquivo local
 *   node index.js energia                # busca pelo trecho do nome em videos/
 *   node index.js                        # transcreve tudo que falta em videos/
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
const { loadVocabulary, applyFixesToResult } = require("./vocabulario");
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
const CONFIG_DIR = path.join(ROOT_DIR, "config");

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 100);
}

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

/** Lista os arquivos de mídia de videos/ e da raiz do projeto. */
function listLocalMedia() {
  const dirs = [VIDEOS_DIR, BASE_DIR];
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

  const candidates = listLocalMedia();
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

function parseArgs(argv) {
  const args = {
    targets: [],
    file: null,
    output: path.join(ROOT_DIR, "transcricoes"),
    lang: ["pt", "pt-BR", "en", "es"],
    apiKey: null,
    stdout: false,
    concat: false,
    srt: false,
    force: false,
    download: false,
    cookies: null,
    browser: null,
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
    else if (!arg.startsWith("-")) args.targets.push(arg);
    i++;
  }
  return args;
}

function showHelp() {
  console.log(`
Transcritor - baixa e transcreve vídeos

Uso:
  node index.js <url|arquivo|trecho do nome> [...] [opções]
  node index.js                       Transcreve tudo que falta em videos/
  node index.js <url> --baixar        Só baixa o vídeo para videos/

Opções:
      --baixar             Baixa o vídeo (YouTube, Instagram, TikTok...)
      --cookies <arquivo>  Cookies para sites que exigem login
      --navegador <nome>   Pega os cookies do navegador (firefox recomendado)
  -f, --file <arquivo>     Arquivo .txt com uma URL por linha
  -o, --output <pasta>     Pasta de saída (padrão: output/)
  -l, --lang <idiomas...>  Idiomas (padrão: pt pt-BR en es; use auto p/ detectar)
      --srt                Gera também legenda .srt com marcação de tempo
      --forcar             Refaz transcrições que já existem
      --api-key <chave>    OpenAI API key (ou OPENAI_API_KEY no .env)
      --stdout             Imprime no terminal em vez de salvar
      --concat             Junta todas as transcrições num arquivo único
  -h, --help               Mostra esta ajuda

Exemplos:
  node index.js https://instagram.com/reel/abc --baixar   # baixa o vídeo
  node index.js https://youtube.com/watch?v=abc123        # grátis, via legendas
  node index.js https://instagram.com/reel/abc            # transcreve o reel
  node index.js "WhatsApp Video.mp4"                      # arquivo local
  node index.js energia --srt                             # busca nome + legenda
  node index.js --file links.txt --concat                 # lote de URLs

Rotas (escolhidas sozinho):
  URL do YouTube   -> legendas do YouTube (custo zero); cai na API se não houver
  Outro site       -> baixa o áudio e transcreve pela API
  Arquivo local    -> API da OpenAI (gpt-transcribe, com fallback whisper-1)

Vocabulário:
  Edite vocabulario.txt para corrigir nomes e siglas em todas as rotas.
`);
}

async function main() {
  const args = parseArgs(process.argv);

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
    // Sem alvo: pega tudo que está em videos/ e ainda não foi transcrito
    for (const file of listLocalMedia()) {
      queue.push({ kind: "local", value: file });
    }
    if (queue.length === 0) {
      showHelp();
      console.log(`Dica: coloque seus vídeos em ${VIDEOS_DIR}\n`);
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

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Transcritor`);
  console.log(`  ${queue.length} item(ns) na fila`);
  if (vocabulary.fixes.length > 0) {
    console.log(`  Vocabulário: ${vocabulary.fixes.length} correção(ões) ativa(s)`);
  }
  console.log(`${"=".repeat(60)}\n`);

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const label = item.kind === "local" ? path.basename(item.value) : item.value;
    console.log(`[${i + 1}/${queue.length}] ${label}`);

    try {
      let title;
      let formatted;
      let result;

      // --baixar: guarda o vídeo em videos/ e segue para o próximo
      if (args.download) {
        if (item.kind === "local") {
          console.log(`  Já é um arquivo local, nada a baixar\n`);
          skipped++;
          continue;
        }
        const { filePath: saved, alreadyExisted, captionPath } = downloadVideo(
          item.value,
          VIDEOS_DIR,
          authOptions
        );
        console.log(
          alreadyExisted ? `  Já estava baixado: ${saved}` : `  Salvo em: ${saved}`
        );
        if (captionPath) {
          console.log(`  Legenda do post: ${captionPath}`);
        } else {
          console.log("  (esse post não tem legenda)");
        }
        console.log(`  Para transcrever: node index.js "${path.basename(saved)}"\n`);
        success++;
        continue;
      }

      if (item.kind === "link") {
        // Site sem legenda pronta (Instagram, TikTok...): baixa o áudio
        const meta = getMetadata(item.value, authOptions);
        title = meta.title;
        console.log(`  Título: ${title}`);
        if (meta.caption) console.log("  Legenda do post capturada");

        const outPath = path.join(args.output, sanitizeFilename(title) + ".md");
        if (fs.existsSync(outPath) && !args.force && !args.stdout) {
          console.log(`  Já transcrito, pulando - use --forcar para refazer\n`);
          skipped++;
          continue;
        }

        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "baixar-"));
        try {
          const audioPath = downloadAudio(item.value, workDir, authOptions);
          const raw = await transcribeLocal(audioPath, {
            apiKey,
            language: args.lang[0] || "pt",
            wantSegments: args.srt,
            vocabularyPrompt: vocabulary.prompt,
          });
          result = applyFixesToResult(raw, vocabulary.fixes);
          formatted = formatLocal(title, item.value, result, meta.caption);
          console.log(`  OK - ${result.source}`);
        } finally {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      } else if (item.kind === "youtube") {
        const data = await transcribe(item.value, {
          apiKey,
          languages: args.lang,
        });
        title = data.title;
        result = applyFixesToResult(data.result, vocabulary.fixes);
        formatted = require("./youtube").formatForLLM(title, data.url, result);
      } else {
        title = path.basename(item.value, path.extname(item.value));

        const outPath = path.join(args.output, sanitizeFilename(title) + ".md");
        if (fs.existsSync(outPath) && !args.force && !args.stdout) {
          console.log(`  Já transcrito, pulando - use --forcar para refazer\n`);
          skipped++;
          continue;
        }

        const raw = await transcribeLocal(item.value, {
          apiKey,
          language: args.lang[0] || "pt",
          wantSegments: args.srt,
          vocabularyPrompt: vocabulary.prompt,
        });
        result = applyFixesToResult(raw, vocabulary.fixes);

        // Se o vídeo veio de um link, a legenda do post foi salva ao lado dele
        const caption = readCaption(item.value);
        if (caption) console.log("  Legenda do post encontrada");

        formatted = formatLocal(title, item.value, result, caption);
        console.log(`  OK - ${result.source}`);
      }

      if (args.stdout) {
        console.log("\n" + formatted);
        if (i < queue.length - 1) console.log("\n---\n");
      } else {
        const filename = sanitizeFilename(title) + ".md";
        const filepath = path.join(args.output, filename);
        fs.writeFileSync(filepath, formatted, "utf-8");
        console.log(`  Salvo em: ${filepath}`);

        if (args.srt && result.segments && result.segments.length > 0) {
          const srtPath = path.join(args.output, sanitizeFilename(title) + ".srt");
          fs.writeFileSync(srtPath, buildSRT(result.segments), "utf-8");
          console.log(`  Salvo em: ${srtPath}`);
        }
      }

      all.push(formatted);
      success++;
    } catch (err) {
      console.error(`  ERRO: ${err.message}`);
      failed++;
    }

    console.log();
  }

  if (args.concat && !args.stdout && all.length > 1) {
    const concatPath = path.join(args.output, "_todas_transcricoes.md");
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
