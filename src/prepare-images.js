#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

// Resolve standard fonts and wasm directory from pdfjs-dist package
const pkgUrl = import.meta.resolve('pdfjs-dist/package.json');
const pkgDir = path.dirname(fileURLToPath(pkgUrl));
const standardFontDataUrl = path.join(pkgDir, 'standard_fonts').replace(/\\/g, '/') + '/';
const wasmUrl = path.join(pkgDir, 'wasm').replace(/\\/g, '/') + '/';

function parseArgs() {
  const args = process.argv.slice(2);
  let relPdfPath = null;
  let targetHeight = 1024;
  let quality = 85;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--height' || arg === '-h') {
      targetHeight = parseInt(args[++i], 10);
    } else if (arg.startsWith('--height=')) {
      targetHeight = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('-h=')) {
      targetHeight = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--quality' || arg === '-q') {
      quality = parseInt(args[++i], 10);
    } else if (arg.startsWith('--quality=')) {
      quality = parseInt(arg.split('=')[1], 10);
    } else if (!relPdfPath) {
      relPdfPath = arg;
    } else if (!isNaN(parseInt(arg, 10))) {
      targetHeight = parseInt(arg, 10);
    }
  }

  return { relPdfPath, targetHeight, quality };
}

async function prepareImages() {
  const { relPdfPath, targetHeight, quality } = parseArgs();

  if (!relPdfPath) {
    console.error('Chyba: Nebola zadaná cesta k PDF súboru.');
    console.error('Použitie: node src/prepare-images.js <relatívna-cesta-k-pdf> [výška-v-pixeloch]');
    console.error('Príklad: node src/prepare-images.js data/jahresbericht/1883/V05aAAAAYAAJ.pdf 1024');
    process.exit(1);
  }

  if (isNaN(targetHeight) || targetHeight <= 0) {
    console.error(`Chyba: Neplatná výška obrázku: ${targetHeight}. Musí to byť kladné celé číslo.`);
    process.exit(1);
  }

  const pdfFullPath = path.resolve(process.cwd(), relPdfPath);

  if (!fs.existsSync(pdfFullPath)) {
    console.error(`Chyba: Súbor neexistuje: ${relPdfPath}`);
    process.exit(1);
  }

  const pdfDir = path.dirname(pdfFullPath);
  const imagesDir = path.join(pdfDir, 'images');
  const relImagesDir = path.relative(process.cwd(), imagesDir);

  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  console.log(`Otváram PDF: ${relPdfPath}`);
  console.log(`Cieľový adresár obrázkov: ${relImagesDir}`);
  console.log(`Požadovaná výška obrázkov: ${targetHeight}px (formát JPG, kvalita: ${quality}%)`);

  const data = new Uint8Array(await fs.promises.readFile(pdfFullPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl,
    wasmUrl,
  });
  const doc = await loadingTask.promise;

  const totalPages = doc.numPages;
  console.log(`Počet strán na spracovanie: ${totalPages}`);

  for (let i = 1; i <= totalPages; i++) {
    const page = await doc.getPage(i);
    const unscaledViewport = page.getViewport({ scale: 1.0 });
    const scale = targetHeight / unscaledViewport.height;
    const viewport = page.getViewport({ scale });

    const canvasWidth = Math.round(viewport.width);
    const canvasHeight = Math.round(viewport.height);

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // Vyplnenie bielym pozadím pred vykreslením (pre JPG formát)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    await page.render({
      canvasContext: ctx,
      viewport,
    }).promise;

    const jpgBuffer = canvas.toBuffer('image/jpeg', quality);
    const jpgPath = path.join(imagesDir, `${i}.jpg`);
    await fs.promises.writeFile(jpgPath, jpgBuffer);

    page.cleanup();

    if (i % 5 === 0 || i === totalPages) {
      process.stdout.write(`\rSpracované: ${i} / ${totalPages} strán (${Math.round((i / totalPages) * 100)}%)`);
    }
  }

  await doc.cleanup();
  await loadingTask.destroy();
  console.log(`\nHotovo! Všetky obrázky (${totalPages} strán) boli vytvorené v: ${relImagesDir}`);
}

prepareImages().catch((err) => {
  console.error('\nChyba pri vytváraní obrázkov:', err);
  process.exit(1);
});
