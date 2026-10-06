import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanTitleText, normalizeAndTranslateTitle } from '../src/ai-translator.js';
import {
  getBatchState,
  addBatchTask,
  addBatchTaskRange,
  removeBatchTask,
  clearCompletedBatchTasks
} from '../src/batch/batch-manager.js';
import {
  submitBatch,
  checkBatchStatus,
  collectBatchResults
} from '../src/batch/gemini-batch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// Route pre katalogizáciu článkov
app.get('/create-index', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create-index.html'));
});
app.get('/create-index/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create-index.html'));
});

// Route pre prehliadač textov a skenov
app.get('/show-text', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'show-text.html'));
});
app.get('/show-text/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'show-text.html'));
});

// Simple in-memory cache for text files
const textFileCache = new Map();

function getTextFileContent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stats = fs.statSync(filePath);
  const cached = textFileCache.get(filePath);
  if (cached && cached.mtime === stats.mtimeMs) {
    return cached.content;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  textFileCache.set(filePath, { mtime: stats.mtimeMs, content });
  return content;
}

function extractPageText(content, pageNum) {
  if (!content) return '';
  const headerRegex = new RegExp(`(?:^|\\n)## Page: ${pageNum}(?:\\r?\\n|$)`);
  const match = headerRegex.exec(content);
  if (!match) return '';

  const textStart = match.index + match[0].length;
  const nextHeaderRegex = /\r?\n## Page: \d+/g;
  nextHeaderRegex.lastIndex = textStart;
  const nextMatch = nextHeaderRegex.exec(content);
  const textEnd = nextMatch ? nextMatch.index : content.length;
  return content.slice(textStart, textEnd).trim();
}

function updatePageTextInFile(filePath, pageNum, newText) {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const pNum = parseInt(pageNum, 10);
  const cleanNewText = (newText || '').trim();

  // Find all page headers: ## Page: <number>
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

    // Každá strana má na konci pred ďalšou stranou prázdny riadok (\n\n)
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
  textFileCache.delete(filePath);
  return content;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(content);
}

