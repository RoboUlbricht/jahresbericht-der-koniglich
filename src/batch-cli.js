#!/usr/bin/env node

import {
  getBatchState,
  addBatchTask,
  addBatchTaskRange,
  removeBatchTask,
  clearCompletedBatchTasks
} from './batch/batch-manager.js';
import {
  submitBatch,
  checkBatchStatus,
  collectBatchResults
} from './batch/gemini-batch.js';

function printHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                 GEMINI BATCH PROCESSING CLI                       ║
╚═══════════════════════════════════════════════════════════════════╝

Použitie:
  node src/batch-cli.js <prikaz> [argumenty]

Príkazy:
  submit                   Odošle čakajúce (pending) úlohy do Gemini Batch API
  status                   Zistí aktuálny stav dávky u Google (running / succeeded / ...)
  collect                  Stiahne hotové výsledky, uloží do task súborov a zapíše do txt
  list                     Zobrazí zoznam naplánovaných úloh a stav dávky
  clear                    Odstráni hotové (completed) úlohy z batch.json
  remove <taskId>          Odstráni konkrétnu úlohu z batch.json

Pridávanie úloh cez CLI:
  add <magazine> <year> <page> [type]
  add <magazine> <year> <fromPage>-<toPage> [type]

  Typy úloh: normalize (predvolené) | translate

Príklady:
  node src/batch-cli.js list
  node src/batch-cli.js add jahresbericht 1882 15 normalize
  node src/batch-cli.js add jahresbericht 1882 15-20 translate
  node src/batch-cli.js submit
  node src/batch-cli.js status
  node src/batch-cli.js collect
