/**
 * Transcritor de YouTube - Híbrido
 * 1. Tenta extrair legendas via yt-dlp (zero custo, zero tokens)
 * 2. Fallback: baixa áudio com yt-dlp + Whisper API (custo mínimo)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Extrai o ID do vídeo de qualquer formato de URL do YouTube.
 */
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  throw new Error(`URL inválida do YouTube: ${url}`);
}

/**
 * Obtém título e metadados do vídeo usando yt-dlp.
 */
function getVideoInfo(url) {
  try {
    const buf = execSync(
      `yt-dlp --no-warnings --encoding utf-8 --print "%(title)s|||%(duration)s" "${url}"`,
      { timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const result = buf.toString("utf-8").trim();
    const [title, duration] = result.split("|||");
    return { title: title || "sem_titulo", duration: parseInt(duration) || 0 };
  } catch {
    return { title: "sem_titulo", duration: 0 };
  }
}

/**
 * Parseia o formato VTT para extrair segmentos com timestamps.
 */
function parseVTT(vttContent) {
  const segments = [];
  const lines = vttContent.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Procura por linhas de timestamp (00:00:00.000 --> 00:00:05.000)
    const timeMatch = lines[i].match(
      /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/
    );

    if (timeMatch) {
      const startSec =
        parseInt(timeMatch[1]) * 3600 +
        parseInt(timeMatch[2]) * 60 +
        parseInt(timeMatch[3]) +
        parseInt(timeMatch[4]) / 1000;

      const endSec =
        parseInt(timeMatch[5]) * 3600 +
        parseInt(timeMatch[6]) * 60 +
        parseInt(timeMatch[7]) +
        parseInt(timeMatch[8]) / 1000;

      // Coleta linhas de texto até linha vazia
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        const text = lines[i]
          .replace(/<[^>]*>/g, "") // Remove tags HTML
          .trim();
        if (text) textLines.push(text);
        i++;
      }

      const text = textLines.join(" ").trim();
      if (text) {
        segments.push({
          start: startSec,
          duration: endSec - startSec,
          text,
        });
      }
    }
    i++;
  }

  // Remove duplicatas consecutivas (legendas auto-geradas repetem muito)
  const deduped = [];
  for (const seg of segments) {
    if (deduped.length === 0 || deduped[deduped.length - 1].text !== seg.text) {
      deduped.push(seg);
    }
  }

  return deduped;
}

/**
 * Tenta extrair legendas do YouTube via yt-dlp (zero custo).
 */
