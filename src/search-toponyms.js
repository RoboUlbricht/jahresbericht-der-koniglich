#!/usr/bin/env node

/**
 * Nástroj na vyhľadávanie toponým, montánnych a historických výrazov
 * v digitalizovaných geologických textoch.
 *
 * Podporuje:
 * - Filtrovanie podľa kategórií / tém (napr. mining_towns, mining_terms, counties)
 * - Rýchle prúdové (streaming) spracovanie veľkých súborov (800+ strán)
 * - Detekciu čísiel strán (## Page: X)
 * - Viacjazyčnosť (SK, DE, HU)
 * - Formátovaný výstup do konzoly, Markdownu alebo JSONu
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DICT_PATH = path.resolve(process.cwd(), 'data', 'slovak-toponyms.json');

function printHelp() {
  console.log(`
Použitie:
  node src/search-toponyms.js [prepínače]
  npm run search-toponyms -- [prepínače]

Prepínače pre filtrovanie cieľa:
  --dir <názov>            Prehľadať konkrétny podadresár v data/ (napr. jahresbericht, geologische-reichsanstalt)
  --file <cesta>           Prehľadať konkrétny textový súbor (aj mimo data/)
  --all                    Prehľadať všetky podadresáre v data/ (predvolené, ak nie je zadané --dir ani --file)

Prepínače pre slovník a témy:
  -c, --category <názvy>   Filtrovať kategórie (oddelené čiarkou, napr. "mining_towns,mining_terms")
  --list-categories        Zobraziť zoznam dostupných kategórií v slovníku a skončiť
  --lang <sk|de|hu|all>    Filtrovať hľadané tvary podľa jazyka (predvolené: all)
  --dict <cesta>           Cesta k vlastnému JSON slovníku (predvolené: data/slovak-toponyms.json)

Prepínače pre zobrazenie a výstup:
  --min-count <n>          Zobraziť len výrazy s minimálne n výskytmi (predvolené: 1)
  --max-snippets <n>       Maximálny počet ukážok kontextu na výraz a súbor (predvolené: 3)
  --context <znaky>        Dĺžka kontextu okolo nájdeného výrazu (predvolené: 80 znakov)
  -o, --output <cesta>     Uložiť výsledný report do súboru (.md alebo .json podľa prípony)
  --markdown, -m           Formátovať výstup ako Markdown do konzoly
  --json                   Formátovať výstup ako JSON do konzoly
  -h, --help               Zobraziť túto nápovedu

Príklady použitia:
  # 1. Zoznam dostupných tém:
  node src/search-toponyms.js --list-categories

  # 2. Hľadanie baníckych miest a výrazov v ročenke Jahresbericht:
  node src/search-toponyms.js --dir jahresbericht -c mining_towns,mining_terms

  # 3. Hľadanie žúp v konkrétnom veľkom súbore (napr. 800-stranový zväzok):
  node src/search-toponyms.js --file data/geologische-reichsanstalt/1867/bsb10226096.txt -c counties

  # 4. Hľadanie iba nemeckých výrazov a uloženie reportu do Markdown súboru:
  node src/search-toponyms.js --dir jahresbericht --lang de -o analyses/toponyms-report.md
`);
}

/**
 * Načíta a validuje tematický slovník toponým.
 * @param {string} dictPath
 * @returns {object}
 */
