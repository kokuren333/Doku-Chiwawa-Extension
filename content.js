(() => {
  // v1.0.1
  // This script intentionally supersedes the old jp-offensiveness UI.
  // Old injected listeners from a previously loaded extension can survive
  // until the tab is refreshed, so the old tooltip class is also suppressed
  // in content.css.

  const INSTANCE = `cw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.__dokuEroChiwawaInstance = INSTANCE;

  let hoverEnabled = true;
  let selectionEnabled = true;

  chrome.storage.local.get(
    { hoverEnabled: true, selectionEnabled: true },
    (x) => {
      hoverEnabled = x.hoverEnabled;
      selectionEnabled = x.selectionEnabled;
    }
  );

  chrome.storage.onChanged.addListener((x) => {
    if (x.hoverEnabled) hoverEnabled = x.hoverEnabled.newValue;
    if (x.selectionEnabled) selectionEnabled = x.selectionEnabled.newValue;
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

  function positionTip(el, sourceRect) {
    const rect = normalizeRect(sourceRect);
    if (!rect) return;

    const width = Math.min(230, Math.max(150, window.innerWidth - 16));
    const left = Math.max(
      8,
      Math.min(window.innerWidth - width - 8, rect.left)
    );

    const above = rect.top - 44;
    const below = rect.bottom + 8;
    const top = above >= 8 ? above : Math.min(window.innerHeight - 44, below);

    el.style.left = `${window.scrollX + left}px`;
    el.style.top = `${window.scrollY + Math.max(8, top)}px`;
  }

  function showLoading(rect) {
    removeTip();
    const el = document.createElement('div');
    el.className = 'cw-tip';
    el.innerHTML = '<span class="cw-spinner"></span><span>判定中…</span>';
    document.documentElement.appendChild(el);
    positionTip(el, rect);
    tip = el;
    return el;
  }

  function showResult(rect, result, current = tip) {
    if (!current?.isConnected || !alive()) return;
    current.className = `cw-tip cw-${result.code}`;
    current.innerHTML = `<strong class="cw-label">${labelHTML(result.code)}</strong>`;
    positionTip(current, rect);
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

  document.addEventListener(
    'mouseover',
    (e) => {
      if (
        !hoverEnabled ||
        !alive() ||
        !/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//.test(location.href)
      ) {
        return;
      }

      const article = e.target.closest?.('article[data-testid="tweet"]');
      if (!article || article === hoverArticle) return;

      clearTimeout(hoverTimer);
      hoverArticle = article;
      const seq = ++hoverSeq;

      hoverTimer = setTimeout(async () => {
        if (!alive()) return;

        const text = tweetText(article);
        if (!text) return;

        const rect = article.getBoundingClientRect();
        const el = showLoading(rect);

        try {
          const result = await infer(text);
          if (seq !== hoverSeq || hoverArticle !== article || !alive()) {
            el.remove();
            return;
          }
          showResult(rect, result, el);
        } catch {
          el.remove();
          if (tip === el) tip = null;
        }
      }, 300);
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
