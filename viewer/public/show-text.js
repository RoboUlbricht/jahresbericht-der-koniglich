const app = angular.module('showTextApp', []);

app.controller('ShowTextCtrl', ['$scope', '$http', '$timeout', function($scope, $http, $timeout) {
  $scope.magazines = [];
  $scope.selectedMagazine = null;
  $scope.availableYears = [];
  $scope.selectedYear = null;
  $scope.activePdfId = null;

  $scope.thumbnails = [];
  $scope.currentPage = null;
  $scope.jumpPageNumber = null;
  $scope.thumbFilter = '';

  // Scan viewer controls
  $scope.zoomLevel = 100; // in percent
  $scope.fitMode = 'width'; // 'width', 'height', 'custom', 'actual'
  $scope.imageLoading = false;
  $scope.imageError = false;

  // Text editor controls
  $scope.activeTextType = 'original'; // 'original' | 'normalized' | 'sk'
  $scope.texts = {
    original: { text: '', originalText: '', isDirty: false },
    normalized: { text: '', originalText: '', isDirty: false },
    sk: { text: '', originalText: '', isDirty: false }
  };
  $scope.textFiles = {
    original: null,
    normalized: null,
    sk: null
  };
  $scope.textAvailable = {
    original: false,
    normalized: false,
    sk: false
  };
  $scope.hasContent = {
    original: false,
    normalized: false,
    sk: false
  };

  $scope.pageText = '';
  $scope.originalPageText = '';
  $scope.isTextDirty = false;
  $scope.isSavingText = false;
  $scope.hasTextFile = true;
  $scope.currentTxtFile = null;
  $scope.textLoading = false;
  $scope.textFontSize = 14; // in px
  $scope.textStats = { words: 0, chars: 0, lines: 0 };

  $scope.notification = null;

  function showNotification(message, type = 'success') {
    $scope.notification = { message, type };
    $timeout(() => {
      if ($scope.notification && $scope.notification.message === message) {
        $scope.notification = null;
      }
    }, 3500);
  }

  // 1. Načítanie časopisov
  $scope.loadMagazines = function() {
    $http.get('/api/magazines')
      .then(function(res) {
        $scope.magazines = res.data || [];
        if ($scope.magazines.length > 0) {
          const urlParams = new URLSearchParams(window.location.search);
          const urlMag = urlParams.get('mag');
          const foundMag = $scope.magazines.find(m => m.directory === urlMag);

          $scope.selectedMagazine = foundMag || $scope.magazines[0];
          $scope.onMagazineChange(true);
        }
      })
      .catch(function(err) {
        showNotification('Chyba pri načítaní časopisov: ' + (err.data?.error || err.statusText), 'danger');
      });
  };

  // 2. Zmena vybraného časopisu
  $scope.onMagazineChange = function(initial = false) {
    if (!$scope.selectedMagazine) return;

    if (!initial && $scope.hasAnyDirtyText()) {
      if (!confirm(`Máte neuložené zmeny na strane ${$scope.currentPage}. Chcete zmeniť časopis a zahodiť zmeny?`)) {
        return;
      }
    }

    const published = $scope.selectedMagazine.published || [];
    $scope.availableYears = published.map(p => p.year);

    const urlParams = new URLSearchParams(window.location.search);
    const urlYear = parseInt(urlParams.get('year'), 10);
    const foundYear = $scope.availableYears.find(y => y === urlYear);

    if (initial && foundYear) {
      $scope.selectedYear = foundYear;
    } else if ($scope.availableYears.length > 0) {
      $scope.selectedYear = $scope.availableYears[0];
    } else {
      $scope.selectedYear = null;
    }

    $scope.onYearChange(initial);
  };

  // 3. Zmena ročníka
  $scope.onYearChange = function(initial = false) {
    if (!initial && $scope.hasAnyDirtyText()) {
      if (!confirm(`Máte neuložené zmeny na strane ${$scope.currentPage}. Chcete zmeniť ročník a zahodiť zmeny?`)) {
        return;
      }
    }

    if (!$scope.selectedMagazine || !$scope.selectedYear) {
      $scope.thumbnails = [];
      $scope.currentPage = null;
      $scope.pageText = '';
      $scope.originalPageText = '';
      $scope.isTextDirty = false;
      return;
    }

    const published = $scope.selectedMagazine.published || [];
    const pubInfo = published.find(p => p.year === $scope.selectedYear);
    $scope.activePdfId = pubInfo ? pubInfo.id : null;

    $scope.loadThumbnails(initial);
  };

  // 4. Načítanie miniatúr pre ročník
  $scope.loadThumbnails = function(initial = false) {
    const magDir = $scope.selectedMagazine.directory;
    const yearOrId = $scope.activePdfId || $scope.selectedYear;

    $http.get(`/api/magazines/${magDir}/${yearOrId}/thumbnails`)
      .then(function(res) {
        $scope.thumbnails = res.data?.pages || [];
        if (res.data?.pdfId) {
          $scope.activePdfId = res.data.pdfId;
        }

        const urlParams = new URLSearchParams(window.location.search);
        const urlPage = parseInt(urlParams.get('page'), 10);

        if (initial && urlPage && $scope.thumbnails.includes(urlPage)) {
          $scope.selectPage(urlPage, true);
        } else if ($scope.thumbnails.length > 0) {
          $scope.selectPage($scope.thumbnails[0], true);
        } else {
          $scope.currentPage = null;
          $scope.pageText = '';
          $scope.originalPageText = '';
          $scope.isTextDirty = false;
        }
      })
      .catch(function(err) {
        $scope.thumbnails = [];
        showNotification('Chyba pri načítaní miniatúr ročníka', 'danger');
      });
  };

  // 5. Výber strany
  $scope.selectPage = function(pageNum, force = false) {
    if (!pageNum) return;
    if (pageNum === $scope.currentPage && !force) return;

    if (!force && $scope.hasAnyDirtyText()) {
      const confirmLeave = confirm(`Máte neuložené zmeny na strane ${$scope.currentPage}. Chcete prejsť na stranu ${pageNum} a zahodiť zmeny?`);
      if (!confirmLeave) return;
    }

    $scope.currentPage = pageNum;
    $scope.jumpPageNumber = pageNum;
    $scope.isTextDirty = false;

    // Aktualizácia URL query parametrov
    const url = new URL(window.location);
    if ($scope.selectedMagazine) url.searchParams.set('mag', $scope.selectedMagazine.directory);
    if ($scope.selectedYear) url.searchParams.set('year', $scope.selectedYear);
    url.searchParams.set('page', pageNum);
    window.history.replaceState({}, '', url);

    // Scroll miniatúry do viditeľnej oblasti
    $timeout(() => {
      const el = document.getElementById('thumb-item-' + pageNum);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 50);

    // Načítanie skenu a textu
    $scope.imageLoading = true;
    $scope.imageError = false;
    $scope.loadPageText(pageNum);
  };

  // 6. Navigácia medzi stranami
  $scope.prevPage = function() {
    if (!$scope.currentPage || $scope.thumbnails.length === 0) return;
    const idx = $scope.thumbnails.indexOf($scope.currentPage);
    if (idx > 0) {
      $scope.selectPage($scope.thumbnails[idx - 1]);
    }
  };

  $scope.nextPage = function() {
    if (!$scope.currentPage || $scope.thumbnails.length === 0) return;
    const idx = $scope.thumbnails.indexOf($scope.currentPage);
    if (idx >= 0 && idx < $scope.thumbnails.length - 1) {
      $scope.selectPage($scope.thumbnails[idx + 1]);
    }
  };

  $scope.jumpToPage = function() {
    if (!$scope.jumpPageNumber) return;
    const p = parseInt($scope.jumpPageNumber, 10);
    if ($scope.thumbnails.includes(p)) {
      $scope.selectPage(p);
    } else {
      showNotification(`Strana ${p} sa v zozname miniatúr nenachádza.`, 'warning');
    }
  };

  // Pomocné funkcie pre viac verzií textu
  $scope.hasAnyDirtyText = function() {
    return ($scope.texts.original && $scope.texts.original.isDirty) ||
           ($scope.texts.normalized && $scope.texts.normalized.isDirty) ||
           ($scope.texts.sk && $scope.texts.sk.isDirty);
  };

  $scope.syncActiveText = function() {
    const currentObj = $scope.texts[$scope.activeTextType] || $scope.texts.original;
    $scope.pageText = currentObj.text;
    $scope.originalPageText = currentObj.originalText;
    $scope.isTextDirty = currentObj.isDirty;
    $scope.currentTxtFile = $scope.textFiles[$scope.activeTextType] || null;
    $scope.calculateTextStats($scope.pageText);
  };

  $scope.switchTextType = function(type) {
    if (type === $scope.activeTextType) return;
    $scope.activeTextType = type;
    $scope.syncActiveText();
    $timeout(() => {
      const textarea = document.getElementById('pageTextEditor');
      if (textarea) textarea.focus();
    }, 0);
  };

  $scope.getActiveLabel = function() {
    switch ($scope.activeTextType) {
      case 'normalized': return 'Normalizovaný DE';
      case 'sk': return 'Slovenský preklad';
      default: return 'Pôvodný OCR';
    }
  };

  $scope.getActivePlaceholder = function() {
    if (!$scope.currentPage) return 'Vyberte stranu...';
    switch ($scope.activeTextType) {
      case 'normalized':
        return `Sem napíšte alebo upravte normalizovaný nemecký text strany ${$scope.currentPage}...`;
      case 'sk':
        return `Sem napíšte alebo upravte slovenský preklad textu strany ${$scope.currentPage}...`;
      default:
        return `Sem napíšte alebo upravte pôvodný OCR text strany ${$scope.currentPage}...`;
    }
  };

  // 7. Načítanie textu strany
  $scope.loadPageText = function(pageNum) {
    if (!$scope.selectedMagazine) return;
    const magDir = $scope.selectedMagazine.directory;
    const yearOrId = $scope.activePdfId || $scope.selectedYear;

    $scope.textLoading = true;
    $scope.pageText = '';
    $scope.originalPageText = '';
    $scope.isTextDirty = false;

    $http.get(`/api/magazines/${magDir}/${yearOrId}/pages/${pageNum}/text`)
      .then(function(res) {
        $scope.textLoading = false;
        const data = res.data;

        const orig = (data?.texts?.original || '').replace(/\r\n/g, '\n');
        const norm = (data?.texts?.normalized || '').replace(/\r\n/g, '\n');
        const sk = (data?.texts?.sk || '').replace(/\r\n/g, '\n');

        $scope.texts.original = { text: orig, originalText: orig, isDirty: false };
        $scope.texts.normalized = { text: norm, originalText: norm, isDirty: false };
        $scope.texts.sk = { text: sk, originalText: sk, isDirty: false };

        $scope.textFiles = data?.files || {};
        $scope.textAvailable = data?.available || {};
        $scope.hasContent = {
          original: orig.trim().length > 0,
          normalized: norm.trim().length > 0,
          sk: sk.trim().length > 0
        };

        $scope.hasTextFile = data?.hasTextFile !== false;
        $scope.syncActiveText();
      })
      .catch(function(err) {
        $scope.textLoading = false;
        $scope.texts.original = { text: '', originalText: '', isDirty: false };
        $scope.texts.normalized = { text: '', originalText: '', isDirty: false };
        $scope.texts.sk = { text: '', originalText: '', isDirty: false };
        $scope.hasContent = { original: false, normalized: false, sk: false };
        $scope.hasTextFile = false;
        $scope.syncActiveText();
      });
  };

  // 8. Reakcia na zmenu textu v editore
  $scope.onTextChange = function() {
    const current = ($scope.pageText || '').replace(/\r\n/g, '\n');
    const target = $scope.texts[$scope.activeTextType];
    if (target) {
      target.text = current;
      target.isDirty = (current !== target.originalText);
      $scope.isTextDirty = target.isDirty;
    }
    $scope.hasContent[$scope.activeTextType] = current.trim().length > 0;
    $scope.calculateTextStats(current);
  };

  // 9. Uloženie upraveného textu do príslušného súboru
  $scope.savePageText = function() {
    if (!$scope.selectedMagazine || !$scope.currentPage) return;
    const magDir = $scope.selectedMagazine.directory;
    const yearOrId = $scope.activePdfId || $scope.selectedYear;
    const pageNum = $scope.currentPage;
    const type = $scope.activeTextType;
    const textToSave = $scope.pageText || '';

    $scope.isSavingText = true;

    $http.put(`/api/magazines/${magDir}/${yearOrId}/pages/${pageNum}/text`, {
      text: textToSave,
      type: type
    })
      .then(function(res) {
        $scope.isSavingText = false;
        const target = $scope.texts[type];
        if (target) {
          const savedClean = textToSave.replace(/\r\n/g, '\n');
          target.originalText = savedClean;
          target.text = savedClean;
          target.isDirty = false;
        }
        $scope.isTextDirty = false;
        $scope.hasContent[type] = textToSave.trim().length > 0;
        $scope.textAvailable[type] = true;
        if (res.data?.txtFileName) {
          $scope.textFiles[type] = res.data.txtFileName;
          $scope.currentTxtFile = res.data.txtFileName;
        }
        showNotification(res.data?.message || `Text pre stranu ${pageNum} bol úspešne uložený.`, 'success');
      })
      .catch(function(err) {
        $scope.isSavingText = false;
        showNotification('Chyba pri ukladaní textu: ' + (err.data?.error || err.statusText), 'danger');
      });
  };

  // 10. Vrátenie zmien v texte
  $scope.resetText = function() {
    const target = $scope.texts[$scope.activeTextType];
    if (!target || !target.isDirty) return;
    target.text = target.originalText;
    target.isDirty = false;
    $scope.syncActiveText();
    showNotification(`Zmeny v texte (${$scope.getActiveLabel()}) boli vrátené späť.`, 'info');
  };

  // 11. Čistenie OCR textu (spojenie rozdelených slov na koncoch riadkov)
  $scope.cleanPageText = function() {
    if (!$scope.pageText) return;
    let t = $scope.pageText;
    // Spojenie slov rozdelených pomlčkou na konci riadku (geolo- \n gischen -> geologischen)
    t = t.replace(/(\b[a-zA-ZäöüßÄÖÜáéíóúÁÉÍÓÚ]+)-\s*\r?\n\s*([a-zA-ZäöüßÄÖÜáéíóúÁÉÍÓÚ]+)/g, '$1$2');
    // Odstránenie prebytočných medzier na koncoch riadkov
    t = t.replace(/[ \t]+$/gm, '');
    $scope.pageText = t;
    $scope.onTextChange();
    showNotification('Text bol vyčistený (spojené slová na koncoch riadkov).', 'info');
  };

  $scope.lastSelection = { start: -1, end: -1 };

  $scope.onTextSelect = function() {
    const textarea = document.getElementById('pageTextEditor');
    if (textarea && typeof textarea.selectionStart === 'number' && typeof textarea.selectionEnd === 'number') {
      if (textarea.selectionStart < textarea.selectionEnd) {
        $scope.lastSelection = { start: textarea.selectionStart, end: textarea.selectionEnd };
      }
    }
  };

  // 11b. Oprava typografie (medzery pred bodkami, zdvojené medzery, medzery pred dvojbodkami)
  $scope.fixSelectedText = function() {
    if (!$scope.pageText) return;

    function cleanTypography(str) {
      if (!str) return '';
      let s = str;
      // 1. Odstránenie medzier pred bodkami (napr. "slovo . " -> "slovo. ")
      s = s.replace(/[ \t]+\./g, '.');
      // 2. Odstránenie medzier pred dvojbodkami (napr. "slovo : " -> "slovo: ")
      s = s.replace(/[ \t]+:/g, ':');
      // 3. Odstránenie medzier pred čiarkami a bodkočiarkami
      s = s.replace(/[ \t]+([,;])/g, '$1');
      // 4. Nahradenie zdvojených a viacnásobných medzier jednou medzerou (nezahŕňa nové riadky)
      s = s.replace(/[^\S\r\n]{2,}/g, ' ');
      return s;
    }

    const textarea = document.getElementById('pageTextEditor');
    let start = -1;
    let end = -1;
    if (textarea) {
      start = textarea.selectionStart;
      end = textarea.selectionEnd;
    }

    if (start === end && $scope.lastSelection && $scope.lastSelection.start < $scope.lastSelection.end) {
      start = $scope.lastSelection.start;
      end = $scope.lastSelection.end;
    }

    if (start >= 0 && end > start) {
      // Používateľ má vyznačený konkrétny úsek textu
      const originalSelected = $scope.pageText.substring(start, end);
      const fixedSelected = cleanTypography(originalSelected);

      if (originalSelected === fixedSelected) {
        showNotification('V označenom texte neboli nájdené žiadne medzery pred bodkami, dvojbodkami ani zdvojené medzery.', 'info');
        return;
      }

      $scope.pageText = $scope.pageText.substring(0, start) + fixedSelected + $scope.pageText.substring(end);
      $scope.onTextChange();
      $scope.lastSelection = { start, end: start + fixedSelected.length };

      $timeout(() => {
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(start, start + fixedSelected.length);
        }
      }, 0);

      showNotification('Označený text bol opravený.', 'success');
    } else {
      // Ak nie je označený žiaden úsek, opravíme celý text strany
      const originalText = $scope.pageText;
      const fixedText = cleanTypography(originalText);

      if (originalText === fixedText) {
        showNotification('V texte strany neboli nájdené žiadne medzery pred bodkami, dvojbodkami ani zdvojené medzery.', 'info');
        return;
      }

      $scope.pageText = fixedText;
      $scope.onTextChange();
      showNotification('Celý text strany bol opravený (medzery pred bodkami, dvojbodkami a zdvojené medzery).', 'success');
    }
  };

  // 11c. Spojenie označeného textu do jedného riadku (pre OCR chyby so slovami na samostatných riadkoch)
  $scope.joinSelectedLines = function() {
    if (!$scope.pageText) return;

    const textarea = document.getElementById('pageTextEditor');
    let start = -1;
    let end = -1;
    if (textarea) {
      start = textarea.selectionStart;
      end = textarea.selectionEnd;
    }

    // Ak sa pri kliknutí na tlačidlo stratil selection z DOM, použijeme uložený lastSelection
    if (start === end && $scope.lastSelection && $scope.lastSelection.start < $scope.lastSelection.end) {
      start = $scope.lastSelection.start;
      end = $scope.lastSelection.end;
    }

    // Funkcia funguje VÝHRADNE na označený text
    if (start < 0 || end <= start) {
      showNotification('Najskôr v editore označte text, ktorý chcete spojiť do jedného riadku.', 'warning');
      return;
    }

    const selectedText = $scope.pageText.substring(start, end);

    // 1. Spojenie prípadných slov rozdelených pomlčkou na konci riadku
    let s = selectedText.replace(/(\b[a-zA-ZäöüßÄÖÜáéíóúÁÉÍÓÚ]+)-\s*\r?\n\s*([a-zA-ZäöüßÄÖÜáéíóúÁÉÍÓÚ]+)/g, '$1$2');
    // 2. Nahradenie všetkých odriadkovaní medzerou
    s = s.replace(/\r?\n+/g, ' ');
    // 3. Odstránenie medzier pred interpunkciou (napr. slovo , -> slovo,)
    s = s.replace(/[ \t]+([.,;:!?])/g, '$1');
    // 4. Nahradenie viacnásobných medzier jednou medzerou
    s = s.replace(/[^\S\r\n]{2,}/g, ' ');
    // 5. Orezanie okrajových medzier spojeného úseku
    const joinedText = s.trim();

    $scope.pageText = $scope.pageText.substring(0, start) + joinedText + $scope.pageText.substring(end);
    $scope.onTextChange();
    $scope.lastSelection = { start, end: start + joinedText.length };

    $timeout(() => {
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(start, start + joinedText.length);
      }
    }, 0);

    showNotification('Označený text bol úspešne spojený do jedného riadku.', 'success');
  };

  // 12. Výpočet štatistík textu
  $scope.calculateTextStats = function(text) {
    if (!text) {
      $scope.textStats = { words: 0, chars: 0, lines: 0 };
      return;
    }
    const chars = text.length;
    const words = (text.match(/\S+/g) || []).length;
    const lines = text.split(/\r?\n/).length;
    $scope.textStats = { words, chars, lines };
  };

  // 13. Zoom ovládanie
  $scope.zoomIn = function() {
    if ($scope.zoomLevel < 300) {
      $scope.zoomLevel = Math.min(300, $scope.zoomLevel + 25);
      $scope.fitMode = 'custom';
    }
  };

  $scope.zoomOut = function() {
    if ($scope.zoomLevel > 30) {
      $scope.zoomLevel = Math.max(30, $scope.zoomLevel - 25);
      $scope.fitMode = 'custom';
    }
  };

  $scope.resetZoom = function() {
    $scope.zoomLevel = 100;
    $scope.fitMode = 'width';
  };

  $scope.setFitMode = function(mode) {
    $scope.fitMode = mode;
    if (mode === 'actual') $scope.zoomLevel = 100;
  };

  // 14. Veľkosť písma textu
  $scope.increaseFontSize = function() {
    if ($scope.textFontSize < 24) $scope.textFontSize += 2;
  };

  $scope.decreaseFontSize = function() {
    if ($scope.textFontSize > 11) $scope.textFontSize -= 2;
  };

  // 15. Kopírovanie textu do schránky
  $scope.copyText = function() {
    if (!$scope.pageText) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText($scope.pageText).then(() => {
        showNotification('Text strany bol skopírovaný do schránky.');
      }).catch(() => {
        fallbackCopyText($scope.pageText);
      });
    } else {
      fallbackCopyText($scope.pageText);
    }
  };

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showNotification('Text strany bol skopírovaný do schránky.');
  }

  // 16. Klávesové skratky (Ctrl+S na uloženie, šípky na listovanie)
  window.addEventListener('keydown', function(e) {
    // Ctrl+S / Cmd+S na uloženie textu funguje VŽDY
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if ($scope.isTextDirty && !$scope.isSavingText) {
        $scope.$apply(() => $scope.savePageText());
      }
      return;
    }

    // Listovanie šípkami ignorujeme, ak používateľ práve píše v editore textu
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      $scope.$apply(() => $scope.prevPage());
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      $scope.$apply(() => $scope.nextPage());
    }
  });

  // Ochrana pred nechceným zatvorením okna s neuloženými zmenami
  window.addEventListener('beforeunload', function(e) {
    if ($scope.isTextDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // 17. Správa nočných dávok (Gemini Batch)
  $scope.batchState = {
    batchId: null,
    status: 'idle',
    model: 'gemini-3.8-flash',
    tasks: []
  };
  $scope.batchModalOpen = false;
  $scope.batchForm = {
    type: 'normalize',
    mode: 'current', // 'current' | 'range'
    fromPage: 1,
    toPage: 1
  };
  $scope.isBatchActionRunning = false;
  $scope.batchActionMessage = null;

  $scope.loadBatchState = function() {
    $http.get('/api/batch')
      .then(function(res) {
        $scope.batchState = res.data || { status: 'idle', tasks: [] };
      })
      .catch(function(err) {
        console.warn('Nepodarilo sa načítať stav dávky:', err);
      });
  };

  $scope.openBatchModal = function() {
    $scope.batchModalOpen = true;
    if ($scope.currentPage) {
      $scope.batchForm.fromPage = $scope.currentPage;
      $scope.batchForm.toPage = $scope.currentPage;
    }
    $scope.batchActionMessage = null;
    $scope.loadBatchState();
  };

  $scope.closeBatchModal = function() {
    $scope.batchModalOpen = false;
    $scope.batchActionMessage = null;
  };

  $scope.getCurrentPageBatchTask = function() {
    if (!$scope.currentPage || !$scope.batchState || !$scope.batchState.tasks) return null;
    const yearNum = Number($scope.selectedYear);
    return $scope.batchState.tasks.find(t => 
      t.magazine === $scope.selectedMagazine?.directory && 
      (t.year === yearNum || String(t.year) === String($scope.selectedYear)) && 
      t.page === $scope.currentPage
    );
  };

  $scope.quickAddCurrentPageToBatch = function(type) {
    if (!$scope.currentPage || !$scope.selectedMagazine) {
      showNotification('Najprv vyberte stranu.', 'warning');
      return;
    }

    const payload = {
      magazine: $scope.selectedMagazine.directory,
      year: $scope.selectedYear,
      pdfId: $scope.activePdfId || $scope.selectedYear,
      page: $scope.currentPage,
      type: type || 'normalize'
    };

    $scope.isBatchActionRunning = true;
    $http.post('/api/batch/task', payload)
      .then(function(res) {
        $scope.isBatchActionRunning = false;
        const typeLabel = (type === 'translate') ? 'Preklad (SK)' : 'Normalizácia (DE)';
        showNotification(`Strana ${$scope.currentPage} bola zaradená do dávky (${typeLabel}).`, 'success');
        $scope.loadBatchState();
      })
      .catch(function(err) {
        $scope.isBatchActionRunning = false;
        showNotification('Chyba pri zaradení do dávky: ' + (err.data?.error || err.statusText), 'danger');
      });
  };

  $scope.submitBatchFormTask = function() {
    if (!$scope.selectedMagazine || !$scope.selectedYear) {
      showNotification('Vyberte časopis a ročník.', 'warning');
      return;
    }

    const isRange = $scope.batchForm.mode === 'range';
    const fromP = parseInt(isRange ? $scope.batchForm.fromPage : $scope.currentPage, 10);
    const toP = isRange ? parseInt($scope.batchForm.toPage, 10) : fromP;

    if (isNaN(fromP) || (isRange && isNaN(toP))) {
      showNotification('Zadajte platné číslo strany.', 'warning');
      return;
    }

    const payload = {
      magazine: $scope.selectedMagazine.directory,
      year: $scope.selectedYear,
      pdfId: $scope.activePdfId || $scope.selectedYear,
      page: fromP,
      toPage: isRange ? toP : undefined,
      type: $scope.batchForm.type
    };

    $scope.isBatchActionRunning = true;
    $http.post('/api/batch/task', payload)
      .then(function(res) {
        $scope.isBatchActionRunning = false;
        const msg = isRange 
          ? `Rozsah strán ${fromP}–${toP} bol úspešne zaradený do dávky.`
          : `Strana ${fromP} bola zaradená do dávky.`;
        showNotification(msg, 'success');
        $scope.loadBatchState();
      })
      .catch(function(err) {
        $scope.isBatchActionRunning = false;
        showNotification('Chyba: ' + (err.data?.error || err.statusText), 'danger');
      });
  };

  $scope.removeBatchTask = function(taskId) {
    if (!confirm(`Naozaj chcete odstrániť úlohu ${taskId} z dávky?`)) return;

    $http.delete('/api/batch/task/' + encodeURIComponent(taskId))
      .then(function() {
        showNotification(`Úloha ${taskId} bola odstránená.`, 'info');
        $scope.loadBatchState();
      })
      .catch(function(err) {
        showNotification('Chyba pri odstraňovaní úlohy: ' + (err.data?.error || err.statusText), 'danger');
      });
  };

  $scope.runBatchAction = function(action) {
    $scope.isBatchActionRunning = true;
    $scope.batchActionMessage = null;

    $http.post('/api/batch/action', { action: action })
      .then(function(res) {
        $scope.isBatchActionRunning = false;
        const data = res.data;
        if (action === 'submit') {
          if (data.success) {
            $scope.batchActionMessage = { type: 'success', text: `Dávka úspešne odoslaná! (ID: ${data.batchId}, úloh: ${data.taskCount})` };
            showNotification('Dávka odoslaná do Google Cloud.', 'success');
          } else {
            $scope.batchActionMessage = { type: 'warning', text: data.message };
          }
        } else if (action === 'status') {
          if (!data.hasBatch) {
            $scope.batchActionMessage = { type: 'info', text: data.message };
          } else {
            const countInfo = data.stats ? ` (Spracovaných: ${data.stats.requestCount || 0}, čaká: ${data.stats.pendingRequestCount || 0})` : '';
            $scope.batchActionMessage = {
              type: data.isSuccess ? 'success' : (data.isFailed ? 'danger' : 'info'),
              text: `Stav dávky: ${data.state}${countInfo}`
            };
          }
        } else if (action === 'collect') {
          if (data.success) {
            $scope.batchActionMessage = {
              type: 'success',
              text: `Výsledky zapísané! Úspešne spracovaných: ${data.processedCount}/${data.total}.`
            };
            showNotification(`Zapísaných ${data.processedCount} strán z dávky!`, 'success');
            // Znovu načítať aktuálnu stranu, ak bola aktualizovaná
            if ($scope.currentPage) {
              $scope.loadPageText($scope.currentPage);
            }
          } else {
            $scope.batchActionMessage = { type: 'warning', text: data.message };
          }
        } else if (action === 'clear') {
          $scope.batchActionMessage = { type: 'info', text: `Vyčistených ${data.clearedCount} dokončených úloh.` };
          showNotification(`Vyčistených ${data.clearedCount} úloh.`, 'info');
        }
        $scope.loadBatchState();
      })
      .catch(function(err) {
        $scope.isBatchActionRunning = false;
        const errText = err.data?.error || err.statusText || 'Neznáma chyba';
        $scope.batchActionMessage = { type: 'danger', text: 'Chyba: ' + errText };
      });
  };

  // Inicializácia
  $scope.loadMagazines();
  $scope.loadBatchState();
}]);
