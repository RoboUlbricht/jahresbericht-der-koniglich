import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitIntoPages } from '../normalize-de-text.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

const OCR_INSTRUCTION_FILE = path.join(PROJECT_ROOT, 'src', 'ai-instructions', 'de-repair-ocr.md');
const TRANSLATE_INSTRUCTION_FILE = path.join(PROJECT_ROOT, 'src', 'ai-instructions', 'de-sk-translator.md');

/**
 * Načíta systémové inštrukcie pre OCR opravu
 * @returns {string}
 */
export function getOcrRepairInstruction() {
  if (!fs.existsSync(OCR_INSTRUCTION_FILE)) {
    throw new Error(`Súbor so systémovými inštrukciami neexistuje: ${OCR_INSTRUCTION_FILE}`);
  }
  return fs.readFileSync(OCR_INSTRUCTION_FILE, 'utf-8').trim();
}

/**
 * Načíta systémové inštrukcie pre preklad DE -> SK
 * @returns {string}
 */
export function getTranslateInstruction() {
  if (!fs.existsSync(TRANSLATE_INSTRUCTION_FILE)) {
    throw new Error(`Súbor so systémovými inštrukciami neexistuje: ${TRANSLATE_INSTRUCTION_FILE}`);
  }
  return fs.readFileSync(TRANSLATE_INSTRUCTION_FILE, 'utf-8').trim();
}

/**
 * Nájde priečinok ročníka a cesty k súborom dokumentu
 * @param {string} magazine
 * @param {string|number|Object} identifier year, pdfId alebo objekt { year, pdfId }
 * @param {string|number} [maybeYear]
 * @returns {{
 *   dir: string,
 *   pdfId: string,
 *   folderName: string,
 *   baseFile: string,
 *   normFile: string,
 *   skFile: string,
 *   baseFileName: string,
 *   normFileName: string,
 *   skFileName: string
 * }}
 */
export function resolveDocumentPaths(magazine, identifier, maybeYear = null) {
  let year = maybeYear;
  let pdfId = null;

  if (typeof identifier === 'object' && identifier !== null) {
    year = identifier.year || maybeYear;
    pdfId = identifier.pdfId;
  } else if (identifier !== undefined && identifier !== null) {
    if (!year && /^\d{4}$/.test(String(identifier))) {
      year = identifier;
    } else {
      pdfId = String(identifier);
    }
  }

  const magDir = path.join(DATA_DIR, magazine);
  if (!fs.existsSync(magDir)) {
    throw new Error(`Priečinok časopisu neexistuje: ${magDir}`);
  }

  let foundDir = null;
  let folderName = null;

  // 1. Skúsiť priamy podadresár podľa year (napr. data/jahresbericht/1890)
  if (year) {
    const yDir = path.join(magDir, String(year));
    if (fs.existsSync(yDir) && fs.statSync(yDir).isDirectory()) {
      foundDir = yDir;
      folderName = String(year);
    }
  }

  // 2. Skúsiť priamy podadresár podľa pdfId (napr. data/reise/1808)
  if (!foundDir && pdfId) {
    const pDir = path.join(magDir, String(pdfId));
    if (fs.existsSync(pDir) && fs.statSync(pDir).isDirectory()) {
      foundDir = pDir;
      folderName = String(pdfId);
    }
  }

  // 3. Vyhľadať v data/index.json
  const indexPath = path.join(DATA_DIR, 'index.json');
  if (!foundDir && fs.existsSync(indexPath)) {
    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const magInfo = indexData?.magazines?.find(m => m.directory === magazine);
      if (magInfo?.published) {
        const pub = magInfo.published.find(p => 
          (pdfId && p.id === pdfId) ||
          (year && String(p.year) === String(year)) ||
          (pdfId && String(p.year) === String(pdfId))
        );
        if (pub) {
          const pubDir = path.join(magDir, String(pub.year));
          if (fs.existsSync(pubDir) && fs.statSync(pubDir).isDirectory()) {
            foundDir = pubDir;
            folderName = String(pub.year);
          }
        }
      }
    } catch {}
  }

  // 4. Prehľadať všetky podadresáre v magDir
  if (!foundDir) {
    try {
      const entries = fs.readdirSync(magDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(magDir, entry.name);
          const files = fs.readdirSync(subDir);
          const hasMatch = files.some(f => 
            (pdfId && f.includes(pdfId)) || 
            (year && f.includes(String(year)))
          );
          if (hasMatch) {
            foundDir = subDir;
            folderName = entry.name;
            break;
          }
        }
      }
    } catch {}
  }

  if (!foundDir) {
    const identInfo = `year: "${year || '-'}", pdfId: "${pdfId || '-'}"`;
    throw new Error(`Ročník alebo dokument (${identInfo}) sa nenašiel v časopise "${magazine}".`);
  }

  // 5. Nájdenie konkrétnych textových súborov v cieľovom priečinku
  const files = fs.readdirSync(foundDir);
  let baseFileName = files.find(f => f.endsWith('.txt') && !f.startsWith('normalized-') && !f.startsWith('sk-'));
  const pdfFile = files.find(f => f.endsWith('.pdf'));

  if (!baseFileName && pdfFile) {
    baseFileName = pdfFile.replace(/\.pdf$/, '.txt');
  }
  if (!baseFileName) {
    baseFileName = `${pdfId || year || folderName}.txt`;
  }

  const normFileName = `normalized-${baseFileName}`;
  const skFileName = `sk-${baseFileName}`;
  const effectivePdfId = pdfFile ? pdfFile.replace(/\.pdf$/, '') : baseFileName.replace(/\.txt$/, '');

  return {
    dir: foundDir,
    pdfId: effectivePdfId,
    folderName,
    baseFile: path.join(foundDir, baseFileName),
    normFile: path.join(foundDir, normFileName),
    skFile: path.join(foundDir, skFileName),
    baseFileName,
    normFileName,
    skFileName
  };
}

