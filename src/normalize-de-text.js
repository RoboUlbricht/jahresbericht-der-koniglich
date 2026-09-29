#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGeminiConfig } from './ai-translator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTRUCTION_FILE = path.join(__dirname, 'ai-instructions', 'de-repair-ocr.md');

/**
 * Načíta systémové inštrukcie pre opravu historického OCR textu
 * @returns {string}
 */
export function getOcrRepairInstruction() {
  if (!fs.existsSync(INSTRUCTION_FILE)) {
    throw new Error(`Súbor so systémovými inštrukciami neexistuje: ${INSTRUCTION_FILE}`);
  }
  return fs.readFileSync(INSTRUCTION_FILE, 'utf-8').trim();
}

/**
 * Rozdelí text súboru na jednotlivé strany podľa značiek "## Page: X"
 * @param {string} content 
 * @returns {Map<number, string>}
 */
export function splitIntoPages(content) {
  const pages = new Map();
  const regex = /(?:^|\r?\n)## Page: (\d+)(?:\r?\n|$)/g;
  let match;
  let lastPageNum = null;
  let lastIndex = 0;

  while ((match = regex.exec(content)) !== null) {
    if (lastPageNum !== null) {
      const pageText = content.slice(lastIndex, match.index).trim();
      pages.set(lastPageNum, pageText);
    }
    lastPageNum = parseInt(match[1], 10);
    lastIndex = match.index + match[0].length;
  }

  if (lastPageNum !== null) {
    const pageText = content.slice(lastIndex).trim();
    pages.set(lastPageNum, pageText);
  }

  return pages;
}

/**
 * Zostaví kompletný text dokumentu zo zoznamu strán
 * @param {Map<number, string>} pagesMap 
 * @param {number[]} orderedPageNumbers 
 * @returns {string}
 */
export function assembleDocument(pagesMap, orderedPageNumbers) {
  let doc = '';
  for (const pageNum of orderedPageNumbers) {
    const text = pagesMap.get(pageNum) || '';
    doc += `## Page: ${pageNum}\n`;
    if (text) {
      doc += `${text}\n`;
    }
    doc += '\n';
  }
  return doc.trimEnd() + '\n';
}

/**
 * Odstráni prípadný obalujúci markdown kódový blok (```markdown ... ```)
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
 * Zavolá Gemini API na opravu jedného bloku (chunku) textu
 * @param {string} chunkText Text obsahujúci strany so značkami ## Page: X
 * @param {string} systemInstruction 
 * @param {Object} config { apiKey, model }
 * @returns {Promise<string>}
 */