`);
}

async function handleAdd(args) {
  const [magazine, year, pageArg, typeArg = 'normalize'] = args;
  if (!magazine || !year || !pageArg) {
    console.error('Chyba: Chýbajú povinné argumenty: <magazine> <year> <page|from-to> [type]');
    process.exit(1);
  }

  const type = typeArg.toLowerCase();
  if (type !== 'normalize' && type !== 'translate') {
    console.error(`Chyba: Neplatný typ "${typeArg}". Použite "normalize" alebo "translate".`);
    process.exit(1);
  }

  if (pageArg.includes('-')) {
    const [fromStr, toStr] = pageArg.split('-');
    const fromPage = parseInt(fromStr, 10);
    const toPage = parseInt(toStr, 10);
    console.log(`Pridávam rozsah strán ${fromPage} až ${toPage} (${type}) pre ${magazine} ${year}...`);
    const results = addBatchTaskRange({
      magazine,
      year,
      fromPage,
      toPage,
      type
    });
    const ok = results.filter(r => r.success).length;
    console.log(`✓ Pridaných ${ok}/${results.length} strán do dávky.`);
  } else {
    const page = parseInt(pageArg, 10);
    console.log(`Pridávam stranu ${page} (${type}) pre ${magazine} ${year}...`);
    const res = addBatchTask({
      magazine,
      year,
      page,
      type
    });
    console.log(`✓ Úloha ${res.taskId} úspešne pridaná do dávky (${res.taskFile}).`);
  }
}

async function handleList() {
  const state = getBatchState();
  console.log('='.repeat(65));
  console.log('  STAV NOČNEJ DÁVKY (GEMINI BATCH)');
  console.log('='.repeat(65));
  console.log(`Dávka ID:        ${state.batchId || 'Zatiaľ neodoslaná'}`);
  console.log(`Stav dávky:      ${state.status.toUpperCase()}`);
  console.log(`Model:           ${state.model}`);
  console.log(`Vytvorené:       ${state.createdAt || '-'}`);
  console.log(`Odoslané:        ${state.submittedAt || '-'}`);
  console.log(`Dokončené:       ${state.completedAt || '-'}`);
  console.log(`Počet úloh:      ${state.tasks.length}`);

  const counts = {
    pending: state.tasks.filter(t => t.status === 'pending').length,
    submitted: state.tasks.filter(t => t.status === 'submitted').length,
    completed: state.tasks.filter(t => t.status === 'completed').length,
    failed: state.tasks.filter(t => t.status === 'failed').length
  };

  console.log(`Rozdelenie:      ${counts.pending} čaká | ${counts.submitted} odoslané | ${counts.completed} hotovo | ${counts.failed} chyba`);
  console.log('-'.repeat(65));

  if (state.tasks.length === 0) {
    console.log('Fronta úloh je prázdna.');
    return;
  }

  console.log('ID Úlohy                       Typ        Strana  Stav       Súbor');
  console.log('-'.repeat(65));
  for (const t of state.tasks) {
    const id = t.id.padEnd(30, ' ');
    const type = t.type.padEnd(10, ' ');
    const page = String(t.page).padStart(4, ' ');
    const status = t.status.padEnd(10, ' ');
    console.log(`${id} ${type} s.${page}  ${status} ${t.dataFile}`);
  }
  console.log('='.repeat(65));
}

async function handleSubmit() {
  console.log('Odosielam čakajúce úlohy do Gemini Batch API...');
  try {
    const res = await submitBatch();
    if (!res.success) {
      console.log(`ℹ ${res.message}`);
      return;
    }
    console.log('='.repeat(65));
    console.log('✅ DÁVKA BOLA ÚSPEŠNE ODOSLANÁ DO GOOGLE CLOUD!');
    console.log('='.repeat(65));
    console.log(`Batch ID:     ${res.batchId}`);
    console.log(`Počet úloh:   ${res.taskCount}`);
    console.log(`Model:        ${res.model}`);
    console.log('\nÚlohy sa teraz spracúvajú na pozadí.');
    console.log('Môžete pokojne vypnúť počítač.');
    console.log('Ráno spustite: node src/batch-cli.js collect');
    console.log('='.repeat(65));
  } catch (err) {
    console.error('✗ Chyba pri odosielaní dávky:', err.message);
    process.exit(1);
  }
}

async function handleStatus() {
  console.log('Zisťujem stav dávky...');
  try {
    const res = await checkBatchStatus();
    if (!res.hasBatch) {
      console.log(`ℹ ${res.message}`);
      return;
    }
    console.log('='.repeat(65));
    console.log(`Batch ID:   ${res.batchId}`);
    console.log(`Stav:       ${res.state}`);
    console.log(`Model:      ${res.model}`);
    if (res.stats) {
      console.log(`Štatistika: Celkovo ${res.stats.requestCount || '-'}, čaká ${res.stats.pendingRequestCount || '-'}`);
    }
    console.log(`Vytvorené:  ${res.createTime || '-'}`);
    console.log(`Zmena:      ${res.updateTime || '-'}`);
    console.log('='.repeat(65));

    if (res.isSuccess) {
      console.log('✨ Dávka je HOTOVÁ! Výsledky môžete prevziať príkazom:');
      console.log('   node src/batch-cli.js collect');
    } else if (res.isRunning) {
      console.log('⏳ Dávka sa stále spracúva u Google. Skúste znova o chvíľu.');
    }
  } catch (err) {
    console.error('✗ Chyba pri zisťovaní stavu:', err.message);
    process.exit(1);
  }
}

async function handleCollect() {
  console.log('Sťahujem a spracúvam výsledky dávky...');
  try {
    const res = await collectBatchResults();
    if (!res.success) {
      console.log(`ℹ ${res.message}`);
      return;
    }
    console.log('='.repeat(65));
    console.log('✅ VÝSLEDKY ÚSPEŠNE PREVZATÉ A ZAPÍSANÉ DO SÚBOROV!');
    console.log('='.repeat(65));
    console.log(`Batch ID:            ${res.batchId}`);
    console.log(`Úspešne zapísaných:  ${res.processedCount} / ${res.total}`);
    if (res.failedCount > 0) {
      console.log(`Zlyhalo:             ${res.failedCount}`);
    }
    console.log('='.repeat(65));
  } catch (err) {
    console.error('✗ Chyba pri preberaní výsledkov:', err.message);
    process.exit(1);
  }
}

async function main() {
  const [,, cmd, ...rest] = process.argv;

  switch (cmd) {
    case 'submit':
      await handleSubmit();
      break;
    case 'status':
      await handleStatus();
      break;
    case 'collect':
      await handleCollect();
      break;
    case 'list':
      await handleList();
      break;
    case 'add':
      await handleAdd(rest);
      break;
    case 'remove':
      if (!rest[0]) {
        console.error('Zadajte taskId na odstránenie.');
        process.exit(1);
      }
      if (removeBatchTask(rest[0])) {
        console.log(`✓ Úloha ${rest[0]} bola odstránená.`);
      } else {
        console.log(`Úloha ${rest[0]} sa nenašla.`);
      }
      break;
    case 'clear':
      const cleared = clearCompletedBatchTasks();
      console.log(`✓ Vyčistených ${cleared} dokončených úloh.`);
      break;
    default:
      printHelp();
      break;
  }
}

main();
