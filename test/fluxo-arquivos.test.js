const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  formatarDataHora,
  sanitizarNome,
  caminhoArquivoUnico,
  estaDentro,
  criarTrabalho,
  criarLote,
} = require("../src/fluxo-arquivos");

test("formata o prefixo no padrão solicitado", () => {
  const date = new Date(2026, 8, 18, 17, 11, 42);
  assert.equal(formatarDataHora(date), "2026-09-18-1711");
});

test("preserva espaços e remove caracteres inválidos do Windows", () => {
  assert.equal(sanitizarNome('  aula: teste / parte 1  '), "aula teste parte 1");
});

test("evita sobrescrever arquivo mantendo a extensão", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcritor-test-"));
  try {
    fs.writeFileSync(path.join(root, "lote.md"), "primeiro", "utf-8");
    assert.equal(caminhoArquivoUnico(root, "lote.md"), path.join(root, "lote (2).md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reconhece somente arquivos realmente dentro da inbox", () => {
  const root = path.resolve("C:/projeto/_inbox");
  assert.equal(estaDentro(path.join(root, "audio.mp3"), root), true);
  assert.equal(estaDentro(path.resolve("C:/projeto/outro.mp3"), root), false);
});

test("trabalho só aparece como processado depois de complete", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcritor-test-"));
  try {
    const job = criarTrabalho(root, "Minha aula", new Date(2026, 8, 18, 17, 11));
    fs.writeFileSync(job.file("md"), "ok", "utf-8");
    assert.equal(fs.existsSync(job.finalDir), false);
    job.complete();
    assert.equal(fs.existsSync(job.finalFile("md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mídia da inbox fica junto dos derivados após concluir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcritor-test-"));
  try {
    const inbox = path.join(root, "_inbox");
    const output = path.join(root, "_processados");
    fs.mkdirSync(inbox);
    const source = path.join(inbox, "aula.wav");
    fs.writeFileSync(source, "audio", "utf-8");

    const job = criarTrabalho(output, "Minha aula", new Date(2026, 8, 18, 17, 11));
    const archived = job.archiveMedia(source);
    fs.writeFileSync(job.file("md"), "transcrição", "utf-8");
    job.complete();

    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(path.join(job.finalDir, path.basename(archived))), true);
    assert.equal(fs.existsSync(job.finalFile("md")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("falha preserva os artefatos e um diagnóstico fora dos concluídos", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcritor-test-"));
  try {
    const job = criarTrabalho(root, "Minha aula", new Date(2026, 8, 18, 17, 11));
    fs.writeFileSync(job.file("md"), "parcial", "utf-8");
    const failureDir = job.fail(new Error("falha simulada"));

    assert.equal(fs.existsSync(job.finalDir), false);
    assert.equal(fs.existsSync(path.join(failureDir, "_ERRO.txt")), true);
    assert.match(fs.readFileSync(path.join(failureDir, "_ERRO.txt"), "utf-8"), /falha simulada/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lote reúne todos os Stories em uma única pasta mãe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcritor-test-"));
  try {
    const lote = criarLote(
      root,
      "Story pessoa - Todos",
      new Date(2026, 8, 18, 18, 28)
    );
    const primeiro = lote.item("Story pessoa - 01");
    const segundo = lote.item("Story pessoa - 02");
    fs.writeFileSync(primeiro.file("md"), "vídeo", "utf-8");
    fs.writeFileSync(segundo.file("jpg"), "imagem", "utf-8");

    assert.equal(fs.existsSync(lote.finalDir), false);
    primeiro.complete();
    assert.equal(fs.existsSync(lote.finalDir), false);
    lote.complete();

    assert.equal(
      path.basename(lote.finalDir),
      "2026-09-18-1828 - Story pessoa - Todos"
    );
    assert.equal(fs.existsSync(primeiro.finalFile("md")), true);
    assert.equal(fs.existsSync(segundo.finalFile("jpg")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
