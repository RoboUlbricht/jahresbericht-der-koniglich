#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { normalizeAuthorName } from './normalize-authors.js';

function printUsage() {
  console.error('Chyba: Nebola zadaná cesta k súboru articles.json.');
  console.error('Použitie: node src/md-index.js <cesta-k-articles.json>');
  console.error('Alebo:    npm run md-index <cesta-k-articles.json>');
  console.error('Príklad:  node src/md-index.js data/jahresbericht/articles.json');
}

/**
 * Bezpečne načíta a sparcuje JSON súbor (ošetruje aj UTF-8 BOM).
 * @param {string} filePath
 * @returns {object}
 */
function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(content);
}

/**
 * Pokúsi sa nájsť a načítať data/index.json pre dohľadanie originálnych zdrojov (URL).
 * @param {string} articlesFullPath
 * @returns {object|null}
 */
function findAndLoadIndexJson(articlesFullPath) {
  const baseDir = path.dirname(articlesFullPath);
  const candidates = [
    path.join(baseDir, 'index.json'),
    path.join(baseDir, '..', 'index.json'),
    path.resolve(process.cwd(), 'data', 'index.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        return readJsonFile(candidate);
      } catch (err) {
        console.warn(`Varovanie: Nepodarilo sa prečítať ${candidate}:`, err.message);
      }
    }
  }
  return null;
}

/**
 * Dohľadá URL originálneho zdroja pre daný článok/ročník z index.json.
 * @param {string} magDirName
 * @param {number|string} year
 * @param {string} pdfId
 * @param {object|null} indexData
 * @returns {string|null}
 */
function resolveOrigin(magDirName, year, pdfId, indexData) {
  if (!indexData || !Array.isArray(indexData.magazines)) return null;

  // 1. Vyhľadanie podľa adresára časopisu
  const mag = indexData.magazines.find(
    (m) => m.directory && m.directory.toLowerCase() === (magDirName || '').toLowerCase()
  );

  if (mag && Array.isArray(mag.published)) {
    // 1a. Zhoda podľa roku a ID
    if (year && pdfId) {
      const match = mag.published.find(
        (p) => Number(p.year) === Number(year) && p.id === pdfId
      );
      if (match?.origin) return match.origin;
    }
    // 1b. Zhoda podľa ID v rámci časopisu
    if (pdfId) {
      const match = mag.published.find((p) => p.id === pdfId);
      if (match?.origin) return match.origin;
    }
    // 1c. Zhoda podľa roku v rámci časopisu
    if (year) {
      const match = mag.published.find((p) => Number(p.year) === Number(year));
      if (match?.origin) return match.origin;
    }
  }

  // 2. Globálne vyhľadanie podľa pdfId naprieč všetkými časopismi
  if (pdfId) {
    for (const m of indexData.magazines) {
      if (Array.isArray(m.published)) {
        const match = m.published.find((p) => p.id === pdfId);
        if (match?.origin) return match.origin;
      }
    }
  }

  return null;
}

/**
 * Zoradí články vzostupne podľa čísla strany (sekundárne podľa čísla strany v PDF).
 * @param {Array} articles
 * @returns {Array}
 */
function sortArticlesByPage(articles) {
  if (!Array.isArray(articles)) return [];
  return [...articles].sort((a, b) => {
    const pageA = typeof a.page === 'number' ? a.page : parseInt(a.page, 10) || 0;
    const pageB = typeof b.page === 'number' ? b.page : parseInt(b.page, 10) || 0;
    if (pageA !== pageB) {
      return pageA - pageB;
    }
    const pdfPageA = typeof a.pdf_page === 'number' ? a.pdf_page : parseInt(a.pdf_page, 10) || 0;
    const pdfPageB = typeof b.pdf_page === 'number' ? b.pdf_page : parseInt(b.pdf_page, 10) || 0;
    return pdfPageA - pdfPageB;
  });
}

/**
 * Vytvorí slug pre kotvu (anchor link) v Markdowne.
 * @param {string} text
 * @returns {string}
 */
function toSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Ošetrí znaky pre bezpečné vloženie do Markdown tabuľky.
 * @param {string} text
 * @returns {string}
 */
