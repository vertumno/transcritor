const fs = require("fs");
const path = require("path");

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatarDataHora(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function sanitizarNome(name) {
  const limpo = String(name || "sem_titulo")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (limpo || "sem_titulo").slice(0, 120).trim();
}

function caminhoUnico(outputRoot, baseName) {
  let candidate = path.join(outputRoot, baseName);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputRoot, `${baseName} (${suffix})`);
    suffix++;
  }
  return candidate;
}

function caminhoArquivoUnico(outputRoot, filename) {
  const extension = path.extname(filename);
  const name = path.basename(filename, extension);
  let candidate = path.join(outputRoot, filename);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outputRoot, `${name} (${suffix})${extension}`);
    suffix++;
  }
  return candidate;
}

function moverArquivo(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
  return destination;
}

function estaDentro(filePath, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function criarTrabalho(outputRoot, title, date = new Date()) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const timestamp = formatarDataHora(date);
  const nome = sanitizarNome(title);
  const baseName = `${timestamp} - ${nome}`;
  const finalDir = caminhoUnico(outputRoot, baseName);
  const finalBaseName = path.basename(finalDir);
  const stagingRoot = path.join(outputRoot, ".processando");
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingRoot, `${finalBaseName} - `));

  return {
    timestamp,
    title: nome,
    baseName: finalBaseName,
    outputRoot,
    stagingDir,
    finalDir,
    file(ext) {
      const suffix = ext.startsWith(".") ? ext : `.${ext}`;
      return path.join(stagingDir, finalBaseName + suffix);
    },
    finalFile(ext) {
      const suffix = ext.startsWith(".") ? ext : `.${ext}`;
      return path.join(finalDir, finalBaseName + suffix);
    },
    archiveMedia(source, { move = true } = {}) {
      const ext = path.extname(source) || ".media";
      const destination = this.file(ext);
      if (path.resolve(source) === path.resolve(destination)) return destination;
      if (move) return moverArquivo(source, destination);
      fs.copyFileSync(source, destination);
      return destination;
    },
    complete() {
      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.renameSync(stagingDir, finalDir);
      return finalDir;
    },
    fail(error) {
      if (!fs.existsSync(stagingDir)) return null;
      fs.writeFileSync(
        path.join(stagingDir, "_ERRO.txt"),
        `${error && error.stack ? error.stack : error}\n`,
        "utf-8"
      );
      const failuresRoot = path.join(outputRoot, "_falhas");
      fs.mkdirSync(failuresRoot, { recursive: true });
      const destination = caminhoUnico(failuresRoot, finalBaseName);
      fs.renameSync(stagingDir, destination);
      return destination;
    },
  };
}

function criarLote(outputRoot, title, date = new Date()) {
  const parent = criarTrabalho(outputRoot, title, date);

  return {
    ...parent,
    item(itemTitle) {
      const itemName = `${parent.timestamp} - ${sanitizarNome(itemTitle)}`;
      return {
        timestamp: parent.timestamp,
        title: sanitizarNome(itemTitle),
        baseName: itemName,
        outputRoot,
        stagingDir: parent.stagingDir,
        finalDir: parent.finalDir,
        file(ext) {
          const suffix = ext.startsWith(".") ? ext : `.${ext}`;
          return path.join(parent.stagingDir, itemName + suffix);
        },
        finalFile(ext) {
          const suffix = ext.startsWith(".") ? ext : `.${ext}`;
          return path.join(parent.finalDir, itemName + suffix);
        },
        archiveMedia(source, { move = true } = {}) {
          const ext = path.extname(source) || ".media";
          const destination = this.file(ext);
          if (path.resolve(source) === path.resolve(destination)) return destination;
          if (move) return moverArquivo(source, destination);
          fs.copyFileSync(source, destination);
          return destination;
        },
        complete() {
          return parent.finalDir;
        },
        fail(error) {
          const destination = this.file(".erro.txt");
          fs.writeFileSync(
            destination,
            `${error && error.stack ? error.stack : error}\n`,
            "utf-8"
          );
          return parent.stagingDir;
        },
      };
    },
  };
}

module.exports = {
  formatarDataHora,
  sanitizarNome,
  caminhoUnico,
  caminhoArquivoUnico,
  estaDentro,
  moverArquivo,
  criarTrabalho,
  criarLote,
};
