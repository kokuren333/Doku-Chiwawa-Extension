(() => {
  // v1.2.0
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

  const FILTER_CONCURRENCY = 2;
  const FILTER_TRIGGER_RATIO = 0.6;
  const FILTER_DISPLAY_DELAY = 700;
  const FILTER_IDLE_TIMEOUT = 6500;
  const FILTER_BATCH_LIMIT = 6;
  const FILTER_MAX_PENDING = 10;
  const FILTER_SCAN_DEBOUNCE = 180;
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
    const nodes = [...article.querySelectorAll('[data-testid="tweetText"]')];
    for (const node of nodes) {
      const text = node.innerText?.trim();
      if (text) return text;
    }
    return '';
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
    meta.stamp?.remove();
    meta.crack?.remove();
    meta.stamp = null;
    meta.crack = null;
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
    document.documentElement.appendChild(stamp);
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
    document.documentElement.appendChild(crack);
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
    });
    return true;
  }

  function updateSettledStamps() {
    activeFilterMetas.forEach((meta) => {
      if (meta.state !== 'visible' || !meta.stamp) return;
      const rect = avatarRect(meta.article);
      if (!rect) return;
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

    current.state = 'vanishing';

    current.shatterTimer = setTimeout(() => {
      if (!isCurrentFilter(article, text, mode, serial)) {
        cleanupFilterEffect(current);
        return;
      }
      current.crack = createFilterCrack(article);
      article.classList.add('cw-filter-shatter');
    }, 480);

    current.hideTimer = setTimeout(() => {
      if (!isCurrentFilter(article, text, mode, serial)) {
        cleanupFilterEffect(current);
        return;
      }
      article.classList.remove('cw-filter-shatter');
      article.classList.add('cw-filter-hidden');
      cleanupFilterEffect(current);
      current.state = 'hidden';
    }, 940);
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'OPEN_COMPOSE') {
      openCompose(msg.text || '');
    }
  });
})();
