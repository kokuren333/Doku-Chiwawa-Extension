(() => {
  // v2.1.0
  // This script intentionally supersedes the old jp-offensiveness UI.
  // Old injected listeners from a previously loaded extension can survive
  // until the tab is refreshed, so the old tooltip class is also suppressed
  // in content.css.

  const INSTANCE = `cw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.__dokuEroChiwawaInstance = INSTANCE;

  let hoverEnabled = true;
  let selectionEnabled = true;
  let xFilterMode = 'off';

  chrome.storage.local.get(
    { hoverEnabled: true, selectionEnabled: true, xFilterMode: 'off' },
    (x) => {
      hoverEnabled = x.hoverEnabled;
      selectionEnabled = x.selectionEnabled;
      xFilterMode = normalizeFilterMode(x.xFilterMode);
      if (xFilterMode !== 'off') scheduleXFilterScan();
    }
  );

  chrome.storage.onChanged.addListener((x) => {
    if (x.hoverEnabled) hoverEnabled = x.hoverEnabled.newValue;
    if (x.selectionEnabled) selectionEnabled = x.selectionEnabled.newValue;
    if (x.xFilterMode) {
      xFilterMode = normalizeFilterMode(x.xFilterMode.newValue);
      if (xFilterMode === 'off') {
        clearXFilter();
      } else {
        lastFilterActivity = performance.now();
        startXFilterObserver();
        scheduleXFilterScan();
      }
    }
    if (x.accountAnalysisRequest?.newValue) resumeAccountAnalysis();
  });

  // Remove UI left by the previous extension implementation.
  document.querySelectorAll('.jp-off-tooltip,.jp-off-compose').forEach((el) => el.remove());

  let tip = null;
  let hoverTimer = null;
  let hoverArticle = null;
  let hoverSeq = 0;
  let compose = null;
  let selectionTimer = null;
  let selectionSeq = 0;
  let lastSelectionKey = '';
  const cache = new Map();
  let filterObserver = null;
  let filterScanTimer = null;
  let filterSerial = 0;
  let filterMeta = new WeakMap();
  let filterQueue = [];
  let filterActive = 0;
  let hoverPoint = null;
  const activeFilterMetas = new Set();
  let lastFilterActivity = performance.now();
  let accountAnalysisPanel = null;
  let accountAnalysisRun = 0;
  let accountAnalysisBusy = false;
  let accountAnalysisFilterBackup = 'off';
  let accountAnalysisImageBlob = null;
  const ACCOUNT_ANALYSIS_GITHUB_URL = 'https://github.com/kokuren333/Doku-Chiwawa-Extension/';

  const FILTER_CONCURRENCY = 2;
  const FILTER_TRIGGER_RATIO = 0.6;
  const FILTER_DISPLAY_DELAY = 180;
  const FILTER_IDLE_TIMEOUT = 6500;
  const FILTER_BATCH_LIMIT = 6;
  const FILTER_MAX_PENDING = 10;
  const FILTER_SCAN_DEBOUNCE = 80;
  const FILTER_STAMP_ASSETS = {
    plain: 'assets/stamp-chiwawa.webp',
    doku: 'assets/stamp-doku-chiwawa.webp',
    ero: 'assets/stamp-ero-chiwawa.webp',
    both: 'assets/stamp-doku-ero-chiwawa.webp',
  };

  const X_URL_RE = /^https?:\/\/(www\.)?(x\.com|twitter\.com)(?:\/|$)/;
  const FILTER_MODES = new Set(['off', 'plain', 'doku', 'ero', 'both']);

  function normalizeFilterMode(mode) {
    return FILTER_MODES.has(mode) ? mode : 'off';
  }

  function filterIsArmed() {
    return performance.now() - lastFilterActivity <= FILTER_IDLE_TIMEOUT;
  }

  function noteFilterActivity() {
    lastFilterActivity = performance.now();
    if (xFilterMode !== 'off') scheduleXFilterScan();
  }

  function shouldShowTweet(code, mode) {
    if (mode === 'plain') return code === 'plain';
    if (mode === 'doku') return code === 'doku' || code === 'both';
    if (mode === 'ero') return code === 'ero' || code === 'both';
    if (mode === 'both') return code === 'both';
    return true;
  }

  function alive() {
    return window.__dokuEroChiwawaInstance === INSTANCE;
  }

  function labelHTML(code) {
    if (code === 'both') {
      return '<span class="cw-doku">毒</span><span class="cw-ero">エロ</span><span class="cw-white">チワワ</span>';
    }
    if (code === 'doku') {
      return '<span class="cw-doku">毒</span><span class="cw-white">チワワ</span>';
    }
    if (code === 'ero') {
      return '<span class="cw-ero">エロ</span><span class="cw-white">チワワ</span>';
    }
    return '<span class="cw-white">チワワ</span>';
  }

  function removeTip() {
    tip?.remove();
    tip = null;
  }

  function normalizeRect(rect) {
    if (!rect) return null;
    const left = Number(rect.left);
    const top = Number(rect.top);
    const right = Number(rect.right);
    const bottom = Number(rect.bottom);
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function positionTip(el, sourceRect, pointer = null) {
    const rect = normalizeRect(sourceRect);
    if (!rect) return;

    const width = Math.min(230, Math.max(150, window.innerWidth - 16));
    const point = pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
      ? pointer
      : null;
    const left = point
      ? Math.max(8, Math.min(window.innerWidth - width - 8, point.x + 16))
      : Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));

    const above = point ? point.y - el.offsetHeight - 12 : rect.top - 44;
    const below = point ? point.y + 18 : rect.bottom + 8;
    const top = above >= 8 ? above : Math.min(window.innerHeight - el.offsetHeight - 8, below);

    el.style.left = `${window.scrollX + left}px`;
    el.style.top = `${window.scrollY + Math.max(8, top)}px`;
  }

  function showLoading(rect, pointer = null) {
    removeTip();
    const el = document.createElement('div');
    el.className = 'cw-tip';
    el.innerHTML = '<span class="cw-spinner"></span><span>判定中…</span>';
    document.documentElement.appendChild(el);
    positionTip(el, rect, pointer);
    tip = el;
    return el;
  }

  function showResult(rect, result, current = tip, pointer = null) {
    if (!current?.isConnected || !alive()) return;
    current.className = `cw-tip cw-${result.code}`;
    current.innerHTML = `<strong class="cw-label">${labelHTML(result.code)}</strong>`;
    positionTip(current, rect, pointer);
  }

  async function infer(text) {
    if (cache.has(text)) return cache.get(text);

    const r = await chrome.runtime.sendMessage({
      type: 'INFER',
      text,
    });

    if (!r?.ok) {
      throw new Error(r?.error || '推論に失敗しました');
    }

    cache.set(text, r.result);
    if (cache.size > 200) {
      cache.delete(cache.keys().next().value);
    }
    return r.result;
  }

  function selectionRect(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    try {
      const range = selection.getRangeAt(0);
      let rect = range.getBoundingClientRect();
      if ((!rect.width && !rect.height) && range.getClientRects().length) {
        rect = range.getClientRects()[0];
      }
      return normalizeRect(rect);
    } catch {
      return null;
    }
  }

  function isSelectionInsideExtension(selection) {
    const node = selection?.anchorNode;
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(el?.closest?.('.cw-compose,.cw-tip'));
  }

  function scheduleSelectionCheck(delay = 90) {
    if (!selectionEnabled || !alive()) return;

    clearTimeout(selectionTimer);
    const seq = ++selectionSeq;

    selectionTimer = setTimeout(async () => {
      if (!selectionEnabled || !alive() || seq !== selectionSeq) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      if (isSelectionInsideExtension(sel)) return;

      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (text.length < 2) return;

      const rect = selectionRect(sel);
      if (!rect || (!rect.width && !rect.height)) return;

      // Prevent repeated selectionchange/keyup events from spawning duplicates.
      const key = `${text}\n${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.right)}:${Math.round(rect.bottom)}`;
      if (key === lastSelectionKey && tip?.isConnected) return;
      lastSelectionKey = key;

      const el = showLoading(rect);

      try {
        const result = await infer(text);
        if (!alive() || seq !== selectionSeq) {
          el.remove();
          return;
        }
        showResult(rect, result, el);
      } catch {
        // Hover/selection UI is intentionally silent on inference failure:
        // no large error frame, no raw error text.
        el.remove();
        if (tip === el) tip = null;
      }
    }, delay);
  }

  // Mouse / pen selection.
  document.addEventListener(
    'pointerup',
    (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      // Let the browser finish updating Selection before reading it.
      scheduleSelectionCheck(80);
    },
    true
  );

  // Fallback for browsers/sites that do not deliver pointerup as expected.
  document.addEventListener(
    'mouseup',
    () => scheduleSelectionCheck(100),
    true
  );

  // Keyboard selection: Shift + arrows/Home/End etc.
  document.addEventListener(
    'keyup',
    (ev) => {
      if (ev.shiftKey || ['Shift', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) {
        scheduleSelectionCheck(120);
      }
    },
    true
  );

  // A final debounced fallback also covers selection created by browser UI.
  let selectionChangeTimer = null;
  document.addEventListener(
    'selectionchange',
    () => {
      clearTimeout(selectionChangeTimer);
      selectionChangeTimer = setTimeout(() => scheduleSelectionCheck(60), 160);
    },
    true
  );

  function tweetText(article) {
    const parts = [];
    const nodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
    for (const node of nodes) {
      const text = node.innerText?.replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
      if (parts.length) break;
    }

    const genericMediaLabels = new Set([
      '画像', '写真', 'イメージ', '動画', '映像', '画像1', '画像 1',
      'image', 'photo', 'video', 'media', 'gif', 'animated gif',
    ]);
    const mediaRoots = [
      ...article.querySelectorAll(
        '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.layoutLarge.media"]'
      ),
    ];

    for (const root of mediaRoots) {
      const candidates = [
        root.getAttribute('aria-label'),
        root.getAttribute('title'),
        root.querySelector('img[alt]')?.getAttribute('alt'),
      ];
      const description = candidates
        .map((value) => value?.replace(/\s+/g, ' ').trim())
        .find((value) => value && !genericMediaLabels.has(value.toLowerCase()));
      if (description) parts.push(`メディア説明: ${description}`);
    }

    // Some X layouts expose image alt text without tweetPhoto on the wrapper.
    if (!mediaRoots.length) {
      for (const image of article.querySelectorAll('img[alt]')) {
        if (image.closest('[data-testid="Tweet-User-Avatar"]')) continue;
        if (!image.src.includes('pbs.twimg.com/media')) continue;
        const alt = image.alt?.replace(/\s+/g, ' ').trim();
        if (alt && !genericMediaLabels.has(alt.toLowerCase())) {
          parts.push(`メディア説明: ${alt}`);
        }
      }
    }

    return parts.join('\n').trim();
  }

  function isXPage() {
    return X_URL_RE.test(location.href);
  }

  function isArticleReadyForFilter(article) {
    const rect = article.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.top <= window.innerHeight * FILTER_TRIGGER_RATIO &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function cleanupFilterEffect(meta) {
    if (!meta) return;
    clearTimeout(meta.shatterTimer);
    clearTimeout(meta.hideTimer);
    clearTimeout(meta.queueTimer);
    clearTimeout(meta.settleTimer);
    clearTimeout(meta.localizeTimer);
    meta.stamp?.remove();
    meta.crack?.remove();
    if (meta.stampHost && meta.hostPositionChanged && meta.stampHost.isConnected) {
      meta.stampHost.style.position = meta.hostInlinePosition;
    }
    meta.stamp = null;
    meta.crack = null;
    meta.stampHost = null;
    activeFilterMetas.delete(meta);
  }

  function isCurrentFilter(article, text, mode, serial) {
    const current = filterMeta.get(article);
    return Boolean(
      current?.text === text &&
      current.mode === mode &&
      current.serial === serial &&
      article.isConnected &&
      isXPage() &&
      xFilterMode === mode
    );
  }

  function effectRect(article) {
    const rect = article.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      width: Math.min(window.innerWidth, rect.width),
      height: Math.min(window.innerHeight, rect.height),
    };
  }

  function createFilterStamp(article, result) {
    const rect = effectRect(article);
    if (!rect) return null;

    const stamp = document.createElement('div');
    stamp.className = 'cw-filter-stamp';
    stamp.style.left = `${rect.left}px`;
    stamp.style.top = `${rect.top}px`;
    stamp.style.width = `${rect.width}px`;
    stamp.style.height = `${rect.height}px`;
    stamp.innerHTML = `<img class="cw-filter-stamp-image" src="${chrome.runtime.getURL(FILTER_STAMP_ASSETS[result.code])}" alt="${result.label}">`;
    (document.body || document.documentElement).appendChild(stamp);
    return stamp;
  }

  function createFilterCrack(article) {
    const rect = effectRect(article);
    if (!rect) return null;

    const crack = document.createElement('div');
    crack.className = 'cw-filter-crack';
    crack.style.left = `${rect.left}px`;
    crack.style.top = `${rect.top}px`;
    crack.style.width = `${rect.width}px`;
    crack.style.height = `${rect.height}px`;
    (document.body || document.documentElement).appendChild(crack);
    return crack;
  }

  function avatarRect(article) {
    const avatar = article.querySelector('[data-testid="Tweet-User-Avatar"]');
    if (!avatar) return null;
    const rect = avatar.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function settleStampOnAvatar(meta) {
    const stamp = meta?.stamp;
    const article = meta?.article;
    if (!stamp || !article?.isConnected) return false;

    const rect = avatarRect(article);
    if (!rect) return false;

    stamp.classList.add('cw-filter-stamp-settled');
    requestAnimationFrame(() => {
      if (!meta.stamp || !article.isConnected) return;
      const next = avatarRect(article);
      if (!next) return;
      stamp.style.left = `${next.left}px`;
      stamp.style.top = `${next.top}px`;
      stamp.style.width = `${next.width}px`;
      stamp.style.height = `${next.height}px`;
      meta.localizeTimer = setTimeout(() => attachStampToAvatar(meta), 450);
    });
    return true;
  }

  function attachStampToAvatar(meta) {
    const stamp = meta?.stamp;
    const article = meta?.article;
    const avatar = article?.querySelector('[data-testid="Tweet-User-Avatar"]');
    const host = avatar?.parentElement || avatar;
    if (!stamp || !avatar || !host || !article.isConnected) return;

    const avatarBox = avatar.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    if (!avatarBox.width || !avatarBox.height || !hostBox.width || !hostBox.height) return;

    meta.stampHost = host;
    if (getComputedStyle(host).position === 'static') {
      meta.hostInlinePosition = host.style.position;
      meta.hostPositionChanged = true;
      host.style.position = 'relative';
    }

    stamp.classList.add('cw-filter-stamp-following', 'cw-filter-stamp-local');
    stamp.style.position = 'absolute';
    stamp.style.left = `${avatarBox.left - hostBox.left}px`;
    stamp.style.top = `${avatarBox.top - hostBox.top}px`;
    stamp.style.width = `${avatarBox.width}px`;
    stamp.style.height = `${avatarBox.height}px`;
    host.appendChild(stamp);
  }

  function updateSettledStamps() {
    activeFilterMetas.forEach((meta) => {
      if (meta.state !== 'visible' || !meta.stamp || meta.stampHost) return;
      const rect = avatarRect(meta.article);
      if (!rect) return;
      meta.stamp.classList.add('cw-filter-stamp-following');
      meta.stamp.style.left = `${rect.left}px`;
      meta.stamp.style.top = `${rect.top}px`;
      meta.stamp.style.width = `${rect.width}px`;
      meta.stamp.style.height = `${rect.height}px`;
    });
  }

  function clearXFilter() {
    clearTimeout(filterScanTimer);
    filterScanTimer = null;
    filterQueue = [];
    activeFilterMetas.forEach((meta) => cleanupFilterEffect(meta));
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      cleanupFilterEffect(filterMeta.get(article));
    });
    filterMeta = new WeakMap();
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      article.classList.remove('cw-filter-vanish', 'cw-filter-shatter', 'cw-filter-hidden');
    });
    document.querySelectorAll('.cw-filter-stamp,.cw-filter-crack').forEach((el) => el.remove());
  }

  function applyFilterResult(article, text, mode, serial, result) {
    const current = filterMeta.get(article);
    if (!isCurrentFilter(article, text, mode, serial)) return;

    current.state = 'stamping';
    article.classList.remove('cw-filter-hidden', 'cw-filter-shatter');
    activeFilterMetas.add(current);
    current.stamp = createFilterStamp(article, result);

    if (shouldShowTweet(result.code, mode)) {
      current.settleTimer = setTimeout(() => {
        if (!isCurrentFilter(article, text, mode, serial)) {
          cleanupFilterEffect(current);
          return;
        }
        if (!settleStampOnAvatar(current)) {
          cleanupFilterEffect(current);
          return;
        }
        current.state = 'visible';
      }, 480);
      return;
    }

    // Hidden posts share the same front-layer stamp press, then disappear
    // without the heavier crack/shatter animation.
    current.hideTimer = setTimeout(() => {
      if (!isCurrentFilter(article, text, mode, serial)) {
        cleanupFilterEffect(current);
        return;
      }
      article.classList.add('cw-filter-hidden');
      cleanupFilterEffect(current);
      current.state = 'hidden';
    }, 480);
  }

  function pumpFilterQueue() {
    if (!filterIsArmed()) {
      filterQueue = [];
      return;
    }

    while (filterActive < FILTER_CONCURRENCY && filterQueue.length) {
      const task = filterQueue.shift();
      if (!isCurrentFilter(task.article, task.text, task.mode, task.serial)) continue;

      filterActive++;
      infer(task.text)
        .then((result) => applyFilterResult(task.article, task.text, task.mode, task.serial, result))
        .catch(() => {
          const current = filterMeta.get(task.article);
          if (current?.serial === task.serial) {
            current.state = 'visible';
            task.article.classList.remove('cw-filter-vanish', 'cw-filter-shatter', 'cw-filter-hidden');
          }
        })
        .finally(() => {
          filterActive--;
          pumpFilterQueue();
        });
    }
  }

  function scanXArticles() {
    filterScanTimer = null;
    if (!isXPage() || xFilterMode === 'off' || !alive() || !filterIsArmed()) return;

    let scheduled = 0;

    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      if (scheduled >= FILTER_BATCH_LIMIT) return;
      const text = tweetText(article);
      if (!text) return;
      if (!isArticleReadyForFilter(article)) return;
      if (filterQueue.length + filterActive >= FILTER_MAX_PENDING) return;

      const previous = filterMeta.get(article);
      if (
        previous?.text === text &&
        previous.mode === xFilterMode &&
        ['waiting', 'pending', 'stamping', 'visible', 'vanishing', 'hidden'].includes(previous.state)
      ) {
        return;
      }

      cleanupFilterEffect(previous);

      const mode = xFilterMode;
      const serial = ++filterSerial;
      const meta = { text, mode, serial, state: 'waiting', article };
      filterMeta.set(article, meta);
      article.classList.remove('cw-filter-vanish', 'cw-filter-hidden');
      scheduled++;

      meta.queueTimer = setTimeout(() => {
        if (!isCurrentFilter(article, text, mode, serial) || !filterIsArmed()) {
          meta.state = 'paused';
          return;
        }
        meta.state = 'pending';
        filterQueue.push({ article, text, mode, serial });
        pumpFilterQueue();
      }, FILTER_DISPLAY_DELAY);
    });
    pumpFilterQueue();
  }

  function scheduleXFilterScan(delay = FILTER_SCAN_DEBOUNCE) {
    if (!isXPage() || xFilterMode === 'off' || !alive() || !filterIsArmed()) return;
    clearTimeout(filterScanTimer);
    filterScanTimer = setTimeout(scanXArticles, delay);
  }

  function startXFilterObserver() {
    if (filterObserver || !document.documentElement) return;

    filterObserver = new MutationObserver((records) => {
      if (!isXPage() || xFilterMode === 'off') return;
      activeFilterMetas.forEach((meta) => {
        if (!meta.article?.isConnected) cleanupFilterEffect(meta);
      });
      const hasTweetMutation = records.some((record) => [
        ...record.addedNodes,
        ...record.removedNodes,
      ].some((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return true;
        return !node.matches('.cw-filter-stamp,.cw-filter-crack') &&
          !node.closest('.cw-filter-stamp,.cw-filter-crack');
      }));
      if (hasTweetMutation) {
        scheduleXFilterScan();
      }
    });
    filterObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  startXFilterObserver();
  document.addEventListener('scroll', () => {
    updateSettledStamps();
    scheduleXFilterScan(140);
  }, true);
  document.addEventListener('wheel', noteFilterActivity, { passive: true, capture: true });
  document.addEventListener('touchstart', noteFilterActivity, { passive: true, capture: true });
  document.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      noteFilterActivity();
    }
  }, true);
  window.addEventListener('resize', () => {
    updateSettledStamps();
    scheduleXFilterScan(140);
  }, { passive: true });

  document.addEventListener(
    'mouseover',
    (e) => {
      if (
        !hoverEnabled ||
        !alive() ||
        !isXPage()
      ) {
        return;
      }

      const article = e.target.closest?.('article[data-testid="tweet"]');
      if (!article || article === hoverArticle) return;

      clearTimeout(hoverTimer);
      hoverArticle = article;
      hoverPoint = { x: e.clientX, y: e.clientY };
      const seq = ++hoverSeq;

      hoverTimer = setTimeout(async () => {
        if (!alive()) return;

        const text = tweetText(article);
        if (!text) return;

        const rect = article.getBoundingClientRect();
        const el = showLoading(rect, hoverPoint);

        try {
          const result = await infer(text);
          if (seq !== hoverSeq || hoverArticle !== article || !alive()) {
            el.remove();
            return;
          }
          showResult(rect, result, el, hoverPoint);
        } catch {
          el.remove();
          if (tip === el) tip = null;
        }
      }, 300);
    },
    true
  );

  document.addEventListener(
    'mousemove',
    (e) => {
      if (!hoverEnabled || !hoverArticle || !isXPage()) return;
      const article = e.target.closest?.('article[data-testid="tweet"]');
      if (article !== hoverArticle) return;
      hoverPoint = { x: e.clientX, y: e.clientY };
      if (tip?.isConnected) {
        positionTip(tip, article.getBoundingClientRect(), hoverPoint);
      }
    },
    true
  );

  document.addEventListener(
    'mouseout',
    (e) => {
      const article = e.target.closest?.('article[data-testid="tweet"]');
      if (
        !article ||
        article !== hoverArticle ||
        article.contains(e.relatedTarget)
      ) {
        return;
      }

      clearTimeout(hoverTimer);
      setTimeout(() => {
        if (hoverArticle === article) {
          removeTip();
          hoverArticle = null;
          hoverPoint = null;
          hoverSeq++;
        }
      }, 120);
    },
    true
  );

  function ensureCompose() {
    if (compose?.isConnected) return compose;

    compose = document.createElement('section');
    compose.className = 'cw-compose';
    compose.innerHTML = `
      <div class="cw-compose-head">
        <strong>投稿前チェック</strong>
        <button class="cw-close" aria-label="閉じる">×</button>
      </div>
      <textarea maxlength="5000" placeholder="チェックする文章を入力"></textarea>
      <div class="cw-compose-status">入力すると自動判定</div>
      <div class="cw-compose-result" hidden>
        <div class="cw-compose-label"></div>
        <div class="cw-score-row"><span class="cw-doku">毒 raw</span><strong class="cw-doku-score">-</strong></div>
        <div class="cw-score-row"><span class="cw-ero">エロ raw</span><strong class="cw-ero-score">-</strong></div>
      </div>
      <div class="cw-compose-actions"><button class="cw-copy">コピー</button></div>`;

    document.documentElement.appendChild(compose);

    const ta = compose.querySelector('textarea');
    const status = compose.querySelector('.cw-compose-status');
    const result = compose.querySelector('.cw-compose-result');
    const label = compose.querySelector('.cw-compose-label');
    const dScore = compose.querySelector('.cw-doku-score');
    const eScore = compose.querySelector('.cw-ero-score');

    compose.querySelector('.cw-close').onclick = () => compose.remove();

    compose.querySelector('.cw-copy').onclick = async () => {
      if (!ta.value) return;
      try {
        await navigator.clipboard.writeText(ta.value);
        status.textContent = 'コピーしました';
      } catch {
        status.textContent = 'コピーできませんでした';
      }
    };

    let debounce;
    ta.addEventListener('input', () => {
      clearTimeout(debounce);

      const text = ta.value.trim();
      if (!text) {
        result.hidden = true;
        status.textContent = '入力すると自動判定';
        return;
      }

      status.textContent = '判定中…';

      debounce = setTimeout(async () => {
        try {
          const r = await infer(text);

          label.innerHTML = labelHTML(r.code);
          dScore.textContent = `${(r.doku_score * 100).toFixed(1)}%`;
          eScore.textContent = `${(r.ero_score * 100).toFixed(1)}%`;

          result.hidden = false;
          status.textContent = r.label;
        } catch (err) {
          status.textContent = `エラー: ${err.message}`;
        }
      }, 350);
    });

    const head = compose.querySelector('.cw-compose-head');
    let dragging = false;
    let dx = 0;
    let dy = 0;

    head.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('button')) return;
      const r = compose.getBoundingClientRect();
      dragging = true;
      dx = ev.clientX - r.left;
      dy = ev.clientY - r.top;
      head.setPointerCapture(ev.pointerId);
    });

    head.addEventListener('pointermove', (ev) => {
      if (!dragging) return;

      compose.style.left = `${Math.max(
        0,
        Math.min(window.innerWidth - compose.offsetWidth, ev.clientX - dx)
      )}px`;

      compose.style.top = `${Math.max(
        0,
        Math.min(window.innerHeight - compose.offsetHeight, ev.clientY - dy)
      )}px`;

      compose.style.right = 'auto';
      compose.style.bottom = 'auto';
    });

    head.addEventListener('pointerup', () => {
      dragging = false;
    });

    return compose;
  }

  function openCompose(text = '') {
    const box = ensureCompose();
    const ta = box.querySelector('textarea');

    if (text) {
      ta.value = text;
      ta.dispatchEvent(new Event('input'));
    }

    ta.focus();
  }

  function waitForAccountAnalysis(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function accountProfileHandle() {
    if (!isXPage()) return '';
    const part = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '').replace(/^@+/, '');
    return /^[A-Za-z0-9_]{1,15}$/.test(part) ? part : '';
  }

  function accountAnalysisUrlHandle() {
    if (!isXPage()) return '';
    const params = new URLSearchParams(location.search);
    if (params.get('cw_chiwawa_analysis') !== '1') return '';
    const handle = String(params.get('cw_handle') || '').replace(/^@+/, '');
    return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : '';
  }

  function clearAccountAnalysisUrlFlag() {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('cw_chiwawa_analysis');
      url.searchParams.delete('cw_handle');
      history.replaceState(history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // The storage request remains the fallback if X blocks history replacement.
    }
  }

  function accountStatusId(article) {
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      const match = link.getAttribute('href')?.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
    return '';
  }

  function accountAuthorHandle(article) {
    const link = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (!link) return '';
    return (link.getAttribute('href') || '').split('/').filter(Boolean)[0]?.replace(/^@+/, '') || '';
  }

  function accountAnalysisText(article) {
    return tweetText(article) || 'メディアのみの投稿';
  }

  function collectVisibleAccountTweets(handle, tweets) {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      if (article.parentElement?.closest('article[data-testid="tweet"]')) return;
      const author = accountAuthorHandle(article);
      if (author && author.toLowerCase() !== handle.toLowerCase()) return;
      const statusId = accountStatusId(article);
      const text = accountAnalysisText(article);
      if (!text) return;
      const key = statusId || `${author}:${text.slice(0, 180)}`;
      if (!tweets.has(key)) tweets.set(key, { key, statusId, text, author });
    });
  }

  function setAccountAnalysisStatus(text) {
    accountAnalysisPanel?.querySelector('.cw-account-analysis-progress')?.replaceChildren(document.createTextNode(text));
  }

  async function collectAccountTweets(handle, run) {
    const tweets = new Map();
    let stalled = 0;
    let lastCount = 0;
    window.scrollTo({ top: 0, behavior: 'auto' });
    await waitForAccountAnalysis(850);

    for (let round = 0; round < 90 && run === accountAnalysisRun && tweets.size < 100; round += 1) {
      collectVisibleAccountTweets(handle, tweets);
      setAccountAnalysisStatus(`投稿を収集中… ${Math.min(100, tweets.size)} / 100`);
      if (tweets.size >= 100) break;

      if (tweets.size === lastCount) stalled += 1;
      else stalled = 0;
      lastCount = tweets.size;
      if (stalled >= 12 && round >= 15) break;

      window.scrollBy({ top: Math.max(480, Math.floor(window.innerHeight * 0.82)), behavior: 'smooth' });
      await waitForAccountAnalysis(720 + (round % 3) * 160);
    }

    return [...tweets.values()].slice(0, 100);
  }

  function accountPercentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[index];
  }

  function accountAggregate(values) {
    const n = values.length;
    if (!n) return { n: 0, mean: 0, p90: 0, maximum: 0, highRate: 0, index: 0, histogram: Array(10).fill(0) };
    const mean = values.reduce((sum, value) => sum + value, 0) / n;
    const p90 = accountPercentile(values, 0.90);
    const highRate = values.filter((value) => value >= 0.70).length / n;
    const histogram = Array(10).fill(0);
    values.forEach((value) => histogram[Math.min(9, Math.floor(value * 10))] += 1);
    return {
      n,
      mean,
      p90,
      maximum: Math.max(...values),
      highRate,
      index: Math.min(1, 0.50 * mean + 0.25 * p90 + 0.25 * highRate),
      histogram,
    };
  }

  async function scoreAccountTweets(tweets, run) {
    const scored = [];
    let next = 0;
    let completed = 0;
    const worker = async () => {
      while (next < tweets.length && run === accountAnalysisRun) {
        const index = next++;
        const tweet = tweets[index];
        try {
          const result = await infer(tweet.text);
          scored[index] = { ...tweet, doku: Number(result.doku_score) || 0, ero: Number(result.ero_score) || 0 };
        } catch {
          scored[index] = null;
        }
        completed += 1;
        setAccountAnalysisStatus(`投稿を判定中… ${completed} / ${tweets.length}`);
      }
    };
    await Promise.all([worker(), worker()]);
    return scored.filter(Boolean);
  }

  function roundAnalysisRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function drawAnalysisHistogram(ctx, title, values, x, y, width, color) {
    const max = Math.max(1, ...values);
    ctx.fillStyle = '#cfd0da';
    ctx.font = '700 25px sans-serif';
    ctx.fillText(title, x, y);
    const baseY = y + 205;
    const barWidth = (width - 30) / 10;
    ctx.strokeStyle = '#454655';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, baseY + 1);
    ctx.lineTo(x + width, baseY + 1);
    ctx.stroke();
    values.forEach((count, index) => {
      const barHeight = count ? Math.max(5, (count / max) * 155) : 0;
      const barX = x + index * barWidth + 2;
      ctx.fillStyle = color;
      ctx.fillRect(barX, baseY - barHeight, Math.max(5, barWidth - 6), barHeight);
      ctx.fillStyle = '#a6a7b2';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText((index / 10).toFixed(1), barX + (barWidth - 6) / 2, baseY + 28);
      if (count) {
        ctx.fillStyle = '#fff';
        ctx.font = '700 16px sans-serif';
        ctx.fillText(String(count), barX + (barWidth - 6) / 2, baseY - barHeight - 8);
      }
    });
    ctx.textAlign = 'left';
  }

  async function makeAccountAnalysisImage(summary) {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 950;
    const ctx = canvas.getContext('2d');
    const background = ctx.createLinearGradient(0, 0, 1200, 950);
    background.addColorStop(0, '#171322');
    background.addColorStop(1, '#101117');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 44px sans-serif';
    ctx.fillText(`@${summary.handle}さんのチワワ指数`, 58, 76);
    ctx.fillStyle = '#a9a6b8';
    ctx.font = '22px sans-serif';
    ctx.fillText(`直近${summary.n}件 / 毒・エロの観測スコア`, 60, 114);

    const scoreY = 154;
    const scoreWidth = 510;
    const scoreBoxes = [
      { label: '毒指数', value: summary.doku.index, color: '#b56cff', x: 60 },
      { label: 'エロ指数', value: summary.ero.index, color: '#ff63b8', x: 630 },
    ];
    scoreBoxes.forEach((box) => {
      roundAnalysisRect(ctx, box.x, scoreY, scoreWidth, 142, 22);
      ctx.fillStyle = '#24212f';
      ctx.fill();
      ctx.fillStyle = box.color;
      ctx.font = '700 25px sans-serif';
      ctx.fillText(box.label, box.x + 28, scoreY + 42);
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 62px sans-serif';
      ctx.fillText(`${(box.value * 100).toFixed(1)}%`, box.x + 28, scoreY + 108);
    });

    drawAnalysisHistogram(ctx, '毒スコア分布', summary.doku.histogram, 60, 360, 510, '#9f62e7');
    drawAnalysisHistogram(ctx, 'エロスコア分布', summary.ero.histogram, 630, 360, 510, '#e85aab');

    ctx.fillStyle = '#b7b8c3';
    ctx.font = '20px sans-serif';
    ctx.fillText(`平均  毒 ${(summary.doku.mean * 100).toFixed(1)}% / エロ ${(summary.ero.mean * 100).toFixed(1)}%`, 60, 660);
    ctx.fillText(`p90  毒 ${(summary.doku.p90 * 100).toFixed(1)}% / エロ ${(summary.ero.p90 * 100).toFixed(1)}%`, 60, 696);
    ctx.fillText(`高スコア率(70%以上)  毒 ${(summary.doku.highRate * 100).toFixed(1)}% / エロ ${(summary.ero.highRate * 100).toFixed(1)}%`, 60, 732);
    ctx.fillStyle = '#7f8090';
    ctx.font = '17px sans-serif';
    ctx.fillText('※モデルが投稿文・メディア説明から算出した実験的な観測指標です。人格や危険性の判定ではありません。', 60, 810);
    ctx.fillText('毒エロチワワ · Doku / Ero dual binary', 60, 850);

    return {
      dataUrl: canvas.toDataURL('image/png'),
      blob: await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')),
    };
  }

  function analysisSummaryHTML(summary) {
    const score = (value) => `${(value * 100).toFixed(1)}%`;
    return `<div class="cw-account-analysis-summary"><div><span class="cw-analysis-doku">毒指数</span><strong>${score(summary.doku.index)}</strong></div><div><span class="cw-analysis-ero">エロ指数</span><strong>${score(summary.ero.index)}</strong></div></div><div class="cw-account-analysis-note">平均 / p90 / 高スコア率を、平均重視の集約式（50% / 25% / 25%）で合成</div>`;
  }

  function ensureAccountAnalysisPanel() {
    if (accountAnalysisPanel?.isConnected) return accountAnalysisPanel;
    accountAnalysisPanel = document.createElement('section');
    accountAnalysisPanel.className = 'cw-account-analysis';
    accountAnalysisPanel.innerHTML = `<div class="cw-account-analysis-head"><strong>アカウント分析</strong><button class="cw-account-analysis-close" aria-label="閉じる">×</button></div><div class="cw-account-analysis-progress">準備中…</div><div class="cw-account-analysis-result" hidden><div class="cw-account-analysis-summary-slot"></div><img class="cw-account-analysis-image" alt="アカウントのチワワ指数カード"><div class="cw-account-analysis-actions"><button class="cw-account-analysis-copy-image">画像をコピー</button><button class="cw-account-analysis-copy-text">文面をコピー</button></div></div>`;
    document.documentElement.appendChild(accountAnalysisPanel);
    accountAnalysisPanel.querySelector('.cw-account-analysis-close').onclick = () => {
      accountAnalysisRun += 1;
      accountAnalysisBusy = false;
      if (accountAnalysisFilterBackup !== 'off') {
        xFilterMode = accountAnalysisFilterBackup;
        accountAnalysisFilterBackup = 'off';
        lastFilterActivity = performance.now();
        startXFilterObserver();
        scheduleXFilterScan();
      }
      accountAnalysisPanel.remove();
      accountAnalysisPanel = null;
    };
    accountAnalysisPanel.querySelector('.cw-account-analysis-copy-image').onclick = () => copyAccountAnalysisImage();
    accountAnalysisPanel.querySelector('.cw-account-analysis-copy-text').onclick = () => copyAccountAnalysisText();
    return accountAnalysisPanel;
  }

  function accountAnalysisShareText(summary) {
    return `@${summary.handle}さんのチワワ指数\n毒 ${(summary.doku.index * 100).toFixed(1)}% / エロ ${(summary.ero.index * 100).toFixed(1)}%\n直近${summary.n}件を分析しました。\n\n${ACCOUNT_ANALYSIS_GITHUB_URL}`;
  }

  async function copyAccountAnalysisImage() {
    const summary = accountAnalysisPanel?.__cwSummary;
    if (!summary) return;
    if (!accountAnalysisImageBlob || !navigator.clipboard?.write || !window.ClipboardItem) {
      setAccountAnalysisStatus('画像をコピーできません。このブラウザではクリップボード画像に対応していません。');
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': accountAnalysisImageBlob })]);
      setAccountAnalysisStatus('カード画像をコピーしました。Xの投稿欄で貼り付けてください。');
    } catch {
      setAccountAnalysisStatus('画像をコピーできませんでした。ページのクリップボード権限を確認してください。');
    }
  }

  async function copyAccountAnalysisText() {
    const summary = accountAnalysisPanel?.__cwSummary;
    if (!summary) return;
    const text = accountAnalysisShareText(summary);
    try {
      await navigator.clipboard.writeText(text);
      setAccountAnalysisStatus('結果文面とGitHubリンクをコピーしました。Xの投稿欄で貼り付けてください。');
    } catch {
      setAccountAnalysisStatus('文面をコピーできませんでした。ページのクリップボード権限を確認してください。');
    }
  }

  async function startAccountAnalysis(handle) {
    if (!handle || !isXPage() || accountAnalysisBusy) return;
    accountAnalysisBusy = true;
    const run = ++accountAnalysisRun;
    const panel = ensureAccountAnalysisPanel();
    panel.hidden = false;
    panel.__cwSummary = null;
    panel.querySelector('.cw-account-analysis-result').hidden = true;
    setAccountAnalysisStatus(`@${handle} のページを準備中…`);
    clearAccountAnalysisUrlFlag();
    await chrome.storage.local.remove('accountAnalysisRequest');

    const previousFilterMode = xFilterMode;
    accountAnalysisFilterBackup = previousFilterMode;
    if (previousFilterMode !== 'off') {
      xFilterMode = 'off';
      clearXFilter();
    }

    try {
      const tweets = await collectAccountTweets(handle, run);
      if (run !== accountAnalysisRun) return;
      if (!tweets.length) throw new Error('投稿を取得できませんでした');
      const scored = await scoreAccountTweets(tweets, run);
      if (run !== accountAnalysisRun) return;
      if (!scored.length) throw new Error('投稿の判定に失敗しました');

      const summary = { handle, n: scored.length, doku: accountAggregate(scored.map((tweet) => tweet.doku)), ero: accountAggregate(scored.map((tweet) => tweet.ero)) };
      const image = await makeAccountAnalysisImage(summary);
      accountAnalysisImageBlob = image.blob;
      panel.__cwSummary = summary;
      panel.querySelector('.cw-account-analysis-summary-slot').innerHTML = analysisSummaryHTML(summary);
      panel.querySelector('.cw-account-analysis-image').src = image.dataUrl;
      panel.querySelector('.cw-account-analysis-result').hidden = false;
      setAccountAnalysisStatus(`分析完了：${scored.length}件（取得 ${tweets.length}件）`);
    } catch (error) {
      if (run === accountAnalysisRun) setAccountAnalysisStatus(`分析できませんでした：${error?.message || '不明なエラー'}`);
    } finally {
      if (run === accountAnalysisRun && previousFilterMode !== 'off') {
        xFilterMode = previousFilterMode;
        accountAnalysisFilterBackup = 'off';
        lastFilterActivity = performance.now();
        startXFilterObserver();
        scheduleXFilterScan();
      }
      if (run === accountAnalysisRun) accountAnalysisBusy = false;
    }
  }

  async function resumeAccountAnalysis() {
    if (!isXPage() || accountAnalysisBusy) return;
    const urlHandle = accountAnalysisUrlHandle();
    if (urlHandle && accountProfileHandle().toLowerCase() === urlHandle.toLowerCase()) {
      startAccountAnalysis(urlHandle);
      return;
    }
    const stored = await chrome.storage.local.get({ accountAnalysisRequest: null });
    const request = stored.accountAnalysisRequest;
    if (!request?.handle || !request.createdAt || Date.now() - request.createdAt > 10 * 60 * 1000) return;
    if (accountProfileHandle().toLowerCase() !== String(request.handle).toLowerCase()) return;
    startAccountAnalysis(String(request.handle));
  }

  setTimeout(resumeAccountAnalysis, 700);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'OPEN_COMPOSE') {
      openCompose(msg.text || '');
    }
  });
})();
