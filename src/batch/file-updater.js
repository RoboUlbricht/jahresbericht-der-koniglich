import fs from 'node:fs';
import path from 'node:path';

/**
 * Aktualizuje alebo vloží text strany v súbore so značkami "## Page: X"
 * @param {string} filePath Absolútna alebo relatívna cesta k textovému súboru
 * @param {number|string} pageNum Číslo strany
 * @param {string} newText Nový text strany
 * @returns {string} Nový obsah súboru
 */
export function updatePageTextInFile(filePath, pageNum, newText) {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const pNum = parseInt(pageNum, 10);
  const cleanNewText = (newText || '').trim();

  // Vyhľadať všetky hlavičky strán: ## Page: <number>
  const headerRegex = /(?:^|\r?\n)## Page: (\d+)(?:\r?\n|$)/g;
  let matches = [];
  let m;
  while ((m = headerRegex.exec(content)) !== null) {
    const matchStr = m[0];
    const leadingNewlineMatch = matchStr.match(/^(\r?\n)/);
    const headerStart = leadingNewlineMatch ? m.index + leadingNewlineMatch[1].length : m.index;
    matches.push({
      pageNum: parseInt(m[1], 10),
      headerStart,
      headerEnd: m.index + matchStr.length
    });
  }

  const existingIdx = matches.findIndex(item => item.pageNum === pNum);

  if (existingIdx !== -1) {
    const current = matches[existingIdx];
    const next = matches[existingIdx + 1];

    const before = content.slice(0, current.headerEnd);
    const after = next ? content.slice(next.headerStart) : '';

    let formattedBody = '';
    if (next) {
      formattedBody = cleanNewText ? (cleanNewText + '\n\n') : '\n';
    } else {
      formattedBody = cleanNewText ? (cleanNewText + '\n') : '\n';
    }

    content = before + formattedBody + after;
  } else {
    let foundNext = false;
    let nextHeaderStart = -1;

    for (let i = 0; i < matches.length; i++) {
      if (matches[i].pageNum > pNum) {
        nextHeaderStart = matches[i].headerStart;
        foundNext = true;
        break;
      }
    }

    if (foundNext) {
      const before = content.slice(0, nextHeaderStart).trimEnd();
      const after = content.slice(nextHeaderStart);
      const prefix = before.length > 0 ? before + '\n\n' : '';
      const body = cleanNewText ? (cleanNewText + '\n\n') : '\n';
      content = prefix + `## Page: ${pNum}\n` + body + after;
    } else {
      const before = content.trimEnd();
      const prefix = before.length > 0 ? before + '\n\n' : '';
      const body = cleanNewText ? (cleanNewText + '\n') : '\n';
      content = prefix + `## Page: ${pNum}\n` + body;
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return content;
}
