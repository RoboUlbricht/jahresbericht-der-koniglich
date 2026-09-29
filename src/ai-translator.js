import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTRUCTION_FILE = path.join(__dirname, 'ai-instructions', 'de-4title-translator.md');

// Čistenie OCR cyrilických zámen za latinku
const CYRILLIC_TO_LATIN = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'І': 'I', 'і': 'i', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'н': 'h'
};

/**
 * Základné deterministické vyčistenie textu nadpisu (de-hyphenation, OCR zámeny, medzery).
 * @param {string} text 
 * @returns {string}
 */
export function cleanTitleText(text) {
  if (!text || typeof text !== 'string') return '';

  let res = text.trim();

  // 1. Nahradenie cyrilických znakov z OCR
  res = res.replace(/[\u0400-\u04FF]/g, ch => CYRILLIC_TO_LATIN[ch] || ch);

  // 2. Normalizácia spojovníkov a medzier okolo spojovníkov
  // Spojky, po ktorých spojovník ostáva (napr. "Bükk- und Rézgebirge", "Banat- és Krassó")
  const conjunctions = new Set(['und', 'oder', 'sowie', 'és', 'vagy', 'and', 'or']);

  // Spojenie slov rozdelených na konci riadku: "AUS- GEFÜHRTE" -> "AUSGEFÜHRTE", "SPECIAL- AUFNAHME" -> "SPECIALAUFNAHME"
  res = res.replace(/(\b[\p{L}\d]+)-\s+([\p{L}\d]+)\b/gu, (match, p1, p2) => {
    if (conjunctions.has(p2.toLowerCase())) {
      return `${p1}- ${p2}`;
    }
    return `${p1}${p2}`;
  });

  // Odstránenie medzier pred/za spojovníkom, ak ide o chybu OCR (napr. "Ó - SZÖNY" -> "Ó-SZÖNY", "KRASSÓ - SZÖRÉNY" -> "KRASSÓ-SZÖRÉNY")
  res = res.replace(/(\b[\p{L}\d]+)\s+-\s+([\p{L}\d]+)\b/gu, (match, p1, p2) => {
    if (conjunctions.has(p2.toLowerCase())) {
      return `${p1} - ${p2}`;
    }
    return `${p1}-${p2}`;
  });

  // 3. Normalizácia medzier a zalomení riadkov
  res = res.replace(/\s+/g, ' ').trim();

  return res;
}

/**
 * Načítanie konfigurácie z .env
 */
export function getGeminiConfig() {
  const envPath = path.resolve(process.cwd(), '.env');
  let apiKey = process.env.GEMINI_API_KEY || '';
  let model = process.env.MODEL || 'gemini-3.8-flash';

  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq !== -1) {
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim();
        if (k === 'GEMINI_API_KEY' && !apiKey) apiKey = v;
        if (k === 'MODEL' && !process.env.MODEL) model = v;
      }
    }
  }

  return { apiKey, model };
}

/**
 * Načíta systémové inštrukcie pre prekladateľský AI model z externého markdown súboru
 * @returns {string}
 */
export function getSystemInstruction() {
  if (!fs.existsSync(INSTRUCTION_FILE)) {
    throw new Error(`Súbor so systémovými inštrukciami neexistuje: ${INSTRUCTION_FILE}`);
  }
  return fs.readFileSync(INSTRUCTION_FILE, 'utf-8').trim();
}


/**
 * Normalizuje a preloží názov článku cez Gemini AI
 * @param {Object} params
 * @param {string} params.title Surový alebo čiastočne upravený názov
 * @param {string} [params.author] Autor článku
 * @param {number} [params.year] Ročník / rok vydania
 * @param {string} [params.language] Pôvodný jazyk (de/hu)
 * @returns {Promise<Object>} { cleaned_input, title_de, title_hu, title_sk, title_en }
 */
export async function normalizeAndTranslateTitle({ title, author = '', year = '', language = 'de' }) {
  if (!title || typeof title !== 'string') {
    throw new Error('Nebol zadaný názov článku na normalizáciu a preklad.');
  }

  // 1. Lokálne deterministické čistenie
  const cleanedTitle = cleanTitleText(title);

  // 2. Načítanie Gemini konfigurácie
  const { apiKey, model } = getGeminiConfig();
  if (!apiKey) {
    throw new Error('V .env súbore chýba GEMINI_API_KEY. Nastavte svoj API kľúč.');
  }

  const userPrompt = `Znormalizuj a prelož tento historický názov odborného článku:
Názov (originál): "${cleanedTitle}"
${author ? `Autor: ${author}` : ''}
${year ? `Ročník/Rok: ${year}` : ''}
Pôvodný jazyk: ${language === 'hu' ? 'maďarský' : 'nemecký'}

Vráť JSON so 4 jazykovými verziami (title_de, title_hu, title_sk, title_en).`;

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
            parts: [{ text: getSystemInstruction() }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }]
            }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
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
        throw new Error('Prázdna odpoveď od Gemini API.');
      }

      const parsed = JSON.parse(rawText);
      return {
        cleaned_input: cleanedTitle,
        title_de: parsed.title_de || cleanedTitle,
        title_hu: parsed.title_hu || null,
        title_sk: parsed.title_sk || null,
        title_en: parsed.title_en || null
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Nepodarilo sa vygenerovať preklad cez Gemini API.');
}