/**
 * Vráti text súboru ako Map<pageNum, text>
 * @param {string} filePath
 * @returns {Map<number, string>}
 */
function loadPagesMap(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return splitIntoPages(content);
}

/**
 * Vytiahne posledných N neprázdnych riadkov zo strany pre predchádzajúci kontext
 * @param {string} pageText
 * @param {number} lineCount
 * @returns {string}
 */
function getLastLines(pageText, lineCount = 4) {
  if (!pageText) return '';
  const lines = pageText.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
  return lines.slice(-lineCount).join('\n');
}

/**
 * Vytiahne prvých N neprázdnych riadkov zo strany pre nasledujúci kontext
 * @param {string} pageText
 * @param {number} lineCount
 * @returns {string}
 */
function getFirstLines(pageText, lineCount = 4) {
  if (!pageText) return '';
  const lines = pageText.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
  return lines.slice(0, lineCount).join('\n');
}

/**
 * Zostaví prompt a systémové inštrukcie pre 1 stranu s okolitým kontextom
 * @param {Object} params
 * @param {string} params.magazine
 * @param {string|number} params.year
 * @param {string} [params.pdfId]
 * @param {number} params.page
 * @param {'normalize'|'translate'} params.type
 * @returns {{
 *   systemInstruction: string,
 *   userPrompt: string,
 *   temperature: number,
 *   targetFile: string,
 *   sourceFile: string,
 *   pdfId: string,
 *   page: number,
 *   type: string
 * }}
 */
