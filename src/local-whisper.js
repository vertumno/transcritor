/**
 * Rota local: transcreve sem API, usando faster-whisper na sua máquina.
 *
 * Segue o mesmo padrão das outras dependências do projeto (ffmpeg, yt-dlp):
 * um executável externo chamado por subprocesso. Aqui o executável é o
 * Python com o script transcricao_local.py ao lado deste arquivo.
 *
 * Devolve o mesmo contrato das demais rotas: { text, segments, source }.
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.join(__dirname, "transcricao_local.py");

// O objetivo padrão é qualidade. O Turbo continua disponível no perfil rápido.
const MODELO_PADRAO = "large-v3";
const MODELO_RAPIDO = "large-v3-turbo";

let pythonCache = null;
let dllCache = null;

/**
 * Acha o Python. Aceita a variável PYTHON para apontar um interpretador
 * específico (útil quando há venv ou várias versões instaladas).
 */
function acharPython() {
  if (pythonCache !== null) return pythonCache;

  const candidatos = [];
  if (process.env.PYTHON) candidatos.push([process.env.PYTHON, []]);
  candidatos.push(["python", []], ["python3", []], ["py", ["-3"]]);

  for (const [comando, prefixo] of candidatos) {
    try {
      execFileSync(comando, [...prefixo, "-c", "import faster_whisper"], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      });
      pythonCache = { comando, prefixo };
      return pythonCache;
    } catch {
      // Interpretador ausente ou sem a biblioteca: tenta o próximo
    }
  }

  pythonCache = false;
  return false;
}

/** true quando dá para transcrever localmente. */
function motorLocalDisponivel() {
  return acharPython() !== false;
}

/**
 * Diretórios das DLLs de CUDA instaladas pelos pacotes pip nvidia-*.
 *
 * O CTranslate2 carrega essas DLLs com LoadLibrary legado, que só olha o
 * %PATH% — por isso não basta os.add_dll_directory() dentro do Python.
 * Injetamos no ambiente do subprocesso, antes dele nascer.
 */
function diretoriosCuda(python) {
  if (dllCache !== null) return dllCache;
  if (process.platform !== "win32") return (dllCache = []);

  try {
    const saida = execFileSync(
      python.comando,
      [
        ...python.prefixo,
        "-c",
        "import glob,os,site;print(os.pathsep.join(" +
          "d for b in site.getsitepackages() " +
          "for d in glob.glob(os.path.join(b,'nvidia','*','bin'))))",
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 30000, encoding: "utf-8" }
    );
    dllCache = saida.trim() ? saida.trim().split(path.delimiter) : [];
  } catch {
    dllCache = [];
  }
  return dllCache;
}

/**
 * Transcreve um arquivo de vídeo/áudio localmente.
 *
 * Não precisa extrair nem fatiar o áudio: o faster-whisper decodifica o
 * vídeo direto (via PyAV) e processa em janela deslizante, sem limite de
 * tamanho — some o ffmpeg e o fatiamento que a rota da API exige.
 */
function transcribeLocalWhisper(filePath, options = {}) {
  const {
    modelo = MODELO_PADRAO,
    language = "pt",
    device = "auto",
    compute = "auto",
    perfil = "qualidade",
    vad = "auto",
    vocabularyPrompt = "",
  } = options;

  const python = acharPython();
  if (!python) {
    throw new Error(
      "motor local indisponível: não encontrei Python com faster-whisper.\n" +
        "  Instale com: pip install faster-whisper\n" +
        "  Ou use a API com --api (precisa de OPENAI_API_KEY)."
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`arquivo não encontrado: ${filePath}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-whisper-"));
  const jsonPath = path.join(workDir, "resultado.json");

  const ambiente = { ...process.env };
  const cuda = diretoriosCuda(python);
  if (cuda.length > 0) {
    ambiente.PATH = cuda.join(path.delimiter) + path.delimiter + (ambiente.PATH || "");
  }
  ambiente.PYTHONIOENCODING = "utf-8";

  const args = [
    ...python.prefixo,
    SCRIPT,
    "--audio", filePath,
    "--out", jsonPath,
    "--modelo", modelo,
    "--idioma", language,
    "--device", device,
    "--compute", compute,
    "--perfil", perfil,
    "--vad", vad,
  ];
  if (vocabularyPrompt) args.push("--prompt", vocabularyPrompt);

  return new Promise((resolve, reject) => {
    const processo = spawn(python.comando, args, {
      env: ambiente,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // stderr é o canal de progresso do script; repassamos direto ao usuário
    let ultimasLinhas = [];
    processo.stderr.setEncoding("utf-8");
    processo.stderr.on("data", (bloco) => {
      for (const linha of bloco.split("\n")) {
        const texto = linha.trimEnd();
        if (!texto) continue;
        console.log(texto.startsWith(" ") ? texto : `  ${texto}`);
        ultimasLinhas.push(texto);
        if (ultimasLinhas.length > 15) ultimasLinhas.shift();
      }
    });

    processo.on("error", (err) => {
      limpar();
      reject(new Error(`falha ao executar o Python: ${err.message}`));
    });

    processo.on("close", (codigo) => {
      try {
        if (codigo !== 0 || !fs.existsSync(jsonPath)) {
          throw new Error(
            `transcrição local falhou (código ${codigo}):\n` +
              ultimasLinhas.map((l) => "    " + l).join("\n")
          );
        }

        const resultado = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        if (!resultado.text || !resultado.text.trim()) {
          throw new Error(
            "nenhuma fala reconhecida - tente --vad off (canto/fala baixa) ou --lang auto"
          );
        }
        resolve(resultado);
      } catch (err) {
        reject(err);
      } finally {
        limpar();
      }
    });

    function limpar() {
      // Falha ao limpar não pode mascarar o erro real da transcrição
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  });
}

module.exports = {
  transcribeLocalWhisper,
  motorLocalDisponivel,
  MODELO_PADRAO,
  MODELO_RAPIDO,
};
