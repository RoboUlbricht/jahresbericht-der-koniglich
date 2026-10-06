import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGeminiConfig } from '../ai-translator.js';
import {
  getBatchState,
  saveBatchState,
  loadTaskData,
  saveTaskData
} from './batch-manager.js';
import { updatePageTextInFile } from './file-updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');

/**
 * Odstráni obalujúci kódový blok (```markdown ... ```)
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFences(text) {
  if (!text) return '';
  let cleaned = text.trim();
  const fenceRegex = /^```(?:markdown|md|text)?\r?\n([\s\S]*?)\r?\n```$/;
  const match = cleaned.match(fenceRegex);
  if (match) {
    cleaned = match[1].trim();
  }
  return cleaned;
}

/**
 * Odstráni prípadnú duplicitnú úvodnú hlavičku "## Page: X",
 * pretože file-updater ju vkladá automaticky.
 * @param {string} text
 * @param {number} pageNum
 * @returns {string}
 */
export function cleanPageContent(text, pageNum) {
  let cleaned = stripCodeFences(text);
  // Odstránenie úvodnej ## Page: <číslo>
  const headerRegex = new RegExp(`^## Page:\\s*${pageNum}\\s*\\r?\\n`, 'i');
  cleaned = cleaned.replace(headerRegex, '').trim();
  return cleaned;
}

/**
 * Odošle všetky čakajúce (pending) úlohy do Gemini Batch API
 * @param {Object} [options]
 * @param {string} [options.model]
 * @returns {Promise<Object>}
 */