// 1. GET /api/magazines - List magazines and their available volumes
app.get('/api/magazines', (req, res) => {
  try {
    const indexPath = path.join(DATA_DIR, 'index.json');
    let magazines = [];

    if (fs.existsSync(indexPath)) {
      const indexData = readJsonFile(indexPath);
      magazines = indexData?.magazines || [];
    }

    // Enrich magazines with availability of articles.json, thumbnails, txt
    const enriched = magazines.map((mag) => {
      const magDir = path.join(DATA_DIR, mag.directory);
      const articlesPath = path.join(magDir, 'articles.json');
      let articlesData = null;

      if (fs.existsSync(articlesPath)) {
        try {
          articlesData = readJsonFile(articlesPath);
        } catch {
          // ignore parsing error
        }
      }

      const published = (mag.published || []).map((pub) => {
        const yearDir = path.join(magDir, String(pub.year));
        const thumbnailsDir = path.join(yearDir, 'thumbnails');
        const hasThumbnails = fs.existsSync(thumbnailsDir);
        let thumbnailCount = 0;
        if (hasThumbnails) {
          try {
            thumbnailCount = fs.readdirSync(thumbnailsDir).filter((f) => f.endsWith('.png')).length;
          } catch {
            thumbnailCount = 0;
          }
        }

        const txtPath = path.join(yearDir, `${pub.id}.txt`);
        const hasText = fs.existsSync(txtPath);

        const volumeArticles =
          articlesData?.volumes?.find((v) => Number(v.year) === Number(pub.year))?.articles || [];

        return {
          ...pub,
          hasThumbnails,
          thumbnailCount,
          hasText,
          articlesCount: volumeArticles.length,
        };
      });

      return {
        ...mag,
        hasArticlesFile: fs.existsSync(articlesPath),
        published,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('Error fetching magazines:', err);
    res.status(500).json({ error: 'Failed to fetch magazines', details: err.message });
  }
});

// Helper to sort articles by page ascending (and secondary by pdf_page)
function sortArticlesByPage(articles) {
  if (!Array.isArray(articles)) return [];
  return articles.sort((a, b) => {
    const pageA = (typeof a.page === 'number') ? a.page : (parseInt(a.page, 10) || 0);
    const pageB = (typeof b.page === 'number') ? b.page : (parseInt(b.page, 10) || 0);
    if (pageA !== pageB) {
      return pageA - pageB;
    }
    const pdfPageA = (typeof a.pdf_page === 'number') ? a.pdf_page : (parseInt(a.pdf_page, 10) || 0);
    const pdfPageB = (typeof b.pdf_page === 'number') ? b.pdf_page : (parseInt(b.pdf_page, 10) || 0);
    return pdfPageA - pdfPageB;
  });
}

// 2. GET /api/magazines/:magazine/articles - Get articles.json for a magazine
app.get('/api/magazines/:magazine/articles', (req, res) => {
  try {
    const { magazine } = req.params;
    const articlesPath = path.join(DATA_DIR, magazine, 'articles.json');

    if (!fs.existsSync(articlesPath)) {
      return res.json({ title: magazine, volumes: [] });
    }

    const data = readJsonFile(articlesPath);
    if (data && Array.isArray(data.volumes)) {
      data.volumes.forEach(vol => {
        if (Array.isArray(vol.articles)) {
          sortArticlesByPage(vol.articles);
        }
      });
    }
    res.json(data || { title: magazine, volumes: [] });
  } catch (err) {
    console.error('Error reading articles:', err);
    res.status(500).json({ error: 'Failed to read articles', details: err.message });
  }
});

// 3. PUT /api/magazines/:magazine/articles - Save updated articles.json
app.put('/api/magazines/:magazine/articles', (req, res) => {
  try {
    const { magazine } = req.params;
    const magDir = path.join(DATA_DIR, magazine);
    const articlesPath = path.join(magDir, 'articles.json');

    if (!fs.existsSync(magDir)) {
      return res.status(404).json({ error: `Magazine directory not found: ${magazine}` });
    }

    const articlesData = req.body;
    if (!articlesData || typeof articlesData !== 'object') {
      return res.status(400).json({ error: 'Invalid articles data format' });
    }

    // Always ensure articles in all volumes are sorted by page before saving
    if (Array.isArray(articlesData.volumes)) {
      articlesData.volumes.forEach(vol => {
        if (Array.isArray(vol.articles)) {
          sortArticlesByPage(vol.articles);
        }
      });
    }

    // Save with 2 spaces formatting and trailing newline
    const formatted = JSON.stringify(articlesData, null, 2) + '\n';
    fs.writeFileSync(articlesPath, formatted, 'utf-8');

    res.json({ success: true, message: 'Articles saved successfully' });
  } catch (err) {
    console.error('Error saving articles:', err);
    res.status(500).json({ error: 'Failed to save articles', details: err.message });
  }
});

// 3a. POST /api/ai/clean-title - Algorithmic de-hyphenation and OCR cleaning
app.post('/api/ai/clean-title', (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid title parameter' });
    }
    const cleaned = cleanTitleText(title);
    res.json({ success: true, cleaned });
  } catch (err) {
    console.error('Error cleaning title:', err);
    res.status(500).json({ error: 'Failed to clean title', details: err.message });
  }
});

// 3b. POST /api/ai/translate-title - Full Gemini AI normalization and translation
app.post('/api/ai/translate-title', async (req, res) => {
  try {
    const { title, author, year, language } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid title parameter' });
    }
    const result = await normalizeAndTranslateTitle({ title, author, year, language });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error in AI translation:', err);
    res.status(500).json({ error: 'Failed to translate title with Gemini AI', details: err.message });
  }
});

