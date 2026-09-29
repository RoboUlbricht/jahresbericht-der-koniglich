#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Zoznam častíc, ktoré ostávajú malými písmenami (ak nie sú na začiatku mena)
const LOWERCASE_PARTICLES = new Set([
  'v.', 'von', 'de', 'del', 'della', 'di', 'du', 'van', 'der', 'den', 'ter', 'und', 'et', 'and'
]);

// Špeciálne tituly s ustálenou veľkosťou písmen
const SPECIAL_TITLES = {
  'dr': 'Dr.',
  'dr.': 'Dr.',
  'prof': 'Prof.',
  'prof.': 'Prof.',
  'ing': 'Ing.',
  'ing.': 'Ing.',
  'doc': 'Doc.',
  'doc.': 'Doc.',
  'mag': 'Mag.',
  'mag.': 'Mag.'
};

// Náhrada cyrilických znakov z OCR za latinku v menách autorov
const CYRILLIC_TO_LATIN = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'н': 'h'
};

function replaceCyrillicLookalikes(str) {
  return str.replace(/[\u0400-\u04FF]/g, ch => CYRILLIC_TO_LATIN[ch] || ch);
}

/**
 * Normalizuje meno autora z ALL-CAPS / historických tvarov na štandardný tvar s veľkým začiatočným písmenom.
 * @param {string} name 
 * @returns {string}
 */
export function normalizeAuthorName(name) {
  if (!name || typeof name !== 'string') return '';

  let cleanName = name.trim().replace(/\s+/g, ' ');
  if (!cleanName) return '';

  // Nahradenie OCR cyrilických zámen
  cleanName = replaceCyrillicLookalikes(cleanName);

  const words = cleanName.split(' ');

  const normalizedWords = words.map((word, index) => {
    const lowerWord = word.toLowerCase();

    // 1. Špeciálne akademické a profesijné tituly
    if (SPECIAL_TITLES[lowerWord]) {
      return SPECIAL_TITLES[lowerWord];
    }

    // 2. Šľachtické a spojovacie častice (okrem prvého slova)
    if (index > 0 && LOWERCASE_PARTICLES.has(lowerWord)) {
      return lowerWord;
    }

    // 3. Zložené mená so spojovníkom (napr. Szabó-Kovács)
    if (word.includes('-')) {
      return word.split('-').map(part => {
        if (!part) return '';
        const lowerPart = part.toLowerCase();
        if (LOWERCASE_PARTICLES.has(lowerPart)) return lowerPart;
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }).join('-');
    }

    // 4. Iniciály s bodkou (napr. A., J., Dr., v.)
    if (word.endsWith('.') && word.length <= 4) {
      if (index > 0 && LOWERCASE_PARTICLES.has(lowerWord)) {
        return lowerWord;
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }

    // 5. Štandardné slovo: Prvé veľké, ostatné malé
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  return normalizedWords.join(' ');
}

// Spustenie ako CLI skript
async function runCli() {
  const targetPath = process.argv[2] || 'data/jahresbericht/articles.json';
  const fullPath = path.resolve(process.cwd(), targetPath);

  if (!fs.existsSync(fullPath)) {
    console.error(`Chyba: Súbor neexistuje: ${targetPath}`);
    process.exit(1);
  }

  console.log(`Normalizujem mená autorov v súbore: ${targetPath}`);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const data = JSON.parse(content);

  let updatedCount = 0;

  if (Array.isArray(data.volumes)) {
    for (const volume of data.volumes) {
      if (Array.isArray(volume.articles)) {
        for (const article of volume.articles) {
          if (article.author) {
            const original = article.author;
            const normalized = normalizeAuthorName(original);
            if (original !== normalized) {
              console.log(`  [Ročník ${volume.year}] "${original}" -> "${normalized}"`);
              article.author = normalized;
              updatedCount++;
            }
          }
        }
      }
    }
  }

  if (updatedCount > 0) {
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    console.log(`\nÚspešne znormalizovaných ${updatedCount} mien autorov.`);
  } else {
    console.log('\nVšetky mená autorov sú už znormalizované.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch(err => {
    console.error('Chyba:', err);
    process.exit(1);
  });
}
