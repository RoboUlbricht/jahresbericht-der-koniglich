#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Resolve standard fonts directory from pdfjs-dist package
const pkgUrl = import.meta.resolve('pdfjs-dist/package.json');
const pkgDir = path.dirname(fileURLToPath(pkgUrl));
const standardFontDataUrl = path.join(pkgDir, 'standard_fonts').replace(/\\/g, '/') + '/';

async function extractPdfText(relPdfPath) {
  if (!relPdfPath) {
    console.error('Chyba: Nebola zadaná cesta k PDF súboru.');
    console.error('Použitie: node src/prepare-text.js <relatívna-cesta-k-pdf>');
    console.error('Príklad: node src/prepare-text.js data/jahresbericht/1883/V05aAAAAYAAJ.pdf');
    process.exit(1);
  }

  const pdfFullPath = path.resolve(process.cwd(), relPdfPath);

  if (!fs.existsSync(pdfFullPath)) {
    console.error(`Chyba: Súbor neexistuje: ${relPdfPath}`);
    process.exit(1);
  }

  const parsed = path.parse(pdfFullPath);
  const txtFullPath = path.join(parsed.dir, `${parsed.name}.txt`);
  const relTxtPath = path.relative(process.cwd(), txtFullPath);

  console.log(`Otváram PDF: ${relPdfPath}`);
  const data = new Uint8Array(await fs.promises.readFile(pdfFullPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl,
  });
  const doc = await loadingTask.promise;

  const totalPages = doc.numPages;
  console.log(`Počet strán: ${totalPages}`);
  console.log(`Cieľový TXT súbor: ${relTxtPath}`);

  const writeStream = fs.createWriteStream(txtFullPath, { encoding: 'utf-8' });

  for (let i = 1; i <= totalPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    let pageText = '';
    for (const item of content.items) {
      pageText += item.str + (item.hasEOL ? '\n' : '');
    }

    page.cleanup();

    const pageHeader = (i > 1 ? '\n' : '') + `## Page: ${i}\n`;
    const trimmed = pageText.trimEnd();
    const pageContent = trimmed ? trimmed + '\n' : '';

    if (!writeStream.write(pageHeader + pageContent)) {
      await new Promise((resolve) => writeStream.once('drain', resolve));
    }

    if (i % 25 === 0 || i === totalPages) {
      process.stdout.write(`\rSpracované: ${i} / ${totalPages} strán (${Math.round((i / totalPages) * 100)}%)`);
    }
  }

  writeStream.end();
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  await doc.cleanup();
  await loadingTask.destroy();
  console.log(`\nHotovo! Všetky strany boli úspešne extrahované do: ${relTxtPath}`);
}

const inputPath = process.argv[2];
extractPdfText(inputPath).catch((err) => {
  console.error('\nChyba pri spracovaní PDF:', err);
  process.exit(1);
});