function findPdfLocation(magazine, pdfIdOrYear) {
  const magDir = path.join(DATA_DIR, magazine);
  if (!fs.existsSync(magDir)) return null;

  // 1. Direct folder check (e.g. '1883')
  const directDir = path.join(magDir, String(pdfIdOrYear));
  if (fs.existsSync(directDir) && fs.statSync(directDir).isDirectory()) {
    const files = fs.readdirSync(directDir);
    const pdfFile = files.find((f) => f.endsWith('.pdf'));
    const pdfId = pdfFile ? path.parse(pdfFile).name : pdfIdOrYear;
    return { dir: directDir, pdfId, folderName: String(pdfIdOrYear) };
  }

  // 2. Look up in index.json published list
  const indexPath = path.join(DATA_DIR, 'index.json');
  const indexData = readJsonFile(indexPath);
  const magInfo = indexData?.magazines?.find((m) => m.directory === magazine);
  if (magInfo?.published) {
    const pub = magInfo.published.find(
      (p) => p.id === pdfIdOrYear || String(p.year) === String(pdfIdOrYear)
    );
    if (pub) {
      const pubDir = path.join(magDir, String(pub.year));
      if (fs.existsSync(pubDir)) {
        return { dir: pubDir, pdfId: pub.id, folderName: String(pub.year) };
      }
    }
  }

  // 3. Scan subdirectories of magDir to find ${pdfId}.pdf or ${pdfId}.txt
  try {
    const entries = fs.readdirSync(magDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(magDir, entry.name);
        if (
          fs.existsSync(path.join(subDir, `${pdfIdOrYear}.pdf`)) ||
          fs.existsSync(path.join(subDir, `${pdfIdOrYear}.txt`))
        ) {
          return { dir: subDir, pdfId: pdfIdOrYear, folderName: entry.name };
        }
      }
    }
  } catch {
    // ignore read error
  }

  return null;
}