async function callGeminiRepair(chunkText, systemInstruction, config) {
  const { apiKey, model } = config;
  if (!apiKey) {
    throw new Error('V .env chýba GEMINI_API_KEY.');
  }

  const userPrompt = `Oprav nasledujúci historický nemecký text podľa systémových inštrukcií.
Dôsledne zachovaj značky strán v tvare "## Page: X", kurzívu *...*, poznámky pod čiarou > *) a prípadné metaznačky [Tab:] / [Img:].
Vráť výhradne opravený text bez dodatočných komentárov a bez formátovania do kódového bloku.

Text na opravu:
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

  throw lastError || new Error('Nepodarilo sa opraviť text cez Gemini API.');
}

/**
 * Normalizuje rozsah strán zadaného textového súboru
 * @param {Object} options
 * @param {string} options.inputFile Cesta k vstupnému .txt súboru
 * @param {number} options.fromPage Začiatočná strana
 * @param {number} options.toPage Koncová strana
 * @param {number} [options.chunkSize=4] Počet strán spracovávaných v jednej dávke
 * @param {boolean} [options.onlyRange=false] Uložiť do výstupného súboru len zadaný rozsah
 * @param {number} [options.delayMs=800] Pauza medzi volaniami API
 * @returns {Promise<{ outputPath: string, pagesProcessed: number }>}
 */
export async function normalizeDeText({
  inputFile,
  fromPage,
  toPage,
  chunkSize = 4,
  onlyRange = false,
  delayMs = 800
}) {
  const fullInputPath = path.resolve(process.cwd(), inputFile);
  if (!fs.existsSync(fullInputPath)) {
    throw new Error(`Vstupný súbor neexistuje: ${inputFile}`);
  }

  const parsed = path.parse(fullInputPath);
  const outputPath = path.join(parsed.dir, `normalized-${parsed.base}`);

  console.log('='.repeat(65));
  console.log('  NORMALIZÁCIA A OPRAVA HISTORICKÉHO OCR TEXTU (GEMINI)');
  console.log('='.repeat(65));
  console.log(`Vstupný súbor:  ${inputFile}`);
  console.log(`Výstupný súbor: ${path.relative(process.cwd(), outputPath)}`);
  console.log(`Rozsah strán:   ${fromPage} až ${toPage}`);
  console.log(`Veľkosť dávky:  ${chunkSize} ${chunkSize === 1 ? 'strana' : 'strany'}`);

  const systemInstruction = getOcrRepairInstruction();
  const config = getGeminiConfig();
  console.log(`Použitý model:  ${config.model}`);
  console.log('-'.repeat(65));

  // 1. Načítanie pôvodného súboru
  const originalRawContent = fs.readFileSync(fullInputPath, 'utf-8');
  const originalPagesMap = splitIntoPages(originalRawContent);
  const allPageNumbers = Array.from(originalPagesMap.keys()).sort((a, b) => a - b);

  if (allPageNumbers.length === 0) {
    throw new Error('Vo vstupnom súbore sa nenašli žiadne strany označené formátom "## Page: X".');
  }

  const minDocPage = allPageNumbers[0];
  const maxDocPage = allPageNumbers[allPageNumbers.length - 1];

  const actualFrom = Math.max(minDocPage, fromPage);
  const actualTo = Math.min(maxDocPage, toPage);

  if (actualFrom > actualTo) {
    throw new Error(`Neplatný rozsah strán: od ${actualFrom} do ${actualTo} (dokument má strany ${minDocPage} až ${maxDocPage}).`);
  }

  // 2. Cieľová mapa strán: Ak už výstupný súbor existuje a nechceme len rozsah, načítame ho ako základ
  let workingPagesMap;
  if (!onlyRange && fs.existsSync(outputPath)) {
    console.log(`ℹ Existujúci výstupný súbor nájdený. Bude aktualizovaný o strany ${actualFrom} až ${actualTo}.`);
    const existingOutputContent = fs.readFileSync(outputPath, 'utf-8');
    workingPagesMap = splitIntoPages(existingOutputContent);
    // Doplníme prípadné chýbajúce strany z originálu
    for (const p of allPageNumbers) {
      if (!workingPagesMap.has(p)) {
        workingPagesMap.set(p, originalPagesMap.get(p) || '');
      }
    }
  } else if (!onlyRange) {
    // Vytvoríme kópiu z originálu
    workingPagesMap = new Map(originalPagesMap);
  } else {
    // Iba zadaný rozsah
    workingPagesMap = new Map();
  }

  // 3. Vytvorenie dávok (chunkov) na spracovanie
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

  console.log(`Počet strán na opravu: ${targetPages.length} v ${chunks.length} dávkach.\n`);

  // 4. Spracovanie po dávkach
  let processedCount = 0;
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkPageNumbers = chunks[idx];
    const chunkStart = chunkPageNumbers[0];
    const chunkEnd = chunkPageNumbers[chunkPageNumbers.length - 1];
    const label = chunkStart === chunkEnd ? `s. ${chunkStart}` : `s. ${chunkStart} - ${chunkEnd}`;

    process.stdout.write(`[${idx + 1}/${chunks.length}] Spracovávam ${label}... `);

    // Zostavíme text pre túto dávku z pôvodných strán
    let chunkSourceText = '';
    for (const pNum of chunkPageNumbers) {
      const pageText = originalPagesMap.get(pNum) || '';
      chunkSourceText += `## Page: ${pNum}\n`;
      if (pageText) {
        chunkSourceText += `${pageText}\n`;
      }
      chunkSourceText += '\n';
    }

    // Ak je dávka úplne prázdna (žiadny text na stranách, len prázdne strany)
    const hasAnyContent = chunkPageNumbers.some(p => (originalPagesMap.get(p) || '').trim().length > 0);
    if (!hasAnyContent) {
      console.log('Preskočené (prázdne strany).');
      for (const pNum of chunkPageNumbers) {
        workingPagesMap.set(pNum, '');
      }
      processedCount += chunkPageNumbers.length;
      continue;
    }

    try {
      const repairedChunkText = await callGeminiRepair(chunkSourceText.trim(), systemInstruction, config);
      const repairedPages = splitIntoPages(repairedChunkText);

      for (const pNum of chunkPageNumbers) {
        if (repairedPages.has(pNum)) {
          workingPagesMap.set(pNum, repairedPages.get(pNum));
        } else {
          // Ak by model náhodou vynechal hlavičku strany, použijeme pôvodný text
          console.warn(`\n  ⚠ Varovanie: Model nevrátil hlavičku pre stranu ${pNum}, ponechávam pôvodný text.`);
        }
      }

      processedCount += chunkPageNumbers.length;
      console.log('✓ OK');

      // Uložíme priebežný stav po každej dávke
      const pagesToOutput = onlyRange ? targetPages : allPageNumbers;
      const assembledDoc = assembleDocument(workingPagesMap, pagesToOutput);
      fs.writeFileSync(outputPath, assembledDoc, 'utf-8');

      if (idx < chunks.length - 1 && delayMs > 0) {
        await new Promise(res => setTimeout(res, delayMs));
      }
    } catch (err) {
      console.log('✗ CHYBA!');
      console.error(`Chyba pri spracovaní dávky ${label}:`, err.message);
      throw err;
    }
  }

  console.log('\n' + '='.repeat(65));
  console.log(`✅ HOTOVO! Úspešne opravených ${processedCount} strán.`);
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
  let chunkSize = 4;
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
  node src/normalize-de-text.js <cesta-k-suboru> <od-strany> [do-strany] [možnosti]

Príklady:
  node src/normalize-de-text.js data/reise/1808/reise.txt 14 16
  node src/normalize-de-text.js data/reise/1808/reise.txt 14-16
  node src/normalize-de-text.js data/reise/1808/reise.txt --from 14 --to 16
  node src/normalize-de-text.js data/reise/1808/reise.txt 15

Možnosti:
  --batch <n>, -b <n>   Počet strán v jednej dávke (predvolené: 4)
  --only-range          Uložiť do výstupného súboru len zadané strany (nie celý dokument)
`);
    process.exit(1);
  }

  normalizeDeText({
    inputFile,
    fromPage,
    toPage,
    chunkSize: chunkSize || 4,
    onlyRange
  }).catch(err => {
    console.error('\nChyba pri behu skriptu:', err.message);
    process.exit(1);
  });
}