function loadDictionary(dictPath) {
  if (!fs.existsSync(dictPath)) {
    throw new Error(`Slovník nebol nájdený na ceste: ${dictPath}`);
  }
  const raw = fs.readFileSync(dictPath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/**
 * Pripraví zoznam vyhľadávacích vzorov podľa zadaných kategórií a jazykov.
 * Zostaví optimalizovanú mapu a regulárny výraz.
 */
function compileSearchEngine(dictionary, requestedCategories = [], langFilter = 'all') {
  const allCategories = Object.keys(dictionary.categories);
  const selectedCategories = requestedCategories.length > 0
    ? requestedCategories.filter(c => allCategories.includes(c))
    : allCategories;

  if (selectedCategories.length === 0) {
    throw new Error(`Žiadna zo zadaných kategórií [${requestedCategories.join(', ')}] neexistuje v slovníku.`);
  }

  // Mapa: normalizované hľadané slovo -> pole metadát (term, category, lang)
  const patternMap = new Map();
  const searchPhrases = [];

  for (const catKey of selectedCategories) {
    const cat = dictionary.categories[catKey];
    for (const term of cat.terms) {
      const langs = ['sk', 'de', 'hu'];
      for (const lang of langs) {
        if (langFilter !== 'all' && langFilter !== lang) continue;
        const variants = term[lang] || [];
        for (const variant of variants) {
          const trimmed = variant.trim();
          if (!trimmed || trimmed.length < 2) continue;

          const lower = trimmed.toLowerCase();
          if (!patternMap.has(lower)) {
            patternMap.set(lower, []);
            searchPhrases.push(trimmed);
          }
          patternMap.get(lower).push({
            termId: term.id,
            termNameSk: term.sk ? term.sk[0] : term.id,
            category: catKey,
            categoryName: cat.name_sk,
            lang,
            rawPhrase: trimmed
          });
        }
      }
    }
  }

  // Zoradíme od najdlhších fráz po najkratšie, aby "Banská Štiavnica" mala prednosť pred "Štiavnica"
  searchPhrases.sort((a, b) => b.length - a.length);

  // Escapovanie špeciálnych znakov regexu
  const escapeRegex = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Skupinový regulárny výraz s Unicode word boundary
  // (?<![\p{L}\p{N}])(fráza1|fráza2)(?![\p{L}\p{N}])
  const regexPattern = `(?<![\\p{L}\\p{N}])(?:${searchPhrases.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}])`;
  const masterRegex = new RegExp(regexPattern, 'giu');

  return {
    selectedCategories,
    patternMap,
    masterRegex,
    totalPhrases: searchPhrases.length
  };
}

/**
 * Nájde všetky cieľové textové súbory pre prehľadávanie.
 */
function resolveTargetFiles(options) {
  const files = [];

  if (options.file) {
    const fullPath = path.resolve(process.cwd(), options.file);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Zadaný súbor neexistuje: ${fullPath}`);
    }
    files.push(fullPath);
    return files;
  }

  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    throw new Error(`Adresár data/ neexistuje.`);
  }

  let subDirs = [];
  if (options.dir) {
    const candidate = path.join(dataDir, options.dir);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Zadaný podadresár neexistuje: ${candidate}`);
    }
    subDirs = [options.dir];
  } else {
    // Všetky podadresáre v data/
    subDirs = fs.readdirSync(dataDir).filter(name => {
      const p = path.join(dataDir, name);
      return fs.statSync(p).isDirectory() && name !== 'md';
    });
  }

  // Prehľadáme podadresáre a nájdeme všetky .txt súbory
  for (const dirName of subDirs) {
    const fullDir = path.join(dataDir, dirName);
    collectTxtFilesRecursively(fullDir, files);
  }

  return files;
}

function collectTxtFilesRecursively(dirPath, acc) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'images' && entry.name !== 'thumbnails' && entry.name !== 'node_modules') {
        collectTxtFilesRecursively(full, acc);
      }
    } else if (entry.isFile() && entry.name.endsWith('.txt')) {
      acc.push(full);
    }
  }
}

/**
 * Prehľadá jeden súbor po riadkoch (stream), pričom trackuje strany (## Page: X).
 */