// 4. GET /api/magazines/:magazine/:pdfIdOrYear/thumbnails - Get thumbnail page numbers list
app.get('/api/magazines/:magazine/:pdfIdOrYear/thumbnails', (req, res) => {
  try {
    const { magazine, pdfIdOrYear } = req.params;
    const loc = findPdfLocation(magazine, pdfIdOrYear);

    if (!loc) {
      return res.json({ count: 0, pages: [], pdfId: pdfIdOrYear });
    }

    const thumbnailsDir = path.join(loc.dir, 'thumbnails');
    if (!fs.existsSync(thumbnailsDir)) {
      return res.json({ count: 0, pages: [], pdfId: loc.pdfId, folderName: loc.folderName });
    }

    const files = fs.readdirSync(thumbnailsDir);
    const pages = files
      .map((file) => {
        const match = file.match(/^(\d+)\.png$/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter((num) => num !== null)
      .sort((a, b) => a - b);

    res.json({
      count: pages.length,
      pages,
      pdfId: loc.pdfId,
      folderName: loc.folderName,
    });
  } catch (err) {
    console.error('Error reading thumbnails list:', err);
    res.status(500).json({ error: 'Failed to list thumbnails', details: err.message });
  }
});

// 5. GET /api/magazines/:magazine/:pdfIdOrYear/thumbnails/:page.png - Serve thumbnail PNG
app.get('/api/magazines/:magazine/:pdfIdOrYear/thumbnails/:page.png', (req, res) => {
  try {
    const { magazine, pdfIdOrYear, page } = req.params;
    const loc = findPdfLocation(magazine, pdfIdOrYear);

    if (!loc) {
      return res.status(404).json({ error: 'PDF location not found' });
    }

    const pngPath = path.join(loc.dir, 'thumbnails', `${page}.png`);
    if (!fs.existsSync(pngPath)) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }

    res.sendFile(pngPath);
  } catch (err) {
    console.error('Error serving thumbnail:', err);
    res.status(500).json({ error: 'Failed to serve thumbnail', details: err.message });
  }
});

// 5b. GET /api/magazines/:magazine/:pdfIdOrYear/images/:page.jpg - Serve high-res page image (with fallback to thumbnail)
app.get('/api/magazines/:magazine/:pdfIdOrYear/images/:page.jpg', (req, res) => {
  try {
    const { magazine, pdfIdOrYear, page } = req.params;
    const loc = findPdfLocation(magazine, pdfIdOrYear);

    if (!loc) {
      return res.status(404).json({ error: 'PDF location not found' });
    }

    // 1. Primárne hľadáme high-res JPG v priečinku images/
    const jpgPath = path.join(loc.dir, 'images', `${page}.jpg`);
    if (fs.existsSync(jpgPath)) {
      return res.sendFile(jpgPath);
    }

    // 2. Fallback na PNG miniatúru v priečinku thumbnails/
    const pngPath = path.join(loc.dir, 'thumbnails', `${page}.png`);
    if (fs.existsSync(pngPath)) {
      return res.sendFile(pngPath);
    }

    res.status(404).json({ error: 'Page image not found' });
  } catch (err) {
    console.error('Error serving page image:', err);
    res.status(500).json({ error: 'Failed to serve page image', details: err.message });
  }
});

// Helper pre zistenie textových súborov daného ročníka (pôvodný, normalizovaný, slovenský preklad)
function getVolumeTxtFiles(dir, defaultPdfId) {
  if (!fs.existsSync(dir)) {
    return {
      base: `${defaultPdfId}.txt`,
      norm: `normalized-${defaultPdfId}.txt`,
      sk: `sk-${defaultPdfId}.txt`,
      hasBase: false,
      hasNorm: false,
      hasSk: false
    };
  }

  const files = fs.readdirSync(dir);
  let base = files.find(f => f.endsWith('.txt') && !f.startsWith('normalized-') && !f.startsWith('sk-'));
  if (!base) {
    base = `${defaultPdfId}.txt`;
  }

  const norm = `normalized-${base}`;
  const sk = `sk-${base}`;

  return {
    base,
    norm,
    sk,
    hasBase: fs.existsSync(path.join(dir, base)),
    hasNorm: fs.existsSync(path.join(dir, norm)),
    hasSk: fs.existsSync(path.join(dir, sk))
  };
}

// 6. GET /api/magazines/:magazine/:pdfIdOrYear/pages/:page/text - Získa text strany (s podporou pôvodného, normalizovaného a slovenského)
app.get('/api/magazines/:magazine/:pdfIdOrYear/pages/:page/text', (req, res) => {
  try {
    const { magazine, pdfIdOrYear, page } = req.params;
    const loc = findPdfLocation(magazine, pdfIdOrYear);

    if (!loc) {
      return res.status(404).json({ error: 'PDF location not found' });
    }

    const txtInfo = getVolumeTxtFiles(loc.dir, loc.pdfId);
    const pageNum = parseInt(page, 10);

    const basePath = path.join(loc.dir, txtInfo.base);
    const normPath = path.join(loc.dir, txtInfo.norm);
    const skPath = path.join(loc.dir, txtInfo.sk);

    const baseContent = txtInfo.hasBase ? getTextFileContent(basePath) : '';
    const normContent = txtInfo.hasNorm ? getTextFileContent(normPath) : '';
    const skContent = txtInfo.hasSk ? getTextFileContent(skPath) : '';

    const originalText = extractPageText(baseContent, pageNum);
    const normalizedText = extractPageText(normContent, pageNum);
    const skText = extractPageText(skContent, pageNum);

    const requestedType = req.query.type || 'original';
    let activeText = originalText;
    let activeFile = txtInfo.base;
    if (requestedType === 'normalized') {
      activeText = normalizedText;
      activeFile = txtInfo.norm;
    } else if (requestedType === 'sk') {
      activeText = skText;
      activeFile = txtInfo.sk;
    }

    res.json({
      page: pageNum,
      text: activeText,
      hasTextFile: txtInfo.hasBase || txtInfo.hasNorm || txtInfo.hasSk,
      txtFileName: activeFile,
      pdfId: loc.pdfId,
      activeType: requestedType,
      texts: {
        original: originalText,
        normalized: normalizedText,
        sk: skText
      },
      files: {
        original: txtInfo.base,
        normalized: txtInfo.norm,
        sk: txtInfo.sk
      },
      available: {
        original: txtInfo.hasBase,
        normalized: txtInfo.hasNorm,
        sk: txtInfo.hasSk
      },
      hasContent: {
        original: originalText.length > 0,
        normalized: normalizedText.length > 0,
        sk: skText.length > 0
      }
    });
  } catch (err) {
    console.error('Error getting page text:', err);
    res.status(500).json({ error: 'Failed to get page text', details: err.message });
  }
});

// 6b. PUT /api/magazines/:magazine/:pdfIdOrYear/pages/:page/text - Uloží zmeny v konkrétnej verzii textu
app.put('/api/magazines/:magazine/:pdfIdOrYear/pages/:page/text', (req, res) => {
  try {
    const { magazine, pdfIdOrYear, page } = req.params;
    const { text, type = 'original' } = req.body;

    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'Text content must be a string' });
    }

    const loc = findPdfLocation(magazine, pdfIdOrYear);
    if (!loc) {
      return res.status(404).json({ error: 'PDF location not found' });
    }

    const txtInfo = getVolumeTxtFiles(loc.dir, loc.pdfId);
    let targetFileName = txtInfo.base;
    let typeLabel = 'Pôvodný OCR text';

    if (type === 'normalized') {
      targetFileName = txtInfo.norm;
      typeLabel = 'Normalizovaný DE text';
    } else if (type === 'sk') {
      targetFileName = txtInfo.sk;
      typeLabel = 'Slovenský preklad';
    }

    const txtPath = path.join(loc.dir, targetFileName);
    updatePageTextInFile(txtPath, page, text);

    const pageNum = parseInt(page, 10);
    const chars = text.length;
    const words = (text.match(/\S+/g) || []).length;
    const lines = text.split(/\r?\n/).length;

    res.json({
      success: true,
      message: `${typeLabel} pre stranu ${pageNum} bol úspešne uložený.`,
      page: pageNum,
      type,
      txtFileName: targetFileName,
      stats: { chars, words, lines },
    });
  } catch (err) {
    console.error('Error saving page text:', err);
    res.status(500).json({ error: 'Failed to save page text', details: err.message });
  }
});