function transcribeViaYouTube(url, languages = ["pt", "pt-BR", "en", "es"]) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-subs-"));
  const outTemplate = path.join(tempDir, "subs");

  try {
    const langList = languages.join(",");

    /**
     * Roda o yt-dlp e aproveita o que ele tiver baixado.
     *
     * O erro do yt-dlp NÃO pode descartar o resultado: pedindo vários
     * idiomas de uma vez, ele costuma baixar pt e en e só então tomar
     * HTTP 429 no terceiro — e sai com código de erro. Checar os arquivos
     * depois do catch recupera a legenda que já está no disco e evita
     * mandar para a API um vídeo que tinha legenda de graça.
     */
    const tentar = (flag, source) => {
      try {
        execSync(
          `yt-dlp ${flag} --sub-lang "${langList}" --sub-format vtt --skip-download --no-warnings --encoding utf-8 -o "${outTemplate}" "${url}"`,
          { timeout: 60000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
      } catch {
        // Pode ter baixado parte antes de falhar; a checagem abaixo decide
      }

      const subFile = findSubFile(tempDir);
      if (!subFile) return null;

      const segments = parseVTT(fs.readFileSync(subFile, "utf-8"));
      if (segments.length === 0) return null;

      return { text: segments.map((s) => s.text).join(" "), segments, source };
    };

    // Legendas manuais primeiro (revisadas por humanos), depois auto-geradas
    return (
      tentar("--write-sub", "youtube_manual_captions") ||
      tentar("--write-auto-sub", "youtube_auto_captions")
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Encontra o arquivo de legendas no diretório temporário.
 */
function findSubFile(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".vtt"));
  // Prioriza: pt > pt-BR > en > qualquer outro
  const priority = ["pt", "pt-BR", "en"];
  for (const lang of priority) {
    const match = files.find((f) => f.includes(`.${lang}.`));
    if (match) return path.join(dir, match);
  }
  return files.length > 0 ? path.join(dir, files[0]) : null;
}

/**
 * Baixa só o áudio do vídeo com yt-dlp e devolve o caminho do arquivo.
 * Compartilhado pelas duas rotas de áudio (motor local e API).
 */
function baixarAudio(url, tempDir) {
  const audioPath = path.join(tempDir, "audio");

  // Qualidade baixa é suficiente para fala e reduz muito o tempo de download
  execSync(
    `yt-dlp -x --audio-format mp3 --audio-quality 9 --no-warnings --no-progress -N 8 --encoding utf-8 -o "${audioPath}.%(ext)s" "${url}"`,
    { timeout: 3600000, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }
  );

  const files = fs.readdirSync(tempDir).filter((f) => f.startsWith("audio"));
  if (files.length === 0) throw new Error("Arquivo de áudio não encontrado");
  return path.join(tempDir, files[0]);
}

/**
 * Baixa o áudio e transcreve com o motor local (sem API, sem custo).
 */
async function transcribeViaMotorLocal(url, motorAudio) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-audio-"));
  try {
    return await motorAudio(baixarAudio(url, tempDir));
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Baixa áudio com yt-dlp e transcreve com Whisper API.
 */
async function transcribeViaWhisper(url, apiKey) {
  const OpenAI = require("openai");
  const client = new OpenAI({ apiKey });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-audio-"));

  try {
    const actualPath = baixarAudio(url, tempDir);

    const fileSize = fs.statSync(actualPath).size / (1024 * 1024);

    if (fileSize > 25) {
      return await transcribeLargeFile(client, actualPath, tempDir);
    }

    const response = await client.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(actualPath),
      response_format: "verbose_json",
      language: "pt",
    });

    const segments = (response.segments || []).map((s) => ({
      start: s.start,
      duration: s.end - s.start,
      text: s.text,
    }));

    return {
      text: response.text,
      segments,
      source: "whisper_api",
    };
  } finally {
    // Falha ao limpar não pode mascarar o erro real da transcrição
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Transcreve arquivos grandes dividindo em partes de 10 min.
 */
async function transcribeLargeFile(client, audioPath, tempDir) {
  const chunksDir = path.join(tempDir, "chunks");
  fs.mkdirSync(chunksDir, { recursive: true });

  const chunkPattern = path.join(chunksDir, "chunk_%03d.mp3");
  execSync(
    `ffmpeg -i "${audioPath}" -f segment -segment_time 600 -c:a libmp3lame -q:a 9 "${chunkPattern}"`,
    { stdio: ["pipe", "pipe", "pipe"], timeout: 1800000 }
  );

  const chunks = fs
    .readdirSync(chunksDir)
    .filter((f) => f.startsWith("chunk_"))
    .sort()
    .map((f) => path.join(chunksDir, f));

  const allText = [];
  const allSegments = [];
  let timeOffset = 0;

  for (const chunkPath of chunks) {
    const response = await client.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(chunkPath),
      response_format: "verbose_json",
      language: "pt",
    });

    allText.push(response.text);

    if (response.segments) {
      for (const s of response.segments) {
        allSegments.push({
          start: s.start + timeOffset,
          duration: s.end - s.start,
          text: s.text,
        });
      }
      const lastSeg = allSegments[allSegments.length - 1];
      timeOffset = lastSeg.start + lastSeg.duration;
    } else {
      timeOffset += 600;
    }
  }

  return {
    text: allText.join(" "),
    segments: allSegments,
    source: "whisper_api",
  };
}

/**
 * Formata a transcrição para consumo ideal por LLMs.
 * Texto limpo, denso, com timestamps espaçados a cada ~60s.
 */
function formatForLLM(title, url, result) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push(`Fonte: ${url}`);
  lines.push(`Método: ${result.source}`);
  lines.push("");

  const segments = result.segments || [];

  if (segments.length === 0) {
    lines.push(result.text);
  } else {
    let currentBlock = [];
    let lastTimestamp = -60;

    for (const seg of segments) {
      const start = seg.start;
      const text = seg.text.trim();
      if (!text) continue;

      if (start - lastTimestamp >= 60) {
        if (currentBlock.length > 0) {
          lines.push(currentBlock.join(" "));
          currentBlock = [];
        }
        const minutes = Math.floor(start / 60);
        const seconds = Math.floor(start % 60);
        lines.push("");
        lines.push(
          `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}]`
        );
        lastTimestamp = start;
      }

      currentBlock.push(text);
    }

    if (currentBlock.length > 0) {
      lines.push(currentBlock.join(" "));
    }
  }

  return lines.join("\n");
}

/**
 * Função principal: transcreve um vídeo do YouTube.
 */
async function transcribe(
  url,
  { apiKey = null, languages = null, motorAudio = null, ignorarLegendas = false } = {}
) {
  const videoId = extractVideoId(url);
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  console.log(`  Obtendo informações...`);
  const info = getVideoInfo(canonicalUrl);
  console.log(`  Título: ${info.title}`);
  if (info.duration > 0) {
    const min = Math.floor(info.duration / 60);
    const sec = info.duration % 60;
    console.log(`  Duração: ${min}m${sec}s`);
  }

  // Etapa 1: legendas do YouTube (instantâneas e de graça).
  // --refazer pula direto para o áudio: o modelo local costuma ser melhor
  // que a legenda auto-gerada, que vem sem pontuação e com repetições.
  let result = null;
  if (ignorarLegendas) {
    console.log(`  Ignorando legendas do YouTube (--refazer)`);
  } else {
    console.log(`  Tentando legendas do YouTube via yt-dlp...`);
    result = transcribeViaYouTube(
      canonicalUrl,
      languages || ["pt", "pt-BR", "en", "es"]
    );
  }

  if (result) {
    console.log(`  OK - ${result.source} (${result.segments.length} segmentos)`);
  } else if (motorAudio) {
    // Etapa 2: motor local — baixa o áudio e transcreve na própria máquina
    console.log(`  Baixando áudio para transcrever localmente...`);
    result = await transcribeViaMotorLocal(canonicalUrl, motorAudio);
    console.log(`  OK - ${result.source} (${result.segments.length} segmentos)`);
  } else {
    // Etapa 3: API, só quando o usuário pede com --api
    const key = apiKey || process.env.OPENAI_API_KEY;

    if (!key) {
      throw new Error(
        "Legendas indisponíveis e OPENAI_API_KEY não configurada. " +
          "Configure no .env ou passe --api-key."
      );
    }

    console.log(`  Legendas indisponíveis. Baixando áudio para Whisper API...`);
    result = await transcribeViaWhisper(canonicalUrl, key);

    if (!result) {
      throw new Error(`Falha ao transcrever: ${canonicalUrl}`);
    }

    console.log(`  OK - Whisper API (${result.segments.length} segmentos)`);
  }

  const formatted = formatForLLM(info.title, canonicalUrl, result);

  return { title: info.title, url: canonicalUrl, videoId, result, formatted };
}

module.exports = { transcribe, extractVideoId, formatForLLM };