export function buildPagePrompt({ magazine, year, pdfId = null, page, type }) {
  const pNum = parseInt(page, 10);
  if (isNaN(pNum) || pNum < 1) {
    throw new Error(`Neplatné číslo strany: ${page}`);
  }

  const doc = resolveDocumentPaths(magazine, { year, pdfId });
  const activePdfId = doc.pdfId;

  // Cesty k súborom
  const baseFile = doc.baseFile;
  const normFile = doc.normFile;
  const skFile = doc.skFile;

  // Určenie zdrojového textu a cieľového súboru
  let sourcePagesMap;
  let sourceFilePath;
  let targetFilePath;
  let systemInstruction;

  if (type === 'normalize') {
    if (!fs.existsSync(baseFile)) {
      throw new Error(`Zdrojový súbor s textom neexistuje: ${baseFile}`);
    }
    sourcePagesMap = loadPagesMap(baseFile);
    sourceFilePath = path.relative(PROJECT_ROOT, baseFile);
    targetFilePath = path.relative(PROJECT_ROOT, normFile);
    systemInstruction = getOcrRepairInstruction();
  } else if (type === 'translate') {
    // Pri preklade uprednostňujeme normalizovaný text, ak existuje, inak pôvodný
    if (fs.existsSync(normFile)) {
      sourcePagesMap = loadPagesMap(normFile);
      sourceFilePath = path.relative(PROJECT_ROOT, normFile);
    } else if (fs.existsSync(baseFile)) {
      sourcePagesMap = loadPagesMap(baseFile);
      sourceFilePath = path.relative(PROJECT_ROOT, baseFile);
    } else {
      throw new Error(`Zdrojový súbor pre preklad neexistuje v ${doc.dir}`);
    }
    targetFilePath = path.relative(PROJECT_ROOT, skFile);
    systemInstruction = getTranslateInstruction();
  } else {
    throw new Error(`Neznámy typ úlohy: "${type}". Podporované sú "normalize" a "translate".`);
  }

  const targetPageText = sourcePagesMap.get(pNum) || '';
  const prevPageText = sourcePagesMap.get(pNum - 1) || '';
  const nextPageText = sourcePagesMap.get(pNum + 1) || '';

  const prevContext = getLastLines(prevPageText, 4);
  const nextContext = getFirstLines(nextPageText, 4);

  let userPrompt = '';

  if (type === 'normalize') {
    userPrompt = `Oprav nasledujúci historický nemecký text strany ${pNum} podľa systémových inštrukcií.
Dôsledne zachovaj značku "## Page: ${pNum}", kurzívu *...*, poznámky pod čiarou > *) a prípadné metaznačky [Tab:] / [Img:].

`;
    if (prevContext) {
      userPrompt += `[PREDCHÁDZAJÚCI KONTEXT (Koniec strany ${pNum - 1} - nespracovávaj, slúži len na rozpoznanie rozdeleného slova na začiatku strany ${pNum})]:\n${prevContext}\n\n`;
    }

    userPrompt += `[OBSAH STRANY ${pNum} NA OPRAVU]:\n## Page: ${pNum}\n${targetPageText || '(Prázdna strana)'}\n\n`;

    if (nextContext) {
      userPrompt += `[NASLEDUJÚCI KONTEXT (Začiatok strany ${pNum + 1} - nespracovávaj, slúži len na rozpoznanie rozdeleného slova na konci strany ${pNum})]:\n${nextContext}\n\n`;
    }

    userPrompt += `[INŠTRUKCIA PRE SPRACOVANIE]:
- Vráť VÝHRADNE opravený obsah strany ${pNum} vrátane hlavičky "## Page: ${pNum}".
- Ak sa na začiatku strany ${pNum} nachádza druhá polovica slova rozdeleného na strane ${pNum - 1}, doplň ho do správneho tvaru podľa predchádzajúceho kontextu.
- Ak sa na konci strany ${pNum} nachádza rozdelené slovo so spojovníkom (de-hyphenation), podľa nasledujúceho kontextu ho spoj do celého slova, ak patrí k strane ${pNum}.
- Nikdy do výstupu nepridávaj text z predchádzajúcej ani nasledujúcej strany.
- Vráť čistý text bez formátovania do kódového bloku (\`\`\`markdown).`;
  } else {
    // Translate
    userPrompt = `Prelož nasledujúci historický text strany ${pNum} z nemčiny do slovenčiny podľa systémových inštrukcií.
Dôsledne zachovaj značku "## Page: ${pNum}", kurzívu *...*, poznámky pod čiarou > *) a prípadné metaznačky [Tab:] / [Img:].

`;
    if (prevContext) {
      userPrompt += `[PREDCHÁDZAJÚCI KONTEXT (Koniec strany ${pNum - 1} v nemčine - nespracovávaj, slúži len ako kontext vety)]:\n${prevContext}\n\n`;
    }

    userPrompt += `[OBSAH STRANY ${pNum} NA PREKLAD]:\n## Page: ${pNum}\n${targetPageText || '(Prázdna strana)'}\n\n`;

    if (nextContext) {
      userPrompt += `[NASLEDUJÚCI KONTEXT (Začiatok strany ${pNum + 1} v nemčine - nespracovávaj, slúži len ako kontext vety)]:\n${nextContext}\n\n`;
    }

    userPrompt += `[INŠTRUKCIA PRE PREKLAD]:
- Vráť VÝHRADNE slovenský preklad obsahu strany ${pNum} vrátane hlavičky "## Page: ${pNum}".
- Použi predchádzajúci a nasledujúci kontext na zabezpečenie správnej nadväznosti vety a významu.
- Nikdy do výstupu nepridávaj preklad predchádzajúcej ani nasledujúcej strany.
- Vráť čistý slovenský text bez formátovania do kódového bloku (\`\`\`markdown) a bez sprievodných komentárov.`;
  }

  return {
    systemInstruction,
    userPrompt,
    temperature: 0.1,
    targetFile: targetFilePath.replace(/\\/g, '/'),
    sourceFile: sourceFilePath.replace(/\\/g, '/'),
    page: pNum,
    type
  };
}
