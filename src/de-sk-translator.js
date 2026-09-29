#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGeminiConfig } from './ai-translator.js';
import { splitIntoPages, assembleDocument } from './normalize-de-text.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTRUCTION_FILE = path.join(__dirname, 'ai-instructions', 'de-sk-translator.md');

/**
 * Načíta systémové inštrukcie pre preklad z nemčiny do slovenčiny
 * @returns {string}
 */
export function getDeSkTranslatorInstruction() {
  if (!fs.existsSync(INSTRUCTION_FILE)) {
    throw new Error(`Súbor so systémovými inštrukciami neexistuje: ${INSTRUCTION_FILE}`);
  }
  return fs.readFileSync(INSTRUCTION_FILE, 'utf-8').trim();
}

/**
 * Odstráni obalujúci markdown kódový blok (```markdown ... ```)
 * @param {string} text 
 * @returns {string}
 */
function stripCodeFences(text) {
  let cleaned = text.trim();
  const fenceRegex = /^```(?:markdown|md|text)?\r?\n([\s\S]*?)\r?\n```$/;
  const match = cleaned.match(fenceRegex);
  if (match) {
    return match[1].trim();
  }
  return cleaned;
}

/**
 * Zavolá Gemini API na preklad jedného bloku (chunku) textu do slovenčiny
 * @param {string} chunkText 
 * @param {string} systemInstruction 
 * @param {Object} config { apiKey, model }
 * @returns {Promise<string>}
 */
async function callGeminiTranslate(chunkText, systemInstruction, config) {
  const { apiKey, model } = config;
  if (!apiKey) {
    throw new Error('V .env chýba GEMINI_API_KEY.');
  }

  const userPrompt = `Prelož nasledujúci historický text z nemčiny do slovenčiny podľa systémových inštrukcií.
Dôsledne zachovaj značky strán v tvare "## Page: X", kurzívu *...*, poznámky pod čiarou > *) a prípadné metaznačky [Tab:] / [Img:].
Vráť výhradne slovenský preklad bez dodatočných komentárov a bez formátovania do kódového bloku.

Text na preklad:
${chunkText}`;

  const candidateModels = [model, 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'].filter(Boolean);
  let lastError = null;

  for (const m of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }]
            }
          ],
          generationConfig: {
            temperature: 0.1
          }
        })
      });

      if (!response.ok) {
        const errBody = await response.text();
        lastError = new Error(`Gemini API (${m}) HTTP ${response.status}: ${errBody}`);
        continue;
      }

      const resData = await response.json();
      const rawText = resData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error(`Prázdna odpoveď od modelu ${m}.`);
      }

      return stripCodeFences(rawText);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Nepodarilo sa preložiť text cez Gemini API.');
}

/**
 * Preloží rozsah strán do slovenčiny.
 * Prioritne použije normalizovaný text, ak existuje, inak pôvodný neupravený.
 * @param {Object} options
 * @param {string} options.inputFile Cesta k pôvodnému alebo vstupnému súboru
 * @param {number} options.fromPage Začiatočná strana
 * @param {number} options.toPage Koncová strana
 * @param {number} [options.chunkSize=3] Počet strán v jednej dávke
 * @param {boolean} [options.onlyRange=false] Uložiť do výstupu len zadané strany
 * @param {number} [options.delayMs=800] Pauza medzi volaniami API
 * @returns {Promise<{ outputPath: string, pagesProcessed: number }>}
 */
