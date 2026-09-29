const app = angular.module('viewerApp', []);

app.controller('MainCtrl', ['$scope', '$http', '$timeout', function($scope, $http, $timeout) {
  $scope.magazines = [];
  $scope.selectedMagazine = null;
  $scope.availableYears = [];
  $scope.selectedYear = null;

  $scope.articlesData = { title: '', volumes: [] };
  $scope.currentArticles = [];
  $scope.selectedArticleIndex = -1;
  $scope.editedArticle = null;
  $scope.isDirty = false;

  $scope.thumbnails = [];
  $scope.selectedThumbPage = null;
  $scope.jumpPageNumber = null;
  $scope.thumbSize = 'm'; // 's', 'm', 'l'
  $scope.activePdfId = null;
  $scope.publishedPdfs = [];

  $scope.setThumbSize = function(size) {
    $scope.thumbSize = size;
  };

  $scope.pageTextData = {
    page: null,
    text: '',
    loading: false,
    hasTextFile: true
  };

  $scope.notification = null;
  $scope.searchQuery = '';
  $scope.isAiTranslating = false;

  let pageTextModalInstance = null;

  function showNotification(message, type = 'success') {
    $scope.notification = { message, type };
    $timeout(() => {
      if ($scope.notification && $scope.notification.message === message) {
        $scope.notification = null;
      }
    }, 4000);
  }

  // Pomocná funkcia: Lokálne vyčistenie textu nadpisu (de-hyphenation, OCR artefakty, medzery)
  function cleanTitleText(text) {
    if (!text || typeof text !== 'string') return '';

    const CYRILLIC_TO_LATIN = {
      'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
      'І': 'I', 'і': 'i', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'н': 'h'
    };

    let res = text.trim();
    // 1. Nahradenie cyrilických znakov z OCR
    res = res.replace(/[\u0400-\u04FF]/g, ch => CYRILLIC_TO_LATIN[ch] || ch);

    // 2. Normalizácia spojovníkov a medzier
    const conjunctions = new Set(['und', 'oder', 'sowie', 'és', 'vagy', 'and', 'or']);

    // Spojenie slov rozdelených na konci riadku: "AUS- GEFÜHRTE" -> "AUSGEFÜHRTE", "SPECIAL- AUFNAHME" -> "SPECIALAUFNAHME"
    res = res.replace(/(\b[\p{L}\d]+)-\s+([\p{L}\d]+)\b/gu, (match, p1, p2) => {
      if (conjunctions.has(p2.toLowerCase())) {
        return `${p1}- ${p2}`;
      }
      return `${p1}${p2}`;
    });

    // Medzery okolo spojovníka (napr. "Ó - SZÖNY" -> "Ó-SZÖNY", "KRASSÓ - SZÖRÉNY" -> "KRASSÓ-SZÖRÉNY")
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

  // Pomocná funkcia: Zotriedenie článkov podľa strany vzostupne (sekundárne podľa pdf_page)
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

  // Pomocná funkcia: Normalizácia mena autora (Title Case, tituly, šľachtické častice, OCR opravy)
  function normalizeAuthorName(name) {
    if (!name || typeof name !== 'string') return '';

    const LOWERCASE_PARTICLES = new Set([
      'v.', 'von', 'de', 'del', 'della', 'di', 'du', 'van', 'der', 'den', 'ter', 'und', 'et', 'and'
    ]);

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

    const CYRILLIC_TO_LATIN = {
      'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
      'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'н': 'h'
    };

    let cleanName = name.trim().replace(/\s+/g, ' ');
    if (!cleanName) return '';

    // Nahradenie cyrilických znakov z OCR
    cleanName = cleanName.replace(/[\u0400-\u04FF]/g, ch => CYRILLIC_TO_LATIN[ch] || ch);

    const words = cleanName.split(' ');

    const normalizedWords = words.map((word, index) => {
      const lowerWord = word.toLowerCase();

      // 1. Tituly
      if (SPECIAL_TITLES[lowerWord]) {
        return SPECIAL_TITLES[lowerWord];
      }

      // 2. Častice (okrem prvého slova)
      if (index > 0 && LOWERCASE_PARTICLES.has(lowerWord)) {
        return lowerWord;
      }

      // 3. Spojovníky
      if (word.includes('-')) {
        return word.split('-').map(part => {
          if (!part) return '';
          const lowerPart = part.toLowerCase();
          if (LOWERCASE_PARTICLES.has(lowerPart)) return lowerPart;
          return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }).join('-');
      }

      // 4. Iniciály s bodkou
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

  // 1. Load magazines
  $scope.loadMagazines = function() {
    $http.get('/api/magazines')
      .then(function(res) {
        $scope.magazines = res.data;
        if ($scope.magazines.length > 0) {
          $scope.selectedMagazine = $scope.magazines[0];
          $scope.onMagazineChange();
        }
      })
      .catch(function(err) {
        showNotification('Chyba pri načítavaní časopisov: ' + (err.data?.error || err.statusText), 'danger');
      });
  };

  // 2. When magazine selection changes
  $scope.onMagazineChange = function() {
    if (!$scope.selectedMagazine) return;
    $scope.publishedPdfs = $scope.selectedMagazine.published || [];
    $scope.loadArticles();
  };

  // 3. Load articles for selected magazine (volumes are taken from articles.json!)
  $scope.loadArticles = function() {
    if (!$scope.selectedMagazine) return;

    $scope.publishedPdfs = $scope.selectedMagazine.published || [];

    $http.get('/api/magazines/' + $scope.selectedMagazine.directory + '/articles')
      .then(function(res) {
        $scope.articlesData = res.data || { title: $scope.selectedMagazine.title, volumes: [] };
        if (!$scope.articlesData.volumes) {
          $scope.articlesData.volumes = [];
        }

        // Zotriedenie článkov v každom ročníku podľa strany
        $scope.articlesData.volumes.forEach(vol => {
          if (Array.isArray(vol.articles)) {
            sortArticlesByPage(vol.articles);
          }
        });

        // Zoznam ročníkov berieme PRIAMO z articles.json!
        $scope.availableYears = $scope.articlesData.volumes.map(v => v.year);

        if ($scope.availableYears.includes(Number($scope.selectedYear))) {
          // ponecháme aktuálny ročník
        } else if ($scope.availableYears.length > 0) {
          $scope.selectedYear = $scope.availableYears[0];
        } else {
          $scope.selectedYear = null;
        }

        $scope.syncCurrentVolumeArticles();
      })
      .catch(function(err) {
        showNotification('Chyba pri načítavaní článkov: ' + (err.data?.error || err.statusText), 'danger');
      });
  };

  // 4. When year selection changes
  $scope.onYearChange = function() {
    $scope.syncCurrentVolumeArticles();
  };

  $scope.showNewVolumeInput = false;
  $scope.newVolumeYear = null;

  // Prepnutie zobrazenia inline poľa pre nový ročník
  $scope.toggleNewVolumeInput = function() {
    $scope.showNewVolumeInput = !$scope.showNewVolumeInput;
    if ($scope.showNewVolumeInput) {
      const maxYear = $scope.availableYears && $scope.availableYears.length > 0 
        ? Math.max(...$scope.availableYears) 
        : 1882;
      $scope.newVolumeYear = maxYear + 1;
      $timeout(() => {
        const inp = document.getElementById('inputNewVolume');
        if (inp) inp.focus();
      }, 50);
    }
  };

  // Potvrdenie pridania nového ročníka do articles.json
  $scope.confirmAddVolume = function() {
    if (!$scope.newVolumeYear) {
      showNotification('Zadajte rok nového ročníka.', 'warning');
      return;
    }
    const yearNum = parseInt(String($scope.newVolumeYear).trim(), 10);
    if (isNaN(yearNum) || yearNum <= 0) {
      showNotification('Neplatný rok.', 'danger');
      return;
    }

    if ($scope.availableYears.includes(yearNum)) {
      $scope.selectedYear = yearNum;
      $scope.syncCurrentVolumeArticles();
      $scope.showNewVolumeInput = false;
      showNotification(`Ročník ${yearNum} už existuje a bol vybraný.`, 'info');
      return;
    }

    $scope.articlesData.volumes.push({ year: yearNum, articles: [] });
    $scope.articlesData.volumes.sort((a, b) => a.year - b.year);
    $scope.availableYears = $scope.articlesData.volumes.map(v => v.year);
    $scope.selectedYear = yearNum;
    $scope.syncCurrentVolumeArticles();
    $scope.isDirty = true;
    $scope.showNewVolumeInput = false;
    $scope.newVolumeYear = null;
    showNotification(`Ročník ${yearNum} bol pridaný do articles.json. Nezabudnite uložiť zmeny.`, 'success');
  };

  // Alias pre spätnú kompatibilitu
  $scope.addVolume = $scope.toggleNewVolumeInput;

  // Sync articles for current volume
  $scope.syncCurrentVolumeArticles = function() {
    if (!$scope.selectedYear) {
      $scope.currentArticles = [];
      $scope.selectedArticleIndex = -1;
      $scope.editedArticle = null;
      $scope.thumbnails = [];
      return;
    }

    let volume = $scope.articlesData.volumes.find(v => Number(v.year) === Number($scope.selectedYear));
    if (!volume) {
      volume = { year: Number($scope.selectedYear), articles: [] };
      $scope.articlesData.volumes.push(volume);
    }

    if (Array.isArray(volume.articles)) {
      sortArticlesByPage(volume.articles);
    }

    $scope.currentArticles = volume.articles || [];

    // Určenie aktívneho PDF ID
    const artWithPdf = $scope.currentArticles.find(a => a.pdf_id);
    if (artWithPdf) {
      $scope.activePdfId = artWithPdf.pdf_id;
    } else if ($scope.publishedPdfs.length > 0) {
      $scope.activePdfId = $scope.publishedPdfs[0].id;
    } else {
      $scope.activePdfId = null;
    }

    $scope.loadThumbnails();

    if ($scope.currentArticles.length > 0) {
      $scope.selectArticle(0);
    } else {
      $scope.selectedArticleIndex = -1;
      $scope.editedArticle = null;
      $scope.isDirty = false;
    }
  };

  // 5. Select an article to edit
  $scope.selectArticle = function(index) {
    if (index < 0 || index >= $scope.currentArticles.length) {
      $scope.selectedArticleIndex = -1;
      $scope.editedArticle = null;
      $scope.isDirty = false;
      return;
    }

    $scope.selectedArticleIndex = index;
    $scope.editedArticle = angular.copy($scope.currentArticles[index]);
    $scope.isDirty = false;

    // Ak článok odkazuje na iné PDF, prepneme aktívne PDF pre miniatúry
    if ($scope.editedArticle.pdf_id && $scope.editedArticle.pdf_id !== $scope.activePdfId) {
      $scope.activePdfId = $scope.editedArticle.pdf_id;
      $scope.loadThumbnails();
    }

    // If article has pdf_page, highlight in thumbnails
    if ($scope.editedArticle.pdf_page) {
      $scope.selectedThumbPage = $scope.editedArticle.pdf_page;
      $scope.scrollToThumbnail($scope.editedArticle.pdf_page);
    }
  };

  // Mark form as dirty when inputs change
  $scope.onFieldChange = function() {
    $scope.isDirty = true;
  };

  // Normalizácia mena pre aktuálne editovaný článok
  $scope.normalizeCurrentAuthor = function() {
    if ($scope.editedArticle && $scope.editedArticle.author) {
      const original = $scope.editedArticle.author;
      const normalized = normalizeAuthorName(original);
      if (original !== normalized) {
        $scope.editedArticle.author = normalized;
        $scope.isDirty = true;
        showNotification(`Meno autora bolo znormalizované: „${normalized}“`, 'success');
      } else {
        showNotification('Meno autora je už v normalizovanom tvare.', 'info');
      }
    }
  };

  // 1. Lokálne vyčistenie textov názvov (de-hyphenation, OCR artefakty, medzery)
  $scope.cleanCurrentTitles = function() {
    if (!$scope.editedArticle) return;
    let changed = false;
    ['title_de', 'title_hu', 'title_sk', 'title_en'].forEach(field => {
      if ($scope.editedArticle[field]) {
        const cleaned = cleanTitleText($scope.editedArticle[field]);
        if (cleaned !== $scope.editedArticle[field]) {
          $scope.editedArticle[field] = cleaned;
          changed = true;
        }
      }
    });

    if (changed) {
      $scope.isDirty = true;
      showNotification('Texty názvov boli vyčistené (odstránené rozdelenia slov a OCR artefakty).', 'success');
    } else {
      showNotification('Názvy sú už vyčistené.', 'info');
    }
  };

  // 2. AI Normalizácia gramatiky a preklad cez Gemini (19. stor. geológia, baníctvo, paleobotanika)
  $scope.aiNormalizeAndTranslate = function() {
    if (!$scope.editedArticle) return;

    // Zdrojový názov (nemecký alebo maďarský)
    const sourceTitle = $scope.editedArticle.title_de || $scope.editedArticle.title_hu || $scope.editedArticle.title_sk || $scope.editedArticle.title_en;
    if (!sourceTitle) {
      showNotification('Vyplňte aspoň jeden názov článku pred spustením AI prekladu.', 'warning');
      return;
    }

    $scope.isAiTranslating = true;

    $http.post('/api/ai/translate-title', {
      title: sourceTitle,
      author: $scope.editedArticle.author || '',
      year: $scope.selectedYear || '',
      language: $scope.editedArticle.language || 'de'
    })
    .then(function(res) {
      $scope.isAiTranslating = false;
      const data = res.data?.data;
      if (data) {
        if (data.title_de) $scope.editedArticle.title_de = data.title_de;
        if (data.title_hu) $scope.editedArticle.title_hu = data.title_hu;
        if (data.title_sk) $scope.editedArticle.title_sk = data.title_sk;
        if (data.title_en) $scope.editedArticle.title_en = data.title_en;
        $scope.isDirty = true;
        showNotification('Názvy boli úspešne znormalizované a preložené cez Gemini AI!', 'success');
      }
    })
    .catch(function(err) {
      $scope.isAiTranslating = false;
      const msg = err.data?.details || err.data?.error || err.statusText;
      showNotification('Chyba pri AI preklade: ' + msg, 'danger');
    });
  };

  // 6. Create new article
  $scope.newArticle = function() {
    const newArt = {
      author: '',
      title_de: null,
      title_hu: null,
      title_sk: null,
      title_en: null,
      language: $scope.selectedMagazine.directory === 'jahresbericht' ? 'de' : 'hu',
      page: 1,
      pdf_id: $scope.activePdfId || '',
      pdf_page: 1
    };

    $scope.currentArticles.push(newArt);
    $scope.selectArticle($scope.currentArticles.length - 1);
    $scope.isDirty = true;
    showNotification('Nový článok bol vytvorený. Nezabudnite uložiť zmeny.', 'info');
  };

  // 7. Delete article
  $scope.deleteArticle = function(index) {
    if (!confirm('Naozaj chcete odstrániť tento článok?')) return;

    $scope.currentArticles.splice(index, 1);
    $scope.isDirty = true;

    if ($scope.currentArticles.length > 0) {
      const nextIndex = Math.min(index, $scope.currentArticles.length - 1);
      $scope.selectArticle(nextIndex);
    } else {
      $scope.selectedArticleIndex = -1;
      $scope.editedArticle = null;
    }

    showNotification('Článok bol odstránený zo zoznamu. Kliknite na Uložiť pre potvrdenie.', 'warning');
  };

  // 8. Reset edited article
  $scope.resetArticle = function() {
    if ($scope.selectedArticleIndex >= 0) {
      $scope.editedArticle = angular.copy($scope.currentArticles[$scope.selectedArticleIndex]);
      $scope.isDirty = false;
      showNotification('Zmeny boli vrátené späť.', 'info');
    }
  };

  // 9. Save all articles to articles.json
  $scope.saveArticles = function() {
    if ($scope.selectedArticleIndex >= 0 && $scope.editedArticle) {
      $scope.currentArticles[$scope.selectedArticleIndex] = angular.copy($scope.editedArticle);
    }

    // Zotriedenie článkov podľa strany
    sortArticlesByPage($scope.currentArticles);
    if ($scope.articlesData && Array.isArray($scope.articlesData.volumes)) {
      $scope.articlesData.volumes.forEach(vol => {
        if (Array.isArray(vol.articles)) {
          sortArticlesByPage(vol.articles);
        }
      });
    }

    // Aktualizácia indexu pre práve editovaný článok
    if ($scope.editedArticle) {
      const newIdx = $scope.currentArticles.findIndex(a => 
        (a.page === $scope.editedArticle.page && a.pdf_page === $scope.editedArticle.pdf_page && a.title_de === $scope.editedArticle.title_de)
      );
      if (newIdx !== -1) {
        $scope.selectedArticleIndex = newIdx;
      }
    }

    const payload = angular.copy($scope.articlesData);

    $http.put('/api/magazines/' + $scope.selectedMagazine.directory + '/articles', payload)
      .then(function(res) {
        $scope.isDirty = false;
        showNotification('Články boli úspešne uložené do articles.json!', 'success');
      })
      .catch(function(err) {
        showNotification('Chyba pri ukladaní článkov: ' + (err.data?.error || err.statusText), 'danger');
      });
  };

  // 10. Load thumbnails for active PDF ID
  $scope.loadThumbnails = function() {
    if (!$scope.selectedMagazine || !$scope.activePdfId) {
      $scope.thumbnails = [];
      return;
    }

    $http.get('/api/magazines/' + $scope.selectedMagazine.directory + '/' + $scope.activePdfId + '/thumbnails')
      .then(function(res) {
        $scope.thumbnails = res.data.pages || [];
      })
      .catch(function(err) {
        $scope.thumbnails = [];
      });
  };

  // Keď používateľ manuálne zmení aktívne PDF v hlavičke miniatúr
  $scope.onPdfChange = function() {
    $scope.loadThumbnails();
  };

  // 11. Open page text modal
  $scope.openPageText = function(pageNum) {
    $scope.selectedThumbPage = pageNum;
    $scope.pageTextData = {
      page: pageNum,
      text: '',
      loading: true,
      hasTextFile: true
    };

    if (!pageTextModalInstance) {
      const modalEl = document.getElementById('pageTextModal');
      pageTextModalInstance = new bootstrap.Modal(modalEl);
    }
    pageTextModalInstance.show();

    $http.get('/api/magazines/' + $scope.selectedMagazine.directory + '/' + $scope.activePdfId + '/pages/' + pageNum + '/text')
      .then(function(res) {
        $scope.pageTextData.loading = false;
        $scope.pageTextData.text = res.data.text || '(Na tejto strane nebol nájdený žiadny extrahovaný text)';
        $scope.pageTextData.hasTextFile = res.data.hasTextFile;
      })
      .catch(function(err) {
        $scope.pageTextData.loading = false;
        $scope.pageTextData.text = 'Chyba pri načítavaní textu: ' + (err.data?.error || err.statusText);
      });
  };

  // 12. Jump to previous / next page in modal
  $scope.changeModalPage = function(delta) {
    const newPage = $scope.pageTextData.page + delta;
    if (newPage >= 1 && ($scope.thumbnails.length === 0 || newPage <= $scope.thumbnails[$scope.thumbnails.length - 1])) {
      $scope.openPageText(newPage);
    }
  };

  // 13. Set thumbnail page as PDF page in article editor
  $scope.setAsPdfPage = function(pageNum) {
    if ($scope.editedArticle) {
      $scope.editedArticle.pdf_page = pageNum;
      $scope.editedArticle.pdf_id = $scope.activePdfId;
      $scope.isDirty = true;
      showNotification(`Strana v PDF bola nastavená na ${pageNum} (PDF: ${$scope.activePdfId}).`, 'info');
    }
  };

  // 14. Scroll thumbnail strip / grid to page
  $scope.scrollToThumbnail = function(pageNum) {
    $timeout(() => {
      const el = document.getElementById('thumb-page-' + pageNum);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }
    }, 100);
  };

  $scope.jumpToPage = function() {
    if ($scope.jumpPageNumber && $scope.jumpPageNumber > 0) {
      $scope.selectedThumbPage = $scope.jumpPageNumber;
      $scope.scrollToThumbnail($scope.jumpPageNumber);
    }
  };

  // Helper: Copy text to clipboard
  $scope.copyToClipboard = function(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      showNotification('Text bol skopírovaný do schránky.', 'success');
    });
  };

  // Initialize
  $scope.loadMagazines();
}]);
