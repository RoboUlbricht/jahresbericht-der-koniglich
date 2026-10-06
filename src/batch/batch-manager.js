import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPagePrompt } from './prompt-builder.js';
import { getGeminiConfig } from '../ai-translator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const BATCH_DIR = path.resolve(PROJECT_ROOT, 'batch');
const BATCH_FILE = path.join(BATCH_DIR, 'batch.json');

/**
 * Zabezpečí existenciu priečinka batch/
 */
export function ensureBatchDir() {
  if (!fs.existsSync(BATCH_DIR)) {
    fs.mkdirSync(BATCH_DIR, { recursive: true });
  }
}

/**
 * Načíta aktuálny stav batch.json alebo vytvorí nový
 * @returns {Object}
 */
export function getBatchState() {
  ensureBatchDir();
  const config = getGeminiConfig();
  const defaultModel = config.model || 'gemini-3.8-flash';

  if (!fs.existsSync(BATCH_FILE)) {
    const initialState = {
      batchId: null,
      status: 'idle', // idle | pending | submitted | completed | failed
      model: defaultModel,
      createdAt: new Date().toISOString(),
      submittedAt: null,
      completedAt: null,
      tasks: []
    };
    fs.writeFileSync(BATCH_FILE, JSON.stringify(initialState, null, 2), 'utf-8');
    return initialState;
  }

  try {
    const content = fs.readFileSync(BATCH_FILE, 'utf-8');
    const state = JSON.parse(content);
    if (!state.model || state.model === 'gemini-2.5-flash') {
      state.model = defaultModel;
      fs.writeFileSync(BATCH_FILE, JSON.stringify(state, null, 2), 'utf-8');
    }
    return state;
  } catch (err) {
    console.error('Chyba pri čítaní batch.json:', err.message);
    throw err;
  }
}

/**
 * Uloží stav do batch.json
 * @param {Object} state
 */
export function saveBatchState(state) {
  ensureBatchDir();
  fs.writeFileSync(BATCH_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Vygeneruje unikátne ID úlohy
 * @param {string} pdfId
 * @param {number} page
 * @param {string} type
 * @returns {string}
 */
export function generateTaskId(pdfId, page, type) {
  const pStr = String(page).padStart(3, '0');
  const typeShort = type === 'normalize' ? 'norm' : 'trans';
  return `${pdfId}_p${pStr}_${typeShort}`;
}

/**
 * Pridá úlohu do batchu
 * @param {Object} params
 * @param {string} params.magazine
 * @param {string|number} params.year
 * @param {string} [params.pdfId]
 * @param {number} params.page
 * @param {'normalize'|'translate'} params.type
 * @returns {{ taskId: string, isNew: boolean }}
 */
export function addBatchTask({ magazine, year, pdfId = null, page, type }) {
  ensureBatchDir();
  const state = getBatchState();
  const activePdfId = pdfId || String(year);
  const taskId = generateTaskId(activePdfId, page, type);
  const taskFileName = `task_${taskId}.json`;
  const taskFilePath = path.join(BATCH_DIR, taskFileName);

  // 1. Zostavíme prompt a inštrukcie
  const promptData = buildPagePrompt({
    magazine,
    year,
    pdfId: activePdfId,
    page,
    type
  });

  const taskPayload = {
    id: taskId,
    type,
    magazine,
    year: Number(year) || year,
    pdfId: activePdfId,
    page: promptData.page,
    targetFile: promptData.targetFile,
    sourceFile: promptData.sourceFile,
    createdAt: new Date().toISOString(),
    input: {
      systemInstruction: promptData.systemInstruction,
      userPrompt: promptData.userPrompt,
      temperature: promptData.temperature
    },
    output: {
      rawResponse: null,
      processedText: null,
      completedAt: null,
      error: null
    }
  };

  // Uložíme samostatný súbor s dátami
  fs.writeFileSync(taskFilePath, JSON.stringify(taskPayload, null, 2), 'utf-8');

  // 2. Zaregistrujeme do batch.json
  const existingIdx = state.tasks.findIndex(t => t.id === taskId);
  const taskMeta = {
    id: taskId,
    type,
    magazine,
    year: Number(year) || year,
    pdfId: activePdfId,
    page: promptData.page,
    status: 'pending',
    dataFile: taskFileName,
    targetFile: promptData.targetFile,
    addedAt: new Date().toISOString()
  };

  let isNew = true;
  if (existingIdx !== -1) {
    state.tasks[existingIdx] = taskMeta;
    isNew = false;
  } else {
    state.tasks.push(taskMeta);
  }

  // Ak je stav dávky idle alebo completed, prepneme na pending (sú tam nové úlohy)
  if (state.status === 'idle' || state.status === 'completed') {
    state.status = 'pending';
  }

  saveBatchState(state);
  return { taskId, isNew, taskFile: taskFileName };
}

/**
 * Pridá rozsah strán do dávky
 * @param {Object} params
 * @returns {Array<{ taskId: string, page: number, isNew: boolean }>}
 */
export function addBatchTaskRange({ magazine, year, pdfId = null, fromPage, toPage, type }) {
  const start = Math.min(fromPage, toPage);
  const end = Math.max(fromPage, toPage);
  const results = [];

  for (let p = start; p <= end; p++) {
    try {
      const res = addBatchTask({
        magazine,
        year,
        pdfId,
        page: p,
        type
      });
      results.push({ page: p, ...res, success: true });
    } catch (err) {
      results.push({ page: p, success: false, error: err.message });
    }
  }

  return results;
}

/**
 * Odstráni úlohu z batchu
 * @param {string} taskId
 * @returns {boolean}
 */
export function removeBatchTask(taskId) {
  const state = getBatchState();
  const idx = state.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return false;

  const [removed] = state.tasks.splice(idx, 1);

  // Zmažeme aj súbor úlohy, ak existuje
  if (removed.dataFile) {
    const taskFilePath = path.join(BATCH_DIR, removed.dataFile);
    if (fs.existsSync(taskFilePath)) {
      try {
        fs.unlinkSync(taskFilePath);
      } catch (err) {
        console.warn(`Nepodarilo sa zmazať súbor ${taskFilePath}:`, err.message);
      }
    }
  }

  // Ak už nie sú žiadne úlohy
  if (state.tasks.length === 0) {
    state.status = 'idle';
    state.batchId = null;
  }

  saveBatchState(state);
  return true;
}

/**
 * Vyčistí hotové (completed) úlohy a zresetuje dávku na idle
 * @returns {number} počet zmazaných úloh
 */
export function clearCompletedBatchTasks() {
  const state = getBatchState();
  const completed = state.tasks.filter(t => t.status === 'completed');

  for (const t of completed) {
    if (t.dataFile) {
      const p = path.join(BATCH_DIR, t.dataFile);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  }

  state.tasks = state.tasks.filter(t => t.status !== 'completed');
  if (state.tasks.length === 0) {
    state.status = 'idle';
    state.batchId = null;
    state.submittedAt = null;
    state.completedAt = null;
  }

  saveBatchState(state);
  return completed.length;
}

/**
 * Načíta dáta konkrétnej úlohy zo súboru task_<id>.json
 * @param {string} dataFile
 * @returns {Object|null}
 */
export function loadTaskData(dataFile) {
  const p = path.join(BATCH_DIR, dataFile);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

/**
 * Uloží dáta konkrétnej úlohy do súboru task_<id>.json
 * @param {string} dataFile
 * @param {Object} data
 */
export function saveTaskData(dataFile, data) {
  const p = path.join(BATCH_DIR, dataFile);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}