export async function translateDeToSk({
  inputFile,
  fromPage,
  toPage,
  chunkSize = 3,
  onlyRange = false,
  delayMs = 800
}) {
  const fullInputPath = path.resolve(process.cwd(), inputFile);
  if (!fs.existsSync(fullInputPath)) {
    throw new Error(`Vstupný súbor neexistuje: ${inputFile}`);
  }

  const parsed = path.parse(fullInputPath);
  
  // Odvodenie názvu pôvodného súboru (ak by používateľ zadal už normalized-*.txt)
  let originalBaseName = parsed.base;
  if (originalBaseName.startsWith('normalized-')) {
    originalBaseName = originalBaseName.replace(/^normalized-/, '');
  }

  const originalFilePath = path.join(parsed.dir, originalBaseName);
  const normalizedFilePath = path.join(parsed.dir, `normalized-${originalBaseName}`);
  const outputPath = path.join(parsed.dir, `sk-${originalBaseName}`);

  console.log('='.repeat(65));
  console.log('  PREKLAD HISTORICKÉHO TEXTU DO SLOVENČINY (DE -> SK)');
  console.log('='.repeat(65));
  console.log(`Vstupný súbor:      ${inputFile}`);
  console.log(`Výstupný súbor:     ${path.relative(process.cwd(), outputPath)}`);
  console.log(`Rozsah strán:       ${fromPage} až ${toPage}`);
  console.log(`Veľkosť dávky:      ${chunkSize} ${chunkSize === 1 ? 'strana' : 'strany'}`);

  // 1. Načítanie pôvodného súboru
  if (!fs.existsSync(originalFilePath)) {
    throw new Error(`Základný súbor neexistuje: ${originalFilePath}`);
  }
  const originalRawContent = fs.readFileSync(originalFilePath, 'utf-8');
  const originalPagesMap = splitIntoPages(originalRawContent);
  const allPageNumbers = Array.from(originalPagesMap.keys()).sort((a, b) => a - b);

  if (allPageNumbers.length === 0) {
    throw new Error('Vo vstupnom súbore sa nenašli žiadne strany označené formátom "## Page: X".');
  }

  // 2. Načítanie normalizovaného súboru, ak existuje
  let normalizedPagesMap = null;
  if (fs.existsSync(normalizedFilePath)) {
    console.log(`Normalizovaný súbor: ${path.relative(process.cwd(), normalizedFilePath)} (nájdený ✓)`);
    const normRawContent = fs.readFileSync(normalizedFilePath, 'utf-8');
    normalizedPagesMap = splitIntoPages(normRawContent);
  } else {
    console.log(`Normalizovaný súbor: Nenájdený (použije sa pôvodný text).`);
  }

  const systemInstruction = getDeSkTranslatorInstruction();
  const config = getGeminiConfig();
  console.log(`Použitý model:      ${config.model}`);
  console.log('-'.repeat(65));

  const minDocPage = allPageNumbers[0];
  const maxDocPage = allPageNumbers[allPageNumbers.length - 1];

  const actualFrom = Math.max(minDocPage, fromPage);
  const actualTo = Math.min(maxDocPage, toPage);

  if (actualFrom > actualTo) {
    throw new Error(`Neplatný rozsah strán: od ${actualFrom} do ${actualTo} (dokument má strany ${minDocPage} až ${maxDocPage}).`);
  }

  // 3. Výstupná mapa strán
  let skPagesMap;
  if (!onlyRange && fs.existsSync(outputPath)) {
    console.log(`ℹ Existujúci výstupný súbor nájdený. Bude aktualizovaný o strany ${actualFrom} až ${actualTo}.`);
    const existingOutputContent = fs.readFileSync(outputPath, 'utf-8');
    skPagesMap = splitIntoPages(existingOutputContent);
    for (const p of allPageNumbers) {
      if (!skPagesMap.has(p)) {
        skPagesMap.set(p, '');
      }
    }
  } else if (!onlyRange) {
    // Nový súbor: inicializujeme prázdne strany so zachovanou štruktúrou
    skPagesMap = new Map();
    for (const p of allPageNumbers) {
      skPagesMap.set(p, '');
    }
  } else {
    skPagesMap = new Map();
  }

  // 4. Zostavenie zoznamu cieľových strán a rozdelenie do dávok
  const targetPages = [];
  for (let p = actualFrom; p <= actualTo; p++) {
    if (originalPagesMap.has(p)) {
      targetPages.push(p);
    }
  }

  const chunks = [];
  for (let i = 0; i < targetPages.length; i += chunkSize) {
    chunks.push(targetPages.slice(i, i + chunkSize));
  }

  console.log(`Počet strán na preklad: ${targetPages.length} v ${chunks.length} dávkach.\n`);

  // 5. Spracovanie dávok
  let processedCount = 0;
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkPageNumbers = chunks[idx];
    const chunkStart = chunkPageNumbers[0];
    const chunkEnd = chunkPageNumbers[chunkPageNumbers.length - 1];
    const label = chunkStart === chunkEnd ? `s. ${chunkStart}` : `s. ${chunkStart} - ${chunkEnd}`;

    // Zistíme zdroj textu pre každú stranu (normalizovaný vs pôvodný)
    let sourceTypes = [];
    let chunkSourceText = '';
    let hasAnyContent = false;

    for (const pNum of chunkPageNumbers) {
      let pageText = '';
      let isNormalized = false;

      if (normalizedPagesMap && normalizedPagesMap.has(pNum) && normalizedPagesMap.get(pNum).trim()) {
        pageText = normalizedPagesMap.get(pNum);
        isNormalized = true;
      } else {
        pageText = originalPagesMap.get(pNum) || '';
      }

      if (pageText.trim()) {
        hasAnyContent = true;
      }

      sourceTypes.push(isNormalized ? 'norm' : 'orig');

      chunkSourceText += `## Page: ${pNum}\n`;
      if (pageText) {
        chunkSourceText += `${pageText}\n`;
      }
      chunkSourceText += '\n';
    }

    const normCount = sourceTypes.filter(s => s === 'norm').length;
    const sourceLabel = normCount === chunkPageNumbers.length 
      ? 'normalizovaný' 
      : (normCount === 0 ? 'pôvodný' : `${normCount}/${chunkPageNumbers.length} norm.`);

    process.stdout.write(`[${idx + 1}/${chunks.length}] Prekladám ${label} (${sourceLabel})... `);

    // Ak na žiadnej strane nie je žiadny text (napr. úvodné prázdne strany)
    if (!hasAnyContent) {
      console.log('Preskočené (prázdne strany).');
      for (const pNum of chunkPageNumbers) {
        skPagesMap.set(pNum, '');
      }
      processedCount += chunkPageNumbers.length;
      continue;
    }

    try {
      const translatedChunkText = await callGeminiTranslate(chunkSourceText.trim(), systemInstruction, config);
      const translatedPages = splitIntoPages(translatedChunkText);

      for (const pNum of chunkPageNumbers) {
        if (translatedPages.has(pNum)) {
          skPagesMap.set(pNum, translatedPages.get(pNum));
        } else {
          console.warn(`\n  ⚠ Varovanie: Model nevrátil hlavičku pre stranu ${pNum}.`);
        }
      }

      processedCount += chunkPageNumbers.length;
      console.log('✓ OK');

      // Priebežné uloženie stavu
      const pagesToOutput = onlyRange ? targetPages : allPageNumbers;
      const assembledDoc = assembleDocument(skPagesMap, pagesToOutput);
      fs.writeFileSync(outputPath, assembledDoc, 'utf-8');

      if (idx < chunks.length - 1 && delayMs > 0) {
        await new Promise(res => setTimeout(res, delayMs));
      }
    } catch (err) {
      console.log('✗ CHYBA!');
      console.error(`Chyba pri preklade dávky ${label}:`, err.message);
      throw err;
    }
  }

  console.log('\n' + '='.repeat(65));
  console.log(`✅ HOTOVO! Úspešne preložených ${processedCount} strán do slovenčiny.`);
  console.log(`Uložené do: ${outputPath}`);
  console.log('='.repeat(65));

  return {
    outputPath,
    pagesProcessed: processedCount
  };
}