function escapeTableText(text) {
  if (!text) return '-';
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Vygeneruje Markdown obsah pre jeden ročník.
 * @param {string} magazineTitle
 * @param {string} magDirName
 * @param {object} volume
 * @param {object|null} indexData
 * @returns {string}
 */
function generateVolumeMarkdown(magazineTitle, magDirName, volume, indexData) {
  const articles = sortArticlesByPage(volume.articles || []);
  const year = volume.year;

  const lines = [];

  lines.push(`Ročník ${year}`);
  lines.push('');
  lines.push(`- **Časopis:** ${magazineTitle || '-'}`);
  lines.push(`- **Ročník:** ${year}`);
  lines.push(`- **Počet článkov:** ${articles.length}`);
  lines.push('');

  if (articles.length === 0) {
    lines.push('*V tomto ročníku nie sú evidované žiadne články.*');
    lines.push('');
    return lines.join('\n');
  }

  // Prehľadová tabuľka
  lines.push('### Prehľad obsahu');
  lines.push('');
  lines.push('| # | Strana | Autor | Slovenský názov | Originálny názov | PDF strana |');
  lines.push('|---|--------|-------|-----------------|------------------|------------|');

  articles.forEach((art, idx) => {
    const num = idx + 1;
    const author = art.author ? normalizeAuthorName(art.author) : '—';
    const skTitle = art.title_sk || art.title_de || art.title_hu || art.title_en || 'Bez názvu';
    const origTitle = art.title_de || art.title_hu || art.title_en || '—';
    const page = art.page !== undefined && art.page !== null ? art.page : '-';
    const pdfPage = art.pdf_page !== undefined && art.pdf_page !== null ? art.pdf_page : '-';

    const baseOrigin =
      art.origin ||
      volume.origin ||
      resolveOrigin(magDirName, volume.year, art.pdf_id, indexData);

    const originUrlWithPage =
      baseOrigin && baseOrigin.toLowerCase().endsWith('.pdf') && art.pdf_page
        ? `${baseOrigin}#page=${art.pdf_page}`
        : baseOrigin;

    const pdfPageCell =
      pdfPage !== '-' && originUrlWithPage
        ? `[${pdfPage}](${originUrlWithPage})`
        : pdfPage;

    const headingText = art.author
      ? `${num}. ${normalizeAuthorName(art.author)}: ${skTitle}`
      : `${num}. ${skTitle}`;
    const slug = toSlug(headingText);

    lines.push(
      `| ${num} | ${page} | ${escapeTableText(author)} | [${escapeTableText(skTitle)}](#${slug}) | ${escapeTableText(origTitle)} | ${pdfPageCell} |`
    );
  });

  lines.push('');
  lines.push('---');
  lines.push('');

  // Samostatné sekcie pre každý článok
  articles.forEach((art, idx) => {
    const num = idx + 1;
    const rawAuthor = art.author ? normalizeAuthorName(art.author) : '';
    const skTitle = art.title_sk || art.title_de || art.title_hu || art.title_en || 'Bez názvu';
    const headingText = rawAuthor ? `${num}. ${rawAuthor}: ${skTitle}` : `${num}. ${skTitle}`;

    const baseOrigin =
      art.origin ||
      volume.origin ||
      resolveOrigin(magDirName, volume.year, art.pdf_id, indexData);

    const originUrlWithPage =
      baseOrigin && baseOrigin.toLowerCase().endsWith('.pdf') && art.pdf_page
        ? `${baseOrigin}#page=${art.pdf_page}`
        : baseOrigin;

    lines.push(`### ${headingText}`);
    lines.push('');
    lines.push(`- **Autor:** ${rawAuthor ? rawAuthor : '*Neuvedený*'}`);
    lines.push(`- **Strana v tlači:** ${art.page !== undefined && art.page !== null ? art.page : '-'}`);

    if (art.pdf_id || art.pdf_page !== undefined || originUrlWithPage) {
      let idPart = '';
      if (art.pdf_id) {
        idPart = originUrlWithPage
          ? `[\`${art.pdf_id}\`](${originUrlWithPage})`
          : `\`${art.pdf_id}\``;
      } else if (originUrlWithPage) {
        idPart = `[Originálny zdroj](${originUrlWithPage})`;
      }

      const pagePart =
        art.pdf_page !== undefined && art.pdf_page !== null
          ? `strana ${art.pdf_page}`
          : '';

      const pdfInfo = [idPart, pagePart ? `(${pagePart})` : ''].filter(Boolean).join(' ');
      lines.push(`- **PDF:** ${pdfInfo || '-'}`);
    } else {
      lines.push('- **PDF:** -');
    }

    lines.push(`- **Pôvodný jazyk:** ${art.language || '-'}`);
    lines.push('- **Názvy:**');
    lines.push(`  - **Slovenský (SK):** ${art.title_sk || '-'}`);
    lines.push(`  - **Nemecký (DE):** ${art.title_de || '-'}`);
    lines.push(`  - **Anglický (EN):** ${art.title_en || '-'}`);
    lines.push(`  - **Maďarský (HU):** ${art.title_hu || '-'}`);
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Vygeneruje súhrnný index.md so zoznamom všetkých ročníkov.
 * @param {string} magazineTitle
 * @param {Array} volumes
 * @returns {string}
 */
function generateIndexMarkdown(magazineTitle, volumes) {
  const lines = [];
  lines.push(`# ${magazineTitle || 'Časopis'} – Zoznam ročníkov`);
  lines.push('');
  lines.push(`Celkový počet spracovaných ročníkov: **${volumes.length}**`);
  lines.push('');
  lines.push('| Ročník | Počet článkov | Odkaz na obsah |');
  lines.push('|--------|---------------|----------------|');

  const sortedVolumes = [...volumes].sort((a, b) => (Number(a.year) || 0) - (Number(b.year) || 0));

  for (const vol of sortedVolumes) {
    const count = Array.isArray(vol.articles) ? vol.articles.length : 0;
    lines.push(`| ${vol.year} | ${count} | [${vol.year}.md](./${vol.year}.md) |`);
  }

  lines.push('');
  return lines.join('\n');
}

async function main() {
  const inputPath = process.argv[2];

  if (!inputPath) {
    printUsage();
    process.exit(1);
  }

  const articlesFullPath = path.resolve(process.cwd(), inputPath);

  if (!fs.existsSync(articlesFullPath)) {
    console.error(`Chyba: Súbor neexistuje: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Čítam súbor: ${inputPath}`);

  let articlesData;
  try {
    articlesData = readJsonFile(articlesFullPath);
  } catch (err) {
    console.error(`Chyba pri čítaní / parsovaní JSON:`, err.message);
    process.exit(1);
  }

  const magazineTitle = articlesData.title || '';
  const volumes = articlesData.volumes || [];

  const baseDir = path.dirname(articlesFullPath);
  const magDirName = path.basename(baseDir);
  const mdDir = path.join(baseDir, 'md');

  const indexData = findAndLoadIndexJson(articlesFullPath);
  if (indexData) {
    console.log(`Načítaný index zdrojov (index.json) pre časopis "${magDirName}".`);
  }

  if (!fs.existsSync(mdDir)) {
    fs.mkdirSync(mdDir, { recursive: true });
    console.log(`Vytvorený podadresár: ${path.relative(process.cwd(), mdDir)}`);
  }

  if (!Array.isArray(volumes) || volumes.length === 0) {
    console.log('Upozornenie: V súbore sa nenachádzajú žiadne ročníky.');
    return;
  }

  console.log(`Časopis: "${magazineTitle}"`);
  console.log(`Nájdených ročníkov: ${volumes.length}`);

  let generatedCount = 0;
  for (const volume of volumes) {
    if (!volume.year) {
      console.warn(`Preskakujem ročník bez definovaného roku.`);
      continue;
    }

    const mdContent = generateVolumeMarkdown(magazineTitle, magDirName, volume, indexData);
    const volumeFileName = `${volume.year}.md`;
    const volumeFilePath = path.join(mdDir, volumeFileName);

    fs.writeFileSync(volumeFilePath, mdContent, 'utf-8');
    console.log(
      `  ✓ Vygenerovaný ročník ${volume.year} -> ${path.relative(process.cwd(), volumeFilePath)} (${(volume.articles || []).length} článkov)`
    );
    generatedCount++;
  }

  // Vygenerovanie súhrnného index.md
  const indexContent = generateIndexMarkdown(magazineTitle, volumes);
  const indexFilePath = path.join(mdDir, 'index.md');
  fs.writeFileSync(indexFilePath, indexContent, 'utf-8');
  console.log(`  ✓ Vygenerovaný súhrnný zoznam -> ${path.relative(process.cwd(), indexFilePath)}`);

  console.log(`\nHotovo! Úspešne vygenerovaných ${generatedCount} ročníkov do ${path.relative(process.cwd(), mdDir)}.`);
}

main().catch((err) => {
  console.error('Neočakávaná chyba:', err);
  process.exit(1);
});
