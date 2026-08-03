/**
 * Download de vídeos por link, via yt-dlp.
 *
 * Serve a dois propósitos:
 *   1. `--baixar` — guardar o vídeo em videos/ para você assistir/editar
 *   2. transcrever links que não são do YouTube (Instagram, TikTok...),
 *      onde não existe legenda pronta: baixa só o áudio e manda para a API
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

/** Nome amigável do site, só para as mensagens do terminal. */
function siteName(url) {
  const match = url.match(/^https?:\/\/(?:www\.)?([^/:]+)/i);
    return match ? match[1].replace(/\.(com|net|org|tv|be)(\.[a-z]{2})?$/i, "") : "link";
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

/** Título e ID do vídeo sem baixar nada. */
function getInfo(url, options = {}) {
  try {
    const out = execFileSync(
      "yt-dlp",
      [
        ...cookieArgs(options),
        "--no-warnings", "--no-playlist", "--encoding", "utf-8",
        "--print", "%(title)s|||%(id)s",
        url,
      ],
      { timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const [title, id] = out.toString("utf-8").trim().split("\n")[0].split("|||");
    return { title: title || "sem_titulo", id: id || "" };
  } catch {
    return { title: "sem_titulo", id: "" };
  }
}

/** Título do vídeo sem baixar nada. */
function getTitle(url) {
  return getInfo(url).title;
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
  const { id } = getInfo(url, options);
  const existing = findExisting(destDir, id);
  if (existing) {
    return { filePath: existing, alreadyExisted: true };
  }

  console.log(
    `  Baixando vídeo de ${siteName(url)}${auth.length ? " (com cookies)" : ""}...`
  );
  return runDownload(
    [
      ...auth,
      "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--no-warnings",
      "--encoding", "utf-8",
      "-o", path.join(destDir, "%(title)s [%(id)s].%(ext)s"),
      url,
    ],
    destDir,
    id,
    url
  );
}

/**
 * Baixa só o áudio, para transcrever links sem legenda disponível.
 */
function downloadAudio(url, destDir, options = {}) {
  const auth = cookieArgs(options);
  console.log(
    `  Baixando áudio de ${siteName(url)}${auth.length ? " (com cookies)" : ""}...`
  );
  const { filePath } = runDownload(
    [
      ...auth,
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "9",
      "--no-playlist",
      "--no-warnings",
      "--encoding", "utf-8",
      "-o", path.join(destDir, "audio_%(id)s.%(ext)s"),
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
  getTitle,
  getInfo,
  isUrl,
  isYouTubeUrl,
  siteName,
};
