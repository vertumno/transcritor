/**
 * Download de vídeos, áudios e imagens por link, via yt-dlp.
 *
 * Serve a dois propósitos:
 *   1. `--baixar` — guardar o vídeo no trabalho organizado para assistir/editar
 *   2. transcrever links que não são do YouTube (Instagram, TikTok...),
 *      onde não existe legenda pronta: preserva o melhor áudio para o motor local
 */

const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** É um link (qualquer site), e não um arquivo local? */
function isUrl(target) {
  return /^https?:\/\//i.test(target);
}

/** É link do YouTube? (a única rota com legenda de graça) */
function isYouTubeUrl(target) {
  return /(?:youtube\.com|youtu\.be)/i.test(target);
}

const ROTAS_INSTAGRAM = new Set([
  "accounts", "about", "developer", "direct", "directory", "explore",
  "p", "reel", "reels", "stories", "tv",
]);

function normalizarPerfilStories(target) {
  const valor = String(target || "").trim();
  const storyUrl = valor.match(
    /^https?:\/\/(?:www\.)?instagram\.com\/stories\/([a-z0-9._]+)(?:\/\d+)?\/?(?:[?#].*)?$/i
  );
  if (storyUrl) {
    const username = storyUrl[1];
    return { username, url: `https://www.instagram.com/stories/${username}/` };
  }

  const profileUrl = valor.match(
    /^https?:\/\/(?:www\.)?instagram\.com\/([a-z0-9._]+)\/?(?:[?#].*)?$/i
  );
  const username = profileUrl
    ? profileUrl[1]
    : valor.replace(/^@/, "").match(/^[a-z0-9._]+$/i)?.[0];
  if (!username || ROTAS_INSTAGRAM.has(username.toLowerCase())) return null;
  return { username, url: `https://www.instagram.com/stories/${username}/` };
}

function isInstagramProfileUrl(target) {
  return isUrl(target) && Boolean(normalizarPerfilStories(target));
}

function mapearStories(data, username) {
  const entries = Array.isArray(data?.stories) ? data.stories : [];
  return entries
    .filter((entry) => entry && entry.id && entry.mediaUrl)
    .map((entry, index) => ({
      url: `https://www.instagram.com/stories/${username}/`,
      mediaUrl: entry.mediaUrl,
      meta: {
        title: `Story ${username} - ${String(index + 1).padStart(2, "0")}`,
        id: String(entry.id),
        pk: entry.pk || null,
        caption: String(entry.caption || "").trim(),
        uploader: data.uploader || username,
        duration: entry.duration ?? null,
        timestamp: entry.timestamp ?? null,
        expiresAt: entry.expiresAt ?? null,
        profile: username,
        storyIndex: index + 1,
        mediaType: entry.mediaType,
        extension: entry.extension,
        width: entry.width ?? null,
        height: entry.height ?? null,
        hasAudio: entry.hasAudio ?? null,
      },
    }));
}

function executarListadorStories(args) {
  const candidatos = [];
  if (process.env.PYTHON) candidatos.push([process.env.PYTHON, []]);
  candidatos.push(["python", []], ["python3", []], ["py", ["-3"]]);
  let indisponivel = null;

  for (const [comando, prefixo] of candidatos) {
    try {
      return execFileSync(
        comando,
        [...prefixo, path.join(__dirname, "listar_stories.py"), ...args],
        {
          timeout: 180000,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        }
      );
    } catch (err) {
      if (err.code === "ENOENT") {
        indisponivel = err;
        continue;
      }
      throw err;
    }
  }
  throw indisponivel || new Error("Python não encontrado");
}

function listInstagramStories(target, options = {}) {
  const profile = normalizarPerfilStories(target);
  if (!profile) {
    throw new Error(
      `perfil do Instagram inválido: ${target}. Use @usuario ou https://instagram.com/usuario/`
    );
  }

  const auth = cookieArgs(options);
  if (auth.length === 0) {
    throw new Error(
      "Stories do Instagram exigem login. Use --navegador firefox ou forneça cookies.txt."
    );
  }

  try {
    const out = executarListadorStories(["--profile", profile.url, ...auth]);
    const data = JSON.parse(out.toString("utf-8"));
    const username = data.username || profile.username;
    return {
      username,
      url: `https://www.instagram.com/stories/${username}/`,
      stories: mapearStories(data, username),
    };
  } catch (err) {
    const detalhe = err.stderr ? err.stderr.toString("utf-8").trim() : err.message;
    throw new Error(
      `não foi possível listar os Stories de @${profile.username}. ` +
        `Confirme que o perfil está visível na conta autenticada e renove os cookies.\n${detalhe}`
    );
  }
}

/** Nome amigável do site, só para as mensagens do terminal. */
function siteName(url) {
  const match = url.match(/^https?:\/\/(?:www\.)?([^/:]+)/i);
    return match ? match[1].replace(/\.(com|net|org|tv|be)(\.[a-z]{2})?$/i, "") : "link";
}

function safeOutputBase(value, fallback = "media") {
  const safe = String(value || fallback)
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return safe || fallback;
}

/**
 * Argumentos de autenticação do yt-dlp.
 *
 * Instagram, TikTok e vídeos restritos exigem sessão. Duas formas:
 *   1. cookies.txt na pasta do projeto (mais confiável no Windows)
 *   2. --navegador firefox (lê a sessão do navegador)
 *
 * No Windows, Chrome e Edge normalmente FALHAM: o Chromium 127+ cifra os
 * cookies com App-Bound Encryption e o yt-dlp não consegue ler. Firefox
 * funciona; o arquivo cookies.txt funciona sempre.
 */
function cookieArgs(options = {}) {
  // cookies.txt fica na raiz do projeto, um nível acima de src/
  const { cookiesFile, browser, baseDir = path.join(__dirname, "..") } = options;

  if (cookiesFile) {
    if (!fs.existsSync(cookiesFile)) {
      throw new Error(`arquivo de cookies não encontrado: ${cookiesFile}`);
    }
    return ["--cookies", cookiesFile];
  }
  if (browser) return ["--cookies-from-browser", browser];

  // Sem pedido explícito: usa cookies.txt da pasta, se existir
  const padrao = path.join(baseDir, "cookies.txt");
  if (fs.existsSync(padrao)) return ["--cookies", padrao];

  return [];
}

/** Mensagem de ajuda quando o site exige login. */
function authHint(url) {
  return (
    `\n  ${siteName(url)} exigiu login para esse link. Duas saídas:\n` +
    "    1. Exporte os cookies do navegador (extensão \"Get cookies.txt LOCALLY\")\n" +
    "       e salve como cookies.txt nesta pasta - depois é automático.\n" +
    "    2. Faça login no Instagram pelo Firefox e rode com: --navegador firefox\n" +
    "  Detalhes no README (seção \"Instagram pedindo login\")."
  );
}

function ensureYtDlp() {
  const probe = spawnSync("yt-dlp", ["--version"], { stdio: "ignore" });
  if (probe.error) {
    throw new Error(
      "yt-dlp não encontrado no PATH. Instale com: winget install yt-dlp.yt-dlp"
    );
  }
}

/**
 * Metadados do post sem baixar o vídeo: título, ID, autor e a legenda.
 *
 * "Legenda" aqui é o texto que acompanha o post (a caption do Instagram,
 * a descrição do YouTube) — não os subtítulos do áudio. O yt-dlp entrega
 * isso no campo `description`.
 *
 * Usamos JSON em vez de --print porque a legenda tem várias linhas e
 * quebraria qualquer separador de texto simples.
 */
function getMetadata(url, options = {}) {
  const vazio = { title: "sem_titulo", id: "", caption: "", uploader: "" };
  try {
    const out = execFileSync(
      "yt-dlp",
      [
        ...cookieArgs(options),
        "--dump-single-json",
        "--no-playlist", "--no-warnings", "--encoding", "utf-8",
        url,
      ],
      { timeout: 120000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }
    );
    const data = JSON.parse(out.toString("utf-8"));
    return {
      title: data.title || "sem_titulo",
      id: data.id || "",
      caption: (data.description || "").trim(),
      uploader: data.uploader || data.uploader_id || "",
    };
  } catch {
    return vazio;
  }
}

/** Título e ID do vídeo sem baixar nada. */
function getInfo(url, options = {}) {
  const { title, id } = getMetadata(url, options);
  return { title, id };
}

/** Título do vídeo sem baixar nada. */
function getTitle(url, options = {}) {
  return getMetadata(url, options).title;
}

/**
 * Grava a legenda do post ao lado do vídeo, para não se perder.
 * Assim ela continua disponível quando você transcrever o arquivo depois.
 */
function saveCaption(videoPath, meta) {
  if (!meta.caption) return null;

  const destino = videoPath.replace(/\.[^.]+$/, "") + ".legenda.txt";
  const cabecalho = [
    meta.title && `Título: ${meta.title}`,
    meta.uploader && `Autor: ${meta.uploader}`,
    "",
  ]
    .filter((l) => l !== undefined && l !== false)
    .join("\n");

  fs.writeFileSync(destino, cabecalho + meta.caption + "\n", "utf-8");
  return destino;
}

/** Lê a legenda salva ao lado de um vídeo, se existir. */
function readCaption(videoPath) {
  const arquivo = videoPath.replace(/\.[^.]+$/, "") + ".legenda.txt";
  if (!fs.existsSync(arquivo)) return "";
  return fs.readFileSync(arquivo, "utf-8").trim();
}

/** Procura no diretório um arquivo já baixado deste vídeo (pelo ID). */
function findExisting(destDir, id) {
  if (!id || !fs.existsSync(destDir)) return null;
  const match = fs.readdirSync(destDir).find((f) => f.includes(`[${id}]`));
  return match ? path.join(destDir, match) : null;
}

/** Arquivos de um diretório (usado para descobrir o que acabou de aparecer). */
function snapshot(dir) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir));
}

/**
 * Roda o yt-dlp mostrando o progresso e devolve o arquivo que surgiu.
 */
function runDownload(args, destDir, id, url) {
  ensureYtDlp();
  fs.mkdirSync(destDir, { recursive: true });

  const before = snapshot(destDir);
  const result = spawnSync("yt-dlp", args, { stdio: "inherit", timeout: 1800000 });

  if (result.error) throw new Error(`falha ao executar yt-dlp: ${result.error.message}`);

  const created = [...snapshot(destDir)].filter((f) => !before.has(f));

  if (created.length > 0) {
    // Se houve merge, pode sobrar arquivo temporário: fica com o maior
    const files = created
      .map((f) => path.join(destDir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return { filePath: files[0], alreadyExisted: false };
  }

  // Nenhum arquivo novo: o yt-dlp pode ter pulado por já estar baixado
  const existing = findExisting(destDir, id);
  if (existing) return { filePath: existing, alreadyExisted: true };

  if (result.status !== 0) {
    const semCookies = !args.includes("--cookies") && !args.includes("--cookies-from-browser");
    throw new Error(
      `yt-dlp saiu com código ${result.status}.` +
        (url && semCookies
          ? authHint(url)
          : " Link privado, apagado, ou os cookies venceram (refaça a exportação).")
    );
  }
  throw new Error("o download terminou mas nenhum arquivo novo apareceu.");
}

/**
 * Baixa o vídeo (imagem + som) para destDir.
 */
function downloadVideo(url, destDir, options = {}) {
  const auth = cookieArgs(options);
  const meta = options.meta || getMetadata(url, options);
  const existing = findExisting(destDir, meta.id);

  if (existing) {
    // Mesmo já baixado, garante que a legenda esteja salva
    const captionPath = fs.existsSync(existing) ? saveCaption(existing, meta) : null;
    return { filePath: existing, alreadyExisted: true, captionPath, meta };
  }

  console.log(
    `  Baixando vídeo de ${siteName(url)}${auth.length ? " (com cookies)" : ""}...`
  );
  const resultado = runDownload(
    [
      ...auth,
      "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--no-warnings",
      "--encoding", "utf-8",
      "-o",
      options.outputBase
        ? path.join(destDir, `${safeOutputBase(options.outputBase)}.%(ext)s`)
        : path.join(destDir, "%(title)s [%(id)s].%(ext)s"),
      url,
    ],
    destDir,
    meta.id,
    url
  );

  const captionPath = saveCaption(resultado.filePath, meta);
  return { ...resultado, captionPath, meta };
}

/** Baixa uma mídia de Story já descoberta (imagem ou vídeo). */
function downloadStoryMedia(url, destDir, options = {}) {
  const auth = cookieArgs(options);
  const base = safeOutputBase(options.outputBase, "story");
  const extension = safeOutputBase(options.extension, "media").toLowerCase();
  console.log(
    `  Baixando ${options.mediaType === "image" ? "imagem" : "vídeo"} do Story...`
  );
  return runDownload(
    [
      ...auth,
      "--no-playlist",
      "--no-warnings",
      "--encoding", "utf-8",
      "-o", path.join(destDir, `${base}.${extension}`),
      url,
    ],
    destDir,
    "",
    url
  ).filePath;
}

/**
 * Baixa a melhor faixa de áudio sem recodificar.
 *
 * Converter para MP3 aqui pioraria um áudio que normalmente já é comprimido.
 * O fallback /b aceita um contêiner com vídeo quando o site não oferece uma
 * faixa exclusivamente de áudio; o motor local consegue decodificá-lo.
 */
function downloadAudio(url, destDir, options = {}) {
  const auth = cookieArgs(options);
  console.log(
    `  Baixando áudio de ${siteName(url)}${auth.length ? " (com cookies)" : ""}...`
  );
  const { filePath } = runDownload(
    [
      ...auth,
      "-f", "ba/b",
      "--no-playlist",
      "--no-warnings",
      "--encoding", "utf-8",
      "-o",
      options.outputBase
        ? path.join(destDir, `audio_${safeOutputBase(options.outputBase)}.%(ext)s`)
        : path.join(destDir, "audio_%(id)s.%(ext)s"),
      url,
    ],
    destDir,
    "",
    url
  );
  return filePath;
}

module.exports = {
  downloadVideo,
  downloadAudio,
  downloadStoryMedia,
  getTitle,
  getInfo,
  getMetadata,
  saveCaption,
  readCaption,
  isUrl,
  isYouTubeUrl,
  isInstagramProfileUrl,
  normalizarPerfilStories,
  mapearStories,
  listInstagramStories,
  siteName,
};