async function searchInFile(filePath, engine, options) {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let currentPage = 'Úvod / pred č. strany';
  let lineNum = 0;
  const matchesByTerm = new Map(); // termId -> { info, hits: [], count: 0 }

  const pageRegex = /##\s*Page:\s*(\d+)/i;
  const altPageRegex = /(?:---\s*Page\s*(\d+)\s*---|\[Page\s*(\d+)\])/i;

  for await (const line of rl) {
    lineNum++;

    // Kontrola prechodu na novú stranu
    const pMatch = line.match(pageRegex) || line.match(altPageRegex);
    if (pMatch) {
      currentPage = pMatch[1] || pMatch[2];
    }

    if (!line.trim()) continue;

    // Reset master regexu pred prehľadaním riadku
    engine.masterRegex.lastIndex = 0;
    let match;

    while ((match = engine.masterRegex.exec(line)) !== null) {
      const matchedText = match[0];
      const lower = matchedText.toLowerCase();
      const metaList = engine.patternMap.get(lower);

      if (!metaList) continue;

      // Extrakcia kontextového snippetu
      const contextLen = options.context || 80;
      const start = Math.max(0, match.index - contextLen);
      const end = Math.min(line.length, match.index + matchedText.length + contextLen);
      const snippetPrefix = start > 0 ? '...' : '';
      const snippetSuffix = end < line.length ? '...' : '';
      const snippet = snippetPrefix + line.substring(start, end).replace(/\s+/g, ' ').trim() + snippetSuffix;

      for (const meta of metaList) {
        if (!matchesByTerm.has(meta.termId)) {
          matchesByTerm.set(meta.termId, {
            termId: meta.termId,
            termNameSk: meta.termNameSk,
            category: meta.category,
            categoryName: meta.categoryName,
            count: 0,
            pages: new Set(),
            hits: []
          });
        }

        const entry = matchesByTerm.get(meta.termId);
        entry.count++;
        entry.pages.add(currentPage);

        if (entry.hits.length < (options.maxSnippets || 3)) {
          entry.hits.push({
            page: currentPage,
            line: lineNum,
            matchedText,
            lang: meta.lang,
            snippet
          });
        }
      }
    }
  }

  // Prevod Set na zoradené pole strán
  for (const entry of matchesByTerm.values()) {
    entry.pages = Array.from(entry.pages);
  }

  return matchesByTerm;
}

/**
 * Vygeneruje Markdown report z nájdených výsledkov.
 */
function generateMarkdownReport(results, dictionary, totalFiles, executionTimeMs) {
  let md = `# Geologický prieskum toponým a montánnych výrazov\n\n`;
  md += `- **Dátum vygenerovania:** ${new Date().toLocaleString('sk-SK')}\n`;
  md += `- **Prehľadaných súborov:** ${totalFiles}\n`;
  md += `- **Čas behu:** ${(executionTimeMs / 1000).toFixed(2)} s\n\n`;
  md += `---\n\n`;

  // Zoskupenie podľa kategórií
  const byCategory = new Map();

  for (const [filePath, termMap] of results.entries()) {
    const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    for (const [termId, data] of termMap.entries()) {
      if (!byCategory.has(data.category)) {
        byCategory.set(data.category, {
          name: data.categoryName,
          terms: new Map()
        });
      }
      const catGroup = byCategory.get(data.category);
      if (!catGroup.terms.has(termId)) {
        catGroup.terms.set(termId, {
          nameSk: data.termNameSk,
          totalCount: 0,
          occurrences: []
        });
      }
      const termGroup = catGroup.terms.get(termId);
      termGroup.totalCount += data.count;
      termGroup.occurrences.push({
        file: relPath,
        count: data.count,
        pages: data.pages,
        hits: data.hits
      });
    }
  }

  if (byCategory.size === 0) {
    md += `*V prehľadaných súboroch neboli nájdené žiadne výskyty pre zadané kritériá.*\n`;
    return md;
  }

  md += `## Súhrn podľa kategórií\n\n`;
  md += `| Kategória | Počet nájdených pojmov | Celkový počet výskytov |\n`;
  md += `| :--- | :---: | :---: |\n`;
  for (const [catKey, catData] of byCategory.entries()) {
    const totalOccurrences = Array.from(catData.terms.values()).reduce((sum, t) => sum + t.totalCount, 0);
    md += `| **${catData.name}** (\`${catKey}\`) | ${catData.terms.size} | ${totalOccurrences} |\n`;
  }
  md += `\n---\n\n`;

  for (const [catKey, catData] of byCategory.entries()) {
    md += `## ${catData.name}\n\n`;

    for (const [termId, termData] of catData.terms.entries()) {
      md += `### ${termData.nameSk} (\`${termId}\`) — ${termData.totalCount} výskytov\n\n`;

      for (const occ of termData.occurrences) {
        md += `* **Súbor:** [\`${occ.file}\`](file:///${path.resolve(process.cwd(), occ.file).replace(/\\/g, '/')})\n`;
        md += `  * Počet výskytov: **${occ.count}**\n`;
        md += `  * Strany: ${occ.pages.join(', ')}\n`;
        if (occ.hits.length > 0) {
          md += `  * Ukážky:\n`;
          for (const hit of occ.hits) {
            md += `    * *(Str. ${hit.page}, výraz: "${hit.matchedText}")*: \`${hit.snippet}\`\n`;
          }
        }
      }
      md += `\n`;
    }
  }

  return md;
}