// 7. GET /api/batch - Získanie stavu nočnej dávky a zoznamu úloh
app.get('/api/batch', (req, res) => {
  try {
    const state = getBatchState();
    res.json(state);
  } catch (err) {
    console.error('Error fetching batch state:', err);
    res.status(500).json({ error: 'Failed to fetch batch state', details: err.message });
  }
});

// 7b. POST /api/batch/task - Pridanie strany alebo rozsahu strán do dávky
app.post('/api/batch/task', (req, res) => {
  try {
    const { magazine, year, pdfId, page, toPage, type = 'normalize' } = req.body;
    if (!magazine || !year || !page) {
      return res.status(400).json({ error: 'Chýbajú povinné polia: magazine, year, page' });
    }

    if (toPage && parseInt(toPage, 10) !== parseInt(page, 10)) {
      const results = addBatchTaskRange({
        magazine,
        year,
        pdfId,
        fromPage: parseInt(page, 10),
        toPage: parseInt(toPage, 10),
        type
      });
      return res.json({ success: true, count: results.length, results });
    }

    const result = addBatchTask({
      magazine,
      year,
      pdfId,
      page: parseInt(page, 10),
      type
    });
    res.json({ success: true, task: result });
  } catch (err) {
    console.error('Error adding batch task:', err);
    res.status(500).json({ error: 'Failed to add batch task', details: err.message });
  }
});

// 7c. DELETE /api/batch/task/:id - Odstránenie úlohy z dávky
app.delete('/api/batch/task/:id', (req, res) => {
  try {
    const { id } = req.params;
    const removed = removeBatchTask(id);
    if (!removed) {
      return res.status(404).json({ error: `Úloha ${id} sa nenašla v dávke.` });
    }
    res.json({ success: true, message: `Úloha ${id} bola odstránená.` });
  } catch (err) {
    console.error('Error removing batch task:', err);
    res.status(500).json({ error: 'Failed to remove batch task', details: err.message });
  }
});

// 7d. POST /api/batch/action - Vykonanie akcie (submit, status, collect, clear)
app.post('/api/batch/action', async (req, res) => {
  try {
    const { action } = req.body;
    if (action === 'submit') {
      const result = await submitBatch();
      return res.json(result);
    } else if (action === 'status') {
      const result = await checkBatchStatus();
      return res.json(result);
    } else if (action === 'collect') {
      const result = await collectBatchResults();
      return res.json(result);
    } else if (action === 'clear') {
      const cleared = clearCompletedBatchTasks();
      return res.json({ success: true, clearedCount: cleared });
    } else {
      return res.status(400).json({ error: `Neznáma akcia "${action}". Podporované: submit, status, collect, clear` });
    }
  } catch (err) {
    console.error('Error running batch action:', err);
    res.status(500).json({ error: 'Failed to execute batch action', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Viewer server is running on http://localhost:${PORT}`);
});