export async function submitBatch(options = {}) {
  const config = getGeminiConfig();
  if (!config.apiKey) {
    throw new Error('V .env súbore chýba GEMINI_API_KEY.');
  }

  const state = getBatchState();
  const pendingTasks = state.tasks.filter(t => t.status === 'pending');

  if (pendingTasks.length === 0) {
    return {
      success: false,
      message: 'Žiadne čakajúce úlohy (pending) na odoslanie do dávky.'
    };
  }

  const model = options.model || config.model || state.model || 'gemini-3.8-flash';
  const requests = [];

  for (const task of pendingTasks) {
    const taskData = loadTaskData(task.dataFile);
    if (!taskData || !taskData.input) {
      throw new Error(`Chýbajú vstupné podklady pre úlohu ${task.id} (${task.dataFile}).`);
    }

    requests.push({
      request: {
        contents: [
          {
            role: 'user',
            parts: [{ text: taskData.input.userPrompt }]
          }
        ],
        systemInstruction: taskData.input.systemInstruction
          ? { parts: [{ text: taskData.input.systemInstruction }] }
          : undefined,
        generationConfig: {
          temperature: taskData.input.temperature ?? 0.1
        }
      },
      metadata: {
        key: task.id
      }
    });
  }

  const batchDisplayName = `batch-${Date.now()}`;
  const payload = {
    batch: {
      displayName: batchDisplayName,
      inputConfig: {
        requests: {
          requests
        }
      }
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchGenerateContent?key=${config.apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Gemini Batch API HTTP ${response.status}: ${errBody}`);
  }

  const resData = await response.json();
  const batchId = resData.name; // napr. "batches/..."

  // Aktualizácia stavu
  state.batchId = batchId;
  state.status = 'submitted';
  state.model = model;
  state.submittedAt = new Date().toISOString();
  state.completedAt = null;

  for (const t of pendingTasks) {
    t.status = 'submitted';
    t.submittedAt = state.submittedAt;
  }

  saveBatchState(state);

  return {
    success: true,
    batchId,
    taskCount: pendingTasks.length,
    model,
    displayName: batchDisplayName,
    raw: resData
  };
}

/**
 * Zistí stav aktuálnej dávky z Gemini Batch API
 * @returns {Promise<Object>}
 */
export async function checkBatchStatus() {
  const config = getGeminiConfig();
  if (!config.apiKey) {
    throw new Error('V .env súbore chýba GEMINI_API_KEY.');
  }

  const state = getBatchState();
  if (!state.batchId) {
    return {
      hasBatch: false,
      message: 'Nie je zaregistrované žiadne ID dávky (batchId).'
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/${state.batchId}?key=${config.apiKey}`;
  const response = await fetch(url);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Gemini Batch API HTTP ${response.status}: ${errBody}`);
  }

  const resData = await response.json();
  const meta = resData.metadata || {};
  const batchState = meta.state || 'UNKNOWN';

  return {
    hasBatch: true,
    batchId: state.batchId,
    state: batchState,
    isDone: batchState === 'BATCH_STATE_SUCCEEDED' || batchState === 'BATCH_STATE_FAILED' || batchState === 'BATCH_STATE_CANCELLED',
    isSuccess: batchState === 'BATCH_STATE_SUCCEEDED',
    isFailed: batchState === 'BATCH_STATE_FAILED',
    isRunning: batchState === 'BATCH_STATE_RUNNING' || batchState === 'BATCH_STATE_PENDING',
    stats: meta.batchStats || null,
    model: meta.model || state.model,
    createTime: meta.createTime,
    updateTime: meta.updateTime,
    raw: resData
  };
}

/**
 * Ráno stiahne hotové výsledky, uloží ich do task_<id>.json a zapíše do cieľových súborov
 * @returns {Promise<Object>}
 */
export async function collectBatchResults() {
  const statusInfo = await checkBatchStatus();
  if (!statusInfo.hasBatch) {
    return { success: false, message: statusInfo.message };
  }

  if (statusInfo.isRunning) {
    return {
      success: false,
      state: statusInfo.state,
      message: `Dávka ${statusInfo.batchId} ešte stále beží (${statusInfo.state}). Skúste to neskôr.`
    };
  }

  if (!statusInfo.isSuccess) {
    return {
      success: false,
      state: statusInfo.state,
      message: `Dávka neskončila úspešne (${statusInfo.state}).`
    };
  }

  const state = getBatchState();
  const rawData = statusInfo.raw;
  const meta = rawData.metadata || {};

  // Získanie odpovedí
  let responses = [];
  const inlinedObj = meta.output?.inlinedResponses || rawData.response?.inlinedResponses || rawData.output?.inlinedResponses;

  if (Array.isArray(inlinedObj)) {
    responses = inlinedObj;
  } else if (inlinedObj && Array.isArray(inlinedObj.inlinedResponses)) {
    responses = inlinedObj.inlinedResponses;
  } else if (meta.output && meta.output.responsesFile) {
    // Ak by boli vo výstupnom súbore cez Files API
    const config = getGeminiConfig();
    const fileUrl = `https://generativelanguage.googleapis.com/v1beta/${meta.output.responsesFile}?key=${config.apiKey}&alt=media`;
    const fRes = await fetch(fileUrl);
    if (fRes.ok) {
      const fileText = await fRes.text();
      const lines = fileText.split(/\r?\n/).filter(l => l.trim().length > 0);
      responses = lines.map(line => JSON.parse(line));
    }
  }

  if (responses.length === 0) {
    throw new Error('Dávka je v stave SUCCEEDED, ale neboli nájdené žiadne výstupy (inlinedResponses).');
  }

  // Vytvorenie mapy odpovedí podľa kľúča úlohy (alebo podľa poradia)
  const submittedTasks = state.tasks.filter(t => t.status === 'submitted');
  let processedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < submittedTasks.length; i++) {
    const task = submittedTasks[i];
    // Pokúsime sa nájsť podľa metadata.key, inak podľa indexu
    let respItem = responses.find(r => r.metadata?.key === task.id) || responses[i];

    if (!respItem) {
      task.status = 'failed';
      task.error = 'Odpoveď pre úlohu sa nenašla v dávke.';
      failedCount++;
      continue;
    }

    try {
      const candidateText = respItem.response?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!candidateText) {
        throw new Error('Prázdna odpoveď od modelu pre danú stranu.');
      }

      const cleanedText = cleanPageContent(candidateText, task.page);

      // 1. Uložíme do task_<id>.json
      const taskData = loadTaskData(task.dataFile) || {};
      taskData.output = {
        rawResponse: candidateText,
        processedText: cleanedText,
        completedAt: new Date().toISOString(),
        error: null
      };
      saveTaskData(task.dataFile, taskData);

      // 2. Zapíšeme priamo do cieľového súboru (normalized-*.txt alebo sk-*.txt)
      const absTargetFilePath = path.resolve(PROJECT_ROOT, task.targetFile);
      updatePageTextInFile(absTargetFilePath, task.page, cleanedText);

      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      processedCount++;
    } catch (err) {
      task.status = 'failed';
      task.error = err.message;
      failedCount++;
    }
  }

  state.status = 'completed';
  state.completedAt = new Date().toISOString();
  saveBatchState(state);

  return {
    success: true,
    processedCount,
    failedCount,
    total: submittedTasks.length,
    batchId: state.batchId
  };
}
