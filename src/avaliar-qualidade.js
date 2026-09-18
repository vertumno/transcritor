#!/usr/bin/env node

const path = require("path");
const { avaliarManifesto } = require("./metricas-qualidade");

const manifest = process.argv[2] || path.join(__dirname, "..", "quality", "corpus", "manifest.json");

try {
  const rows = avaliarManifesto(manifest);
  if (rows.length === 0) {
    console.log("O corpus ainda não possui hipóteses para avaliar.");
    console.log(`Edite: ${path.resolve(manifest)}`);
    process.exit(0);
  }

  console.table(
    rows.map((row) => ({
      amostra: row.sample,
      perfil: row.profile,
      "WER %": (row.wer * 100).toFixed(2),
      "CER %": (row.cer * 100).toFixed(2),
      "Termos %": row.termRecall == null ? "n/a" : (row.termRecall * 100).toFixed(2),
    }))
  );
} catch (err) {
  console.error(`Falha ao avaliar corpus: ${err.message}`);
  process.exit(1);
}
