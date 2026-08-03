#!/usr/bin/env node

/**
 * Reduz o cookies.txt aos domínios que o transcritor realmente usa.
 *
 * As extensões de exportação costumam despejar TODOS os cookies do navegador
 * — banco, e-mail, gov.br, tudo. Guardar isso numa pasta de projeto é um risco
 * grande e desnecessário: o yt-dlp só precisa da sessão do site do vídeo.
 *
 * Uso:
 *   node filtrar-cookies.js                    # filtra o cookies.txt da pasta
 *   node filtrar-cookies.js meu-arquivo.txt    # filtra outro arquivo
 */

const fs = require("fs");
const path = require("path");

// Apenas os sites de vídeo, e só eles.
//
// `google.com` fica DE FORA de propósito: liberá-lo arrasta junto Gmail,
// Drive, Photos e Calendar — contas críticas que o download não precisa.
// O YouTube público funciona sem login; se algum dia precisar de sessão nele,
// acrescente "youtube.com" ao navegador e exporte só esse domínio.
const DOMINIOS_PERMITIDOS = [
  "instagram.com",
  "cdninstagram.com",
  "facebook.com", // o login do Instagram passa por aqui
  "fbcdn.net",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "vimeo.com",
];

function dominioPermitido(dominio) {
  const limpo = dominio.replace(/^\./, "").toLowerCase();
  return DOMINIOS_PERMITIDOS.some(
    (d) => limpo === d || limpo.endsWith("." + d)
  );
}

function main() {
  const alvo = process.argv[2] || path.join(__dirname, "..", "cookies.txt");

  if (!fs.existsSync(alvo)) {
    console.error(`Arquivo não encontrado: ${alvo}`);
    process.exit(1);
  }

  const linhas = fs.readFileSync(alvo, "utf-8").split("\n");
  const mantidas = [];
  const dominios = new Set();
  let descartadas = 0;

  for (const linha of linhas) {
    const texto = linha.trim();
    if (!texto || texto.startsWith("#")) continue;

    const dominio = texto.split("\t")[0];
    if (!dominio) continue;

    if (dominioPermitido(dominio)) {
      mantidas.push(linha.replace(/\r$/, ""));
      dominios.add(dominio.replace(/^\./, ""));
    } else {
      descartadas++;
    }
  }

  if (mantidas.length === 0) {
    console.error(
      "\nNenhum cookie de site de vídeo encontrado no arquivo.\n" +
        "Confira se você estava logado no Instagram ao exportar."
    );
    process.exit(1);
  }

  const saida = ["# Netscape HTTP Cookie File", ...mantidas, ""].join("\n");
  fs.writeFileSync(alvo, saida, "utf-8");

  console.log(`\nArquivo filtrado: ${alvo}`);
  console.log(`  Mantidos:    ${mantidas.length} cookies`);
  console.log(`  Descartados: ${descartadas} cookies de outros sites`);
  console.log(`  Domínios:    ${[...dominios].sort().join(", ")}\n`);
}

main();
