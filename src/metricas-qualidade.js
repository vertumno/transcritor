const fs = require("fs");
const path = require("path");

function normalizar(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function distanciaLevenshtein(reference, hypothesis) {
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i++) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j < current.length; j++) previous[j] = current[j];
  }
  return previous[hypothesis.length];
}

function wer(reference, hypothesis) {
  const ref = normalizar(reference).split(" ").filter(Boolean);
  const hyp = normalizar(hypothesis).split(" ").filter(Boolean);
  return ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : distanciaLevenshtein(ref, hyp) / ref.length;
}

function cer(reference, hypothesis) {
  const ref = [...normalizar(reference).replace(/ /g, "")];
  const hyp = [...normalizar(hypothesis).replace(/ /g, "")];
  return ref.length === 0 ? (hyp.length === 0 ? 0 : 1) : distanciaLevenshtein(ref, hyp) / ref.length;
}

function recallTermos(reference, hypothesis, terms = []) {
  const relevantes = terms.filter((term) => normalizar(reference).includes(normalizar(term)));
  if (relevantes.length === 0) return null;
  const encontrados = relevantes.filter((term) => normalizar(hypothesis).includes(normalizar(term)));
  return encontrados.length / relevantes.length;
}

function lerTexto(baseDir, relativePath) {
  return fs.readFileSync(path.resolve(baseDir, relativePath), "utf-8");
}

function avaliarManifesto(manifestPath) {
  const absolute = path.resolve(manifestPath);
  const baseDir = path.dirname(absolute);
  const manifest = JSON.parse(fs.readFileSync(absolute, "utf-8"));
  const rows = [];

  for (const sample of manifest.samples || []) {
    const reference = lerTexto(baseDir, sample.reference);
    for (const [profile, hypothesisPath] of Object.entries(sample.hypotheses || {})) {
      const hypothesis = lerTexto(baseDir, hypothesisPath);
      rows.push({
        sample: sample.id,
        profile,
        wer: wer(reference, hypothesis),
        cer: cer(reference, hypothesis),
        termRecall: recallTermos(reference, hypothesis, [
          ...(manifest.criticalTerms || []),
          ...(sample.criticalTerms || []),
        ]),
      });
    }
  }
  return rows;
}

module.exports = { normalizar, distanciaLevenshtein, wer, cer, recallTermos, avaliarManifesto };
