/**
 * Vocabulário compartilhado pelas duas rotas (YouTube e arquivo local).
 *
 * O arquivo vocabulario.txt aceita dois tipos de linha:
 *   1. termo correto            -> vira dica de grafia enviada junto com o áudio
 *   2. errado => certo          -> vira correção aplicada no texto final
 *
 * A dica depende da IA obedecer; a correção é garantida, feita por código.
 */

const fs = require("fs");
const path = require("path");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lê vocabulario.txt da raiz do projeto. Ausência do arquivo não é erro.
 */
function loadVocabulary(baseDir = path.join(__dirname, "..", "config")) {
  const file = path.join(baseDir, "vocabulario.txt");
  if (!fs.existsSync(file)) return { prompt: "", fixes: [] };

  const hints = [];
  const fixes = [];

  for (const rawLine of fs.readFileSync(file, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const marker = line.indexOf("=>");
    if (marker !== -1) {
      const wrong = line.slice(0, marker).trim();
      const right = line.slice(marker + 2).trim();
      if (wrong) fixes.push([wrong, right]);
    } else {
      hints.push(line);
    }
  }

  // O modelo imita a pontuação do prompt: uma dica sem ponto final faz a
  // transcrição voltar sem pontuação. Por isso fechamos como frase.
  let prompt = hints.join(" ").trim();
  if (prompt && !".!?".includes(prompt.slice(-1))) prompt += ".";

  return { prompt, fixes };
}

/**
 * Aplica as correções de grafia, ignorando maiúsculas/minúsculas.
 */
function applyFixes(text, fixes) {
  if (!text || !fixes || fixes.length === 0) return text;
  let output = text;
  for (const [wrong, right] of fixes) {
    output = output.replace(new RegExp(escapeRegExp(wrong), "gi"), right);
  }
  return output;
}

/**
 * Aplica as correções em um resultado inteiro (texto + segmentos).
 */
function applyFixesToResult(result, fixes) {
  if (!fixes || fixes.length === 0) return result;
  return {
    ...result,
    text: applyFixes(result.text, fixes),
    segments: (result.segments || []).map((s) => ({
      ...s,
      text: applyFixes(s.text, fixes),
    })),
  };
}

module.exports = { loadVocabulary, applyFixes, applyFixesToResult };
