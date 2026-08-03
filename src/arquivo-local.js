/**
 * Transcrição de arquivos de vídeo/áudio locais via API da OpenAI.
 *
 * Complementa transcriber.js: aquele resolve URLs do YouTube (de graça,
 * usando as legendas); este resolve arquivos que estão no seu disco —
 * vídeo do WhatsApp, gravação de aula, áudio de reunião.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_MODEL = "gpt-transcribe"; // mais preciso para fala
const SUBTITLE_MODEL = "whisper-1"; // único que devolve timestamps

// A API aceita no máximo 25 MB por envio. Áudio mono 16 kHz / 64 kbps
// ocupa ~0,5 MB por minuto, então 20 min por pedaço fica com folga larga.
const CHUNK_SECONDS = 20 * 60;

const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv",
  ".mp3", ".m4a", ".wav", ".ogg", ".opus", ".flac", ".aac", ".wma",
]);

function isMediaFile(filePath) {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Extrai o áudio e já devolve fatiado em pedaços que cabem no limite da API.
 */
function splitAudio(filePath, workDir) {
  const pattern = path.join(workDir, "parte_%03d.mp3");

  try {
    execFileSync(
      "ffmpeg",
      [
        "-nostdin", "-loglevel", "error", "-y",
        "-i", filePath,
        "-vn",              // descarta o vídeo
        "-ac", "1",         // mono
        "-ar", "16000",     // 16 kHz (o que os modelos usam internamente)
        "-b:a", "64k",
        "-f", "segment",
        "-segment_time", String(CHUNK_SECONDS),
        "-segment_format", "mp3",
        pattern,
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 600000 }
    );
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`ffmpeg falhou ao extrair o áudio: ${detail}`);
  }

  const parts = fs
    .readdirSync(workDir)
    .filter((f) => f.startsWith("parte_"))
    .sort()
    .map((f) => path.join(workDir, f));

  if (parts.length === 0) {
    throw new Error("nenhum áudio foi extraído - o arquivo tem faixa de áudio?");
  }
  return parts;
}

/**
 * Envia um pedaço de áudio para a API.
 *
 * O modelo novo devolve texto vazio em áudio cantado; nesse caso caímos
 * automaticamente no whisper-1, que dá conta de música.
 */
async function transcribeChunk(client, chunkPath, options) {
  const { model, language, wantSegments, context, vocabularyPrompt } = options;

  const send = async (useModel) => {
    const request = {
      model: useModel,
      file: fs.createReadStream(chunkPath),
    };
    if (language && language !== "auto") request.language = language;
    if (wantSegments) request.response_format = "verbose_json";

    // O prompt guia a grafia: vocabulário do usuário + final do trecho
    // anterior (esse contexto melhora nomes próprios, siglas e pontuação).
    const prompt = [vocabularyPrompt, (context || "").slice(-400)]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (prompt) request.prompt = prompt;

    return client.audio.transcriptions.create(request);
  };

  let response = await send(model);

  if (!(response.text || "").trim() && model !== SUBTITLE_MODEL) {
    console.log(
      `    ${model} não retornou texto (áudio cantado?) - refazendo com ${SUBTITLE_MODEL}`
    );
    response = await send(SUBTITLE_MODEL);
    return { response, usedModel: SUBTITLE_MODEL };
  }

  return { response, usedModel: model };
}

/**
 * Transcreve um arquivo local inteiro.
 * Devolve o mesmo formato de transcriber.js: { text, segments, source }.
 */
async function transcribeLocal(filePath, options = {}) {
  const {
    apiKey,
    language = "pt",
    wantSegments = false,
    vocabularyPrompt = "",
    model = DEFAULT_MODEL,
  } = options;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY não configurada. Arquivos locais sempre usam a API " +
        "(não existe legenda pronta como no YouTube). Configure no .env."
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`arquivo não encontrado: ${filePath}`);
  }

  const OpenAI = require("openai");
  const client = new OpenAI({ apiKey });

  // --srt precisa de timestamps, e só o whisper-1 devolve isso
  const activeModel = wantSegments ? SUBTITLE_MODEL : model;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcrever-"));

  try {
    console.log("  Extraindo áudio...");
    const chunks = splitAudio(filePath, workDir);

    const texts = [];
    const segments = [];
    const modelsUsed = new Set();
    let offset = 0;

    for (let i = 0; i < chunks.length; i++) {
      console.log(
        chunks.length > 1
          ? `  Transcrevendo parte ${i + 1}/${chunks.length}...`
          : "  Transcrevendo..."
      );

      const { response, usedModel } = await transcribeChunk(client, chunks[i], {
        model: activeModel,
        language,
        wantSegments,
        context: texts.length > 0 ? texts[texts.length - 1] : "",
        vocabularyPrompt,
      });

      modelsUsed.add(usedModel);
      texts.push((response.text || "").trim());

      if (wantSegments && response.segments) {
        for (const s of response.segments) {
          segments.push({
            start: s.start + offset,
            duration: s.end - s.start,
            text: s.text,
          });
        }
        offset += Number(response.duration) || 0;
      }
    }

    const text = texts.filter(Boolean).join("\n\n");
    if (!text.trim()) {
      throw new Error(
        "nenhuma fala reconhecida - o arquivo tem fala? tente --lang auto"
      );
    }

    return {
      text,
      segments,
      source: `arquivo_local (${[...modelsUsed].sort().join("+")})`,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { transcribeLocal, isMediaFile, MEDIA_EXTENSIONS };