// ================= Hlavný kód CLI =================
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  // Parsovanie argumentov
  const options = {
    dir: null,
    file: null,
    categories: [],
    lang: 'all',
    minCount: 1,
    maxSnippets: 3,
    context: 80,
    dictPath: DICT_PATH,
    output: null,
    markdown: false,
    json: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dir' && args[i + 1]) options.dir = args[++i];
    else if (arg === '--file' && args[i + 1]) options.file = args[++i];
    else if ((arg === '-c' || arg === '--category') && args[i + 1]) {
      options.categories = args[++i].split(',').map(s => s.trim().toLowerCase());
    } else if (arg === '--lang' && args[i + 1]) options.lang = args[++i].toLowerCase();
    else if (arg === '--min-count' && args[i + 1]) options.minCount = parseInt(args[++i], 10);
    else if (arg === '--max-snippets' && args[i + 1]) options.maxSnippets = parseInt(args[++i], 10);
    else if (arg === '--context' && args[i + 1]) options.context = parseInt(args[++i], 10);
    else if (arg === '--dict' && args[i + 1]) options.dictPath = path.resolve(process.cwd(), args[++i]);
    else if ((arg === '-o' || arg === '--output') && args[i + 1]) options.output = path.resolve(process.cwd(), args[++i]);
    else if (arg === '--markdown' || arg === '-m') options.markdown = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--list-categories') {
      const dict = loadDictionary(options.dictPath);
      console.log(`\nDostupné témy a kategórie v slovníku [${options.dictPath}]:\n`);
      for (const [key, val] of Object.entries(dict.categories)) {
        console.log(`  * ${key.padEnd(36)} -> ${val.name_sk} (${val.terms.length} položiek)`);
        if (val.description_sk) {
          console.log(`    ${val.description_sk}`);
        }
      }
      console.log(`\nPoužitie: node src/search-toponyms.js -c mining_towns,counties\n`);
      process.exit(0);
    }
  }

  const startTime = Date.now();
  const dict = loadDictionary(options.dictPath);
  const engine = compileSearchEngine(dict, options.categories, options.lang);
  const targetFiles = resolveTargetFiles(options);

  if (targetFiles.length === 0) {
    console.error('Nenašli sa žiadne textové súbory na prehľadanie.');
    process.exit(1);
  }

  if (!options.json) {
    console.log(`\n================================================================`);
    console.log(` Geologický vyhľadávač toponým a montánnych výrazov`);
    console.log(`================================================================`);
    console.log(`* Vybrané kategórie: ${engine.selectedCategories.join(', ')}`);
    console.log(`* Hľadaných výrazov/fráz: ${engine.totalPhrases}`);
    console.log(`* Jazykový filter: ${options.lang}`);
    console.log(`* Súborov na prehľadanie: ${targetFiles.length}`);
    console.log(`----------------------------------------------------------------\n`);
  }

  // Prehľadanie súborov
  const resultsByFile = new Map(); // filePath -> termMap
  let totalMatchesCount = 0;

  for (let i = 0; i < targetFiles.length; i++) {
    const f = targetFiles[i];
    const rel = path.relative(process.cwd(), f);
    if (!options.json) {
      process.stdout.write(`[${i + 1}/${targetFiles.length}] Prehľadávam ${rel}... `);
    }

    const termMap = await searchInFile(f, engine, options);

    // Filter min-count
    for (const [tId, tData] of termMap.entries()) {
      if (tData.count < options.minCount) {
        termMap.delete(tId);
      } else {
        totalMatchesCount += tData.count;
      }
    }

    if (termMap.size > 0) {
      resultsByFile.set(f, termMap);
      if (!options.json) {
        console.log(`nájdených ${termMap.size} termínov (${Array.from(termMap.values()).reduce((a, b) => a + b.count, 0)} výskytov)`);
      }
    } else {
      if (!options.json) {
        console.log(`žiadne zhody`);
      }
    }
  }

  const execTime = Date.now() - startTime;

  // JSON formát
  if (options.json) {
    const jsonOutput = {
      meta: {
        timestamp: new Date().toISOString(),
        executionTimeMs: execTime,
        totalFiles: targetFiles.length,
        categories: engine.selectedCategories,
        lang: options.lang
      },
      results: []
    };

    for (const [f, termMap] of resultsByFile.entries()) {
      jsonOutput.results.push({
        file: path.relative(process.cwd(), f).replace(/\\/g, '/'),
        terms: Array.from(termMap.values())
      });
    }

    if (options.output) {
      fs.writeFileSync(options.output, JSON.stringify(jsonOutput, null, 2), 'utf-8');
      console.error(`JSON report bol uložený do: ${options.output}`);
    } else {
      console.log(JSON.stringify(jsonOutput, null, 2));
    }
    return;
  }

  // Markdown výstup
  const mdReport = generateMarkdownReport(resultsByFile, dict, targetFiles.length, execTime);

  if (options.output) {
    fs.writeFileSync(options.output, mdReport, 'utf-8');
    console.log(`\nReport bol úspešne uložený do: ${options.output}`);
  } else if (options.markdown) {
    console.log('\n' + mdReport);
  } else {
    // Štandardný konzolový prehľad
    console.log(`\n================================================================`);
    console.log(` Výsledky vyhľadávania (nájdených ${totalMatchesCount} výskytov za ${(execTime / 1000).toFixed(2)} s)`);
    console.log(`================================================================\n`);

    if (resultsByFile.size === 0) {
      console.log('Žiadne zhody podľa zadaných kritérií.');
    } else {
      for (const [f, termMap] of resultsByFile.entries()) {
        const rel = path.relative(process.cwd(), f);
        console.log(`\nSúbor: ${rel}`);
        console.log(''.padEnd(rel.length + 7, '-'));

        for (const data of termMap.values()) {
          console.log(`  * [${data.categoryName}] ${data.termNameSk} (${data.termId}): ${data.count}x`);
          console.log(`    Strany: ${data.pages.slice(0, 15).join(', ')}${data.pages.length > 15 ? '...' : ''}`);
          if (data.hits.length > 0) {
            for (const h of data.hits) {
              console.log(`      - str. ${h.page}: "${h.snippet}"`);
            }
          }
        }
      }
    }
    console.log(`\nTip: Pre Markdown report použite prepínač --output report.md alebo --markdown.`);
  }
}

main().catch(err => {
  console.error('\nChyba pri vykonávaní skriptu:', err.message);
  process.exit(1);
});
