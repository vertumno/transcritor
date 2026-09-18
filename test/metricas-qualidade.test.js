const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizar, wer, cer, recallTermos } = require("../src/metricas-qualidade");

test("normalização ignora caixa, pontuação e acentos", () => {
  assert.equal(normalizar("Pré-queda, AÇÃO!"), "pre queda acao");
});

test("WER mede substituição de palavra", () => {
  assert.equal(wer("um teste simples", "um texto simples"), 1 / 3);
});

test("CER é zero para diferenças apenas de acentuação", () => {
  assert.equal(cer("transcrição", "transcricao"), 0);
});

test("recall de termos críticos mede nomes presentes na referência", () => {
  assert.equal(
    recallTermos("Claude Code usa NVIDIA", "Claude usa NVIDIA", ["Claude Code", "NVIDIA"]),
    0.5
  );
});