// Spustenie z príkazového riadka
function parseArgs(args) {
  let inputFile = null;
  let fromPage = null;
  let toPage = null;
  let chunkSize = 3;
  let onlyRange = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--from' || arg === '-f') {
      fromPage = parseInt(args[++i], 10);
    } else if (arg === '--to' || arg === '-t') {
      toPage = parseInt(args[++i], 10);
    } else if (arg === '--batch' || arg === '--chunk' || arg === '-b') {
      chunkSize = parseInt(args[++i], 10);
    } else if (arg === '--only-range') {
      onlyRange = true;
    } else if (arg.startsWith('--pages=') || arg.startsWith('-p=')) {
      const parts = arg.split('=')[1].split('-');
      fromPage = parseInt(parts[0], 10);
      toPage = parts[1] ? parseInt(parts[1], 10) : fromPage;
    } else if (!inputFile) {
      inputFile = arg;
    } else if (fromPage === null && arg.includes('-')) {
      const parts = arg.split('-');
      fromPage = parseInt(parts[0], 10);
      toPage = parts[1] ? parseInt(parts[1], 10) : fromPage;
    } else if (fromPage === null && /^\d+$/.test(arg)) {
      fromPage = parseInt(arg, 10);
    } else if (toPage === null && /^\d+$/.test(arg)) {
      toPage = parseInt(arg, 10);
    }
  }

  if (fromPage !== null && toPage === null) {
    toPage = fromPage;
  }

  return { inputFile, fromPage, toPage, chunkSize, onlyRange };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const { inputFile, fromPage, toPage, chunkSize, onlyRange } = parseArgs(process.argv.slice(2));

  if (!inputFile || fromPage === null || toPage === null) {
    console.log(`
Použitie:
  node src/de-sk-translator.js <cesta-k-suboru> <od-strany> [do-strany] [možnosti]

Príklady:
  node src/de-sk-translator.js data/reise/1808/reise.txt 14 16
  node src/de-sk-translator.js data/reise/1808/reise.txt 14-16
  node src/de-sk-translator.js data/reise/1808/reise.txt --from 14 --to 16
  node src/de-sk-translator.js data/reise/1808/reise.txt 15

Možnosti:
  --batch <n>, -b <n>   Počet strán v jednej dávke (predvolené: 3)
  --only-range          Uložiť do výstupného súboru len zadané strany (nie celý dokument)
`);
    process.exit(1);
  }

  translateDeToSk({
    inputFile,
    fromPage,
    toPage,
    chunkSize: chunkSize || 3,
    onlyRange
  }).catch(err => {
    console.error('\nChyba pri behu skriptu:', err.message);
    process.exit(1);
  });
}
