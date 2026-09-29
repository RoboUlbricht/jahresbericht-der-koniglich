#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function cleanPunctuation(text) {
  return text
    // Space before closing punctuation: . , ; : ! ? ) ] }
    .replace(/\s+([.,;:!?\)\]\}])/g, '$1')
    // Space after opening punctuation: ( [ {
    .replace(/([\(\[\{])\s+/g, '$1')
    // Space after opening quotes: „ «
    .replace(/([„«])\s+/g, '$1')
    // Space before closing quotes: “ ” »
    .replace(/\s+([”»“])/g, '$1')
    // When " is a closing quote (preceded by non-space, followed by whitespace, punctuation, or EOL)
    .replace(/(\S)\s+(")(?=[\s.,;:!?\)\]]|$)/g, '$1$2')
    // When " is an opening quote (preceded by whitespace, start of line, or opening bracket, followed by space)
    .replace(/(^|[\s\(\[\{])(")\s+(\S)/g, '$1$2$3')
    // Multiple spaces/tabs to single space
    .replace(/[ \t]+/g, ' ');
}

function fixTypographicQuotes(content) {
  // 1. Fix ,, (double comma) misread by OCR as opening quote „
  let fixed = content
    .replace(/(?:,,|, ,)(?=[A-ZÄÖÜa-zäöü])/g, (match, offset, str) => {
      return (offset > 0 && /\w/.test(str[offset - 1])) ? ' „' : '„';
    })
    .replace(/([.,;:!?])„/g, '$1 „');

  // 2. Pair opening „ with closing typographic “ (U+201C)
  let result = '';
  let inQuote = false;

  for (let i = 0; i < fixed.length; i++) {
    const ch = fixed[i];
    if (ch === '„') {
      inQuote = true;
      result += ch;
    } else if (inQuote && (ch === '"' || ch === '”')) {
      result += '“';
      inQuote = false;
    } else if (!inQuote && ch === '"') {
      const prev = i > 0 ? fixed[i - 1] : ' ';
      const next = i + 1 < fixed.length ? fixed[i + 1] : ' ';
      if (!/\s/.test(prev) && (/\s/.test(next) || /[.,;:!?\)\]\-]/.test(next) || i === fixed.length - 1)) {
        result += '“';
      } else if (/\s/.test(prev) && !/\s/.test(next)) {
        result += '„';
        inQuote = true;
      } else {
        result += ch;
      }
    } else {
      result += ch;
    }
  }

  return result;
}

function parseHocrToText(html) {
  if (!html || !html.includes('ocr_page')) {
    return '';
  }

  const parChunks = html.split(/<p[^>]*class=["'][^"']*ocr_par[^>]*>/i).slice(1);
  const paragraphs = [];

  for (const parChunk of parChunks) {
    const parBody = parChunk.split(/<\/p>/i)[0];
    const lineChunks = parBody.split(/<span[^>]*class=["'][^"']*ocr_line[^>]*>/i).slice(1);
    const lines = [];

    for (const lineChunk of lineChunks) {
      const rawText = decodeHtmlEntities(lineChunk.replace(/<[^>]+>/g, ''));
      const text = cleanPunctuation(rawText).trim();
      if (text) {
        lines.push(text);
      }
    }

    if (lines.length > 0) {
      paragraphs.push(lines.join('\n'));
    }
  }

  // Fallback if no <p class="ocr_par"> were matched
  if (paragraphs.length === 0) {
    const lineChunks = html.split(/<span[^>]*class=["'][^"']*ocr_line[^>]*>/i).slice(1);
    const lines = [];
    for (const lineChunk of lineChunks) {
      const rawText = decodeHtmlEntities(lineChunk.replace(/<[^>]+>/g, ''));
      const text = cleanPunctuation(rawText).trim();
      if (text) {
        lines.push(text);
      }
    }
    return fixTypographicQuotes(lines.join('\n'));
  }

  return fixTypographicQuotes(paragraphs.join('\n\n'));
}

function resolveTarget(input) {
  const fullPath = path.resolve(process.cwd(), input);
  if (fs.existsSync(fullPath)) {
    const parsed = path.parse(fullPath);
    const txtPath = path.join(parsed.dir, `${parsed.name}.txt`);
    return {
      bsbId: parsed.name,
      txtPath,
      pdfPath: fullPath,
    };
  }

  const indexPath = path.resolve(process.cwd(), 'data/index.json');
  if (fs.existsSync(indexPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      for (const mag of data.magazines || []) {
        for (const pub of mag.published || []) {
          if (pub.id === input || pub.bsbId === input) {
            const dir = path.resolve(process.cwd(), 'data', mag.directory, String(pub.year));
            const id = pub.id || input;
            return {
              bsbId: id,
              txtPath: path.join(dir, `${id}.txt`),
              pdfPath: path.join(dir, `${id}.pdf`),
            };
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    bsbId: input,
    txtPath: path.resolve(process.cwd(), `${input}.txt`),
    pdfPath: null,
  };
}

function loadExistingPages(txtPath) {
  const pagesMap = new Map();
  if (!fs.existsSync(txtPath)) {
    return pagesMap;
  }

  const content = fs.readFileSync(txtPath, 'utf-8');
  const sections = content.split(/(?=^## Page: \d+)/m);

  for (const sec of sections) {
    const trimmed = sec.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^## Page: (\d+)\r?\n?([\s\S]*)$/);
    if (match) {
      const pageNum = parseInt(match[1], 10);
      pagesMap.set(pageNum, match[2].trim());
    }
  }

  return pagesMap;
}

function writePagesToFile(txtPath, pagesMap) {
  const sortedPageNums = Array.from(pagesMap.keys()).sort((a, b) => a - b);
  let output = '';

  for (let idx = 0; idx < sortedPageNums.length; idx++) {
    const pageNum = sortedPageNums[idx];
    const text = (pagesMap.get(pageNum) || '').trim();
    const isLast = idx === sortedPageNums.length - 1;
    const header = `## Page: ${pageNum}\n`;
    const body = text ? (text + '\n') : '';
    const separator = isLast ? '' : '\n';
    output += header + body + separator;
  }

  fs.writeFileSync(txtPath, output, 'utf-8');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPageHocr(bsbId, pageNum, maxRetries = 3) {
  const url = `https://api.digitale-sammlungen.de/ocr/${bsbId}/${pageNum}`;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) jahresbericht-archive-tool',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (res.status === 404) {
        return null;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      return await res.text();
    } catch (err) {
      if (attempt === maxRetries) {
        throw err;
      }
      await sleep(500 * attempt);
    }
  }
  return null;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const isOverwrite = rawArgs.includes('--overwrite') || rawArgs.includes('--clean');
  const args = rawArgs.filter((a) => !a.startsWith('--'));

  if (args.length < 3) {
    console.error('Použitie: node src/fetch-bsb-text.js <cesta-k-pdf-alebo-bsbId> <od-strany-pdf> <do-strany-pdf> [--overwrite]');
    console.error('Príklad: node src/fetch-bsb-text.js data/geologische-reichsanstalt/1867/bsb10226096.pdf 345 355');
    console.error('Príklad: node src/fetch-bsb-text.js bsb10226096 345 355');
    process.exit(1);
  }

  const input = args[0];
  const fromPdfPage = parseInt(args[1], 10);
  const toPdfPage = parseInt(args[2], 10);

  if (isNaN(fromPdfPage) || isNaN(toPdfPage) || fromPdfPage < 1 || toPdfPage < fromPdfPage) {
    console.error('Chyba: Neplatný rozsah strán (musí platiť 1 <= od-strany <= do-strany).');
    process.exit(1);
  }

  const target = resolveTarget(input);
  const relTxtPath = path.relative(process.cwd(), target.txtPath);

  console.log(`BSB ID: ${target.bsbId}`);
  console.log(`Rozsah strán PDF: ${fromPdfPage} - ${toPdfPage} (spolu ${toPdfPage - fromPdfPage + 1} strán)`);
  console.log(`Zodpovedajúce MDZ skeny (offset -1): ${Math.max(1, fromPdfPage - 1)} - ${toPdfPage - 1}`);
  console.log(`Cieľový TXT súbor: ${relTxtPath}`);

  const pagesMap = isOverwrite ? new Map() : loadExistingPages(target.txtPath);
  if (!isOverwrite && pagesMap.size > 0) {
    console.log(`Existujúci súbor obsahuje ${pagesMap.size} strán. Nové strany sa doplnia/aktualizujú.`);
  }

  let fetchedCount = 0;
  let emptyCount = 0;

  for (let pdfPage = fromPdfPage; pdfPage <= toPdfPage; pdfPage++) {
    const scanPage = pdfPage - 1;
    process.stdout.write(`\r[${pdfPage}/${toPdfPage}] Sťahujem OCR pre PDF stranu ${pdfPage} (scan ${scanPage})...`);

    if (scanPage < 1) {
      // Strana 1 v stiahnutom PDF je automaticky vygenerovaná obálka MDZ
      pagesMap.set(pdfPage, '');
      emptyCount++;
      continue;
    }

    try {
      const hocrHtml = await fetchPageHocr(target.bsbId, scanPage);
      if (!hocrHtml) {
        pagesMap.set(pdfPage, '');
        emptyCount++;
      } else {
        const text = parseHocrToText(hocrHtml);
        pagesMap.set(pdfPage, text);
        if (!text) {
          emptyCount++;
        } else {
          fetchedCount++;
        }
      }
    } catch (err) {
      console.error(`\nChyba pri sťahovaní scanu ${scanPage} (PDF strana ${pdfPage}):`, err.message);
    }

    // Gentle delay to avoid hammering the MDZ API
    await sleep(150);
  }

  writePagesToFile(target.txtPath, pagesMap);

  console.log(`\n\nHotovo!`);
  console.log(`- Strán s textom: ${fetchedCount}`);
  if (emptyCount > 0) {
    console.log(`- Strán bez textu (prázdne/obrázky): ${emptyCount}`);
  }
  console.log(`- Uložené do: ${relTxtPath}`);
}

main().catch((err) => {
  console.error('\nNeočakávaná chyba:', err);
  process.exit(1);
});
