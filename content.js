// QuickPeek content script: overlay preview without a new tab

(function () {
  const STATE = {
    visible: false,
    url: "",
    dragging: false,
    resizing: false,
    openedByDrag: false,
    offsetX: 0,
    offsetY: 0,
    startW: 0,
    startH: 0,
    startClientX: 0,
    startClientY: 0,
    hoverEnabled: true,
    dragPreviewEnabled: true,
    dragPreviewThreshold: 16, // px movement before triggering preview on drag
    dragPreviewFired: false,
    dragCandidateAnchor: null,
    mouseDown: false,
    dragActive: false,
    lastDragStartX: 0,
    lastDragStartY: 0,
    lastDownX: 0,
    lastDownY: 0,
    lastDownTarget: null,
  };

  // No options page: use built-in defaults (hoverEnabled=true, centered)

  const container = document.createElement('div');
  container.className = 'qp-container';
  container.setAttribute('id', 'quickpeek-container');

  // Debug logging helper
  const QP_DEBUG = true; // set to false to silence logs
  const dbg = (...args) => { if (QP_DEBUG) try { console.log('[QuickPeek]', ...args); } catch {} };

  const header = document.createElement('div');
  header.className = 'qp-header';
  header.title = '拖拽移动面板';

  const title = document.createElement('div');
  title.className = 'qp-title';
  title.textContent = 'QuickPeek';

  const btnReload = button('刷新');
  const btnOpenTab = button('新标签打开');
  const btnPop = button('放大');
  const btnSettings = button('设置');
  const btnClose = button('关闭');

  header.append(title, btnReload, btnOpenTab, btnPop, btnSettings, btnClose);

  const iframe = document.createElement('iframe');
  iframe.className = 'qp-iframe';
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-pointer-lock  allow-same-origin');

  const resize = document.createElement('div');
  resize.className = 'qp-resize';

  const banner = document.createElement('div');
  banner.className = 'qp-banner';
  banner.style.display = 'none';
  banner.textContent = '提示：部分站点出于安全策略禁止被内嵌预览（X-Frame-Options/CSP）。可点击“新标签打开”。';

  // Settings popover (hidden by default)
  const settings = document.createElement('div');
  settings.className = 'qp-settings';
  settings.style.display = 'none';
  settings.innerHTML = `
    <h4>设置</h4>
    <div class="row">
      <label for="qp-drag-enabled">拖拽时打开预览</label>
      <input id="qp-drag-enabled" type="checkbox" />
    </div>
    <div class="row">
      <label for="qp-drag-threshold">拖拽触发阈值</label>
      <select id="qp-drag-threshold">
        <option value="8">8 px（灵敏）</option>
        <option value="12">12 px</option>
        <option value="16" selected>16 px（默认）</option>
        <option value="24">24 px</option>
        <option value="32">32 px（不易误触）</option>
      </select>
    </div>
    <div class="row">
      <label for="qp-open-size">打开大小</label>
      <select id="qp-open-size">
        <option value="fixed-720x540" selected>720×540（默认）</option>
        <option value="percent-50">窗口 50%</option>
        <option value="percent-66">窗口 66%</option>
        <option value="percent-80">窗口 80%</option>
      </select>
    </div>
    <div class="hint">仅影响“拖拽触发预览”，Alt 悬停不受影响。</div>
  `;

  container.append(header, iframe, resize, banner, settings);
  document.documentElement.appendChild(container);

  // Settings persistence
  const DEFAULT_SETTINGS = {
    dragPreviewEnabled: true,
    dragPreviewThreshold: 16,
    openSizeKey: 'fixed-720x540',
  };
  function applyOpenSize() {
    try {
      const key = STATE.openSizeKey || DEFAULT_SETTINGS.openSizeKey;
      let w = 720, h = 540;
      if (key.startsWith('percent-')) {
        const p = Math.max(10, Math.min(100, Number(key.split('-')[1]) || 66));
        w = Math.round(window.innerWidth * (p / 100));
        h = Math.round(window.innerHeight * (p / 100));
      } else if (key.startsWith('fixed-')) {
        const dims = key.split('-')[1];
        if (dims && dims.includes('x')) {
          const [sw, sh] = dims.split('x');
          const nw = Number(sw), nh = Number(sh);
          if (!Number.isNaN(nw) && !Number.isNaN(nh)) { w = nw; h = nh; }
        }
      }
      // clamp minimal size
      w = Math.max(320, w); h = Math.max(220, h);
      container.style.width = `${w}px`;
      container.style.height = `${h}px`;
      // reset data-large so按钮文本保持“放大”初始语义
      container.setAttribute('data-large', '0');
      try { btnPop.textContent = '放大'; } catch {}
    } catch {}
  }
  async function loadSettings() {
    try {
      const store = await new Promise((resolve) => {
        try { chrome.storage?.local.get(['qpSettings'], resolve); } catch { resolve({}); }
      });
      const s = (store && store.qpSettings) || {};
      const cfg = { ...DEFAULT_SETTINGS, ...s };
      STATE.dragPreviewEnabled = !!cfg.dragPreviewEnabled;
      STATE.dragPreviewThreshold = Number(cfg.dragPreviewThreshold) || DEFAULT_SETTINGS.dragPreviewThreshold;
      STATE.openSizeKey = cfg.openSizeKey || DEFAULT_SETTINGS.openSizeKey;
      // reflect to UI
      const chk = settings.querySelector('#qp-drag-enabled');
      const sel = settings.querySelector('#qp-drag-threshold');
      const selSize = settings.querySelector('#qp-open-size');
      if (chk) chk.checked = STATE.dragPreviewEnabled;
      if (sel) sel.value = String(STATE.dragPreviewThreshold);
      if (selSize) selSize.value = String(STATE.openSizeKey);
    } catch {}
  }
  function saveSettings() {
    try {
      const qpSettings = {
        dragPreviewEnabled: !!STATE.dragPreviewEnabled,
        dragPreviewThreshold: Number(STATE.dragPreviewThreshold) || DEFAULT_SETTINGS.dragPreviewThreshold,
        openSizeKey: STATE.openSizeKey || DEFAULT_SETTINGS.openSizeKey,
      };
      chrome.storage?.local.set({ qpSettings });
    } catch {}
  }
  // initial load
  loadSettings();

  // Track current hovered link (for Alt keydown preview)
  let currentHoverA = null;
  let iframeLoadTimer = 0;
  const SCROLL_LOCK = {
    active: false,
    prevHtmlOverflow: '',
    prevBodyOverflow: '',
    prevBodyPaddingRight: '',
  };

  function lockPageScroll() {
    if (SCROLL_LOCK.active) return;
    const html = document.documentElement;
    const body = document.body || html;
    // Compute scrollbar width to avoid layout shift when hiding overflow
    const scrollbarWidth = Math.max(0, window.innerWidth - html.clientWidth);
    SCROLL_LOCK.prevHtmlOverflow = html.style.overflow;
    SCROLL_LOCK.prevBodyOverflow = body.style.overflow;
    SCROLL_LOCK.prevBodyPaddingRight = body.style.paddingRight;
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    SCROLL_LOCK.active = true;
    dbg('scroll locked');
  }

  function unlockPageScroll() {
    if (!SCROLL_LOCK.active) return;
    const html = document.documentElement;
    const body = document.body || html;
    html.style.overflow = SCROLL_LOCK.prevHtmlOverflow;
    body.style.overflow = SCROLL_LOCK.prevBodyOverflow;
    body.style.paddingRight = SCROLL_LOCK.prevBodyPaddingRight;
    SCROLL_LOCK.active = false;
    dbg('scroll unlocked');
  }

  function isPreviewableLink(a) {
    if (!a || !a.getAttribute) return false;
    const href = a.getAttribute('href');
    if (!href) return false;
    if (href.trim().startsWith('#')) return false; // in-page anchors are ignored
    try {
      const u = new URL(href, location.href);
      const p = u.protocol;
      // Exclude non-navigational schemes
      if (p === 'javascript:' || p === 'mailto:' || p === 'tel:' || p === 'data:' || p === 'blob:') return false;
      // Always allow http/https
      if (p === 'http:' || p === 'https:') return true;
      // Allow same-origin links (covers file:// where origin is 'null')
      if (u.origin === location.origin) return true;
      // If current page is file://, allow file:// targets for local testing
      if (location.protocol === 'file:' && p === 'file:') return true;
      return false;
    } catch {
      return false;
    }
  }

  // (badge removed) — no floating UI, only Alt interactions

  function findAnchorFromEvent(e) {
    const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
    for (const n of path) {
      if (n && n.nodeType === 1) {
        const el = n;
        if (el.tagName === 'A' && el.hasAttribute('href')) return el;
        if (el.closest) {
          const a = el.closest('a[href]');
          if (a) return a;
        }
      }
    }
    const t = e.target;
    return t && t.closest ? t.closest('a[href]') : null;
  }

  // Try to find a nearby anchor for drag gestures
  function findAnchorNearPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    if (el && el.closest) {
      const a = el.closest('a[href]');
      if (a) return a;
    }
    // Probe a small cross radius around the point
    const offsets = [
      [0, 0], [8, 0], [-8, 0], [0, 8], [0, -8],
      [6, 6], [6, -6], [-6, 6], [-6, -6]
    ];
    for (const [dx, dy] of offsets) {
      el = document.elementFromPoint(x + dx, y + dy);
      if (el && el.closest) {
        const a = el.closest('a[href]');
        if (a) return a;
      }
    }
    return null;
  }

  // Find an anchor within a container or its close parents
  function findAnchorWithinOrParents(container, maxHops = 3) {
    if (!container) return null;
    if (container.querySelector) {
      const inner = container.querySelector('a[href]');
      if (inner) return inner;
    }
    let p = container.parentElement;
    let hops = 0;
    while (p && hops < maxHops) {
      if (p.querySelector) {
        const a = p.querySelector('a[href]');
        if (a) return a;
      }
      p = p.parentElement; hops++;
    }
    return null;
  }

  // Helpers
  function button(txt) {
    const b = document.createElement('button');
    b.className = 'qp-btn';
    b.textContent = txt;
    return b;
  }

  function getPanelSize() {
    // Fallback size when not measurable yet
    const w = container.offsetWidth || 720;
    const h = container.offsetHeight || 540;
    return { w, h };
  }

  function positionPanel(mode = 'center', x = 0, y = 0) {
    const pad = 12;
    const { w, h } = getPanelSize();
    let left, top;
    if (mode === 'cursor') {
      left = Math.max(0, Math.min(window.innerWidth - w, x + pad));
      top = Math.max(0, Math.min(window.innerHeight - h, y + pad));
    } else {
      left = Math.max(0, Math.floor((window.innerWidth - w) / 2));
      top = Math.max(0, Math.floor((window.innerHeight - h) / 2));
    }
    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    dbg('position panel', { mode, x, y, left, top, w, h });
  }

  function show(url, opts = {}) {
    STATE.url = url || STATE.url || location.href;
    try { title.textContent = new URL(STATE.url).toString(); } catch { title.textContent = STATE.url; }
    // prepare banner + load detection (to catch CSP frame-ancestors/XFO blocks)
    banner.style.display = 'none';
    clearTimeout(iframeLoadTimer);
    let settled = false;
    iframe.onload = () => { settled = true; banner.style.display = 'none'; dbg('iframe load ok', STATE.url); };
    iframe.onerror = () => { settled = true; banner.style.display = 'block'; dbg('iframe load error', STATE.url); };
    iframe.src = STATE.url;
    container.classList.add('qp-visible');
    container.style.display = 'flex';
    STATE.visible = true;
    lockPageScroll();
    // Apply preferred open size before centering
    try { applyOpenSize(); } catch {}
    // Always center the panel (ignore cursor mode)
    try { positionPanel('center'); } catch {}
    // fallback notice if load never settles (CSP frame-ancestors blocks typically never fire load)
    iframeLoadTimer = setTimeout(() => {
      if (!settled) {
        banner.style.display = 'block';
        dbg('iframe load timeout, likely blocked by CSP/XFO', STATE.url);
      }
    }, 1800);
  }

  function hide() {
    STATE.visible = false;
    container.classList.remove('qp-visible');
    container.style.display = 'none';
    unlockPageScroll();
  }

  function toggle() {
    STATE.visible ? hide() : show();
  }

  // Events: header drag
  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    STATE.dragging = true;
    const rect = container.getBoundingClientRect();
    STATE.offsetX = e.clientX - rect.left;
    STATE.offsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!STATE.dragging) return;
    const left = Math.max(0, Math.min(window.innerWidth - container.offsetWidth, e.clientX - STATE.offsetX));
    const top = Math.max(0, Math.min(window.innerHeight - container.offsetHeight, e.clientY - STATE.offsetY));
    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
  });

  // (scroll trapping via global lock only)

  document.addEventListener('mouseup', () => { STATE.dragging = false; STATE.resizing = false; });

  // Resize handle
  resize.addEventListener('mousedown', (e) => {
    STATE.resizing = true;
    STATE.startW = container.offsetWidth;
    STATE.startH = container.offsetHeight;
    STATE.startClientX = e.clientX;
    STATE.startClientY = e.clientY;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!STATE.resizing) return;
    const dx = e.clientX - STATE.startClientX;
    const dy = e.clientY - STATE.startClientY;
    const newW = Math.max(320, STATE.startW + dx);
    const newH = Math.max(220, STATE.startH + dy);
    container.style.width = `${newW}px`;
    container.style.height = `${newH}px`;
  });

  // Track current hover anchor
  document.addEventListener('pointerover', (e) => {
    const a = findAnchorFromEvent(e);
    currentHoverA = isPreviewableLink(a) ? a : null;
  }, { passive: true, capture: true });

  // Remember last mousedown position to broaden drag detection
  document.addEventListener('mousedown', (e) => {
    STATE.mouseDown = true;
    STATE.lastDownX = e.clientX;
    STATE.lastDownY = e.clientY;
    STATE.lastDownTarget = e.target || null;
    // pre-pick a candidate anchor on mousedown（更宽容的容器/附近识别）
    let a = findAnchorFromEvent(e) || findAnchorNearPoint(e.clientX, e.clientY) || findAnchorWithinOrParents(e.target);
    STATE.dragCandidateAnchor = isPreviewableLink(a) ? a : null;
    STATE.dragPreviewFired = false;
  }, { capture: true, passive: true });

  document.addEventListener('mouseup', () => {
    STATE.mouseDown = false;
    STATE.dragActive = false;
    STATE.dragCandidateAnchor = null;
    STATE.dragPreviewFired = false;
  }, { capture: true, passive: true });

  // Mark dragging starts; don't open yet, wait for movement threshold
  document.addEventListener('dragstart', (e) => {
    if (!STATE.dragPreviewEnabled) return;
    STATE.dragActive = true;
    STATE.lastDragStartX = e.clientX;
    STATE.lastDragStartY = e.clientY;
    // Keep/refresh candidate anchor
    let a = findAnchorFromEvent(e) || findAnchorNearPoint(e.clientX, e.clientY) || findAnchorWithinOrParents(e.target);
    STATE.dragCandidateAnchor = isPreviewableLink(a) ? a : STATE.dragCandidateAnchor;
  }, { capture: true });

  // While dragging, open only after exceeding threshold distance
  document.addEventListener('dragover', (e) => {
    if (!STATE.dragPreviewEnabled || !STATE.dragActive || STATE.dragPreviewFired) return;
    const sx = STATE.lastDownX || STATE.lastDragStartX || e.clientX;
    const sy = STATE.lastDownY || STATE.lastDragStartY || e.clientY;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < STATE.dragPreviewThreshold) return;
    // choose best anchor near current pointer, falling back to recorded candidate
    let a = findAnchorNearPoint(e.clientX, e.clientY) || STATE.dragCandidateAnchor;
    if (!isPreviewableLink(a)) return;
    try {
      const url = new URL(a.getAttribute('href'), location.href).toString();
      STATE.openedByDrag = true;
      STATE.dragPreviewFired = true;
      dbg('dragover threshold met -> preview', { dist: Math.round(dist), url });
      show(url);
    } catch {}
  }, { capture: true });

  // Drag结束后保持面板开启（按需求不自动关闭）
  document.addEventListener('dragend', () => {
    STATE.openedByDrag = false;
    STATE.dragActive = false;
    STATE.dragCandidateAnchor = null;
    STATE.dragPreviewFired = false;
  }, { capture: true });

  // Buttons
  btnReload.addEventListener('click', () => { if (STATE.visible) iframe.src = STATE.url; });
  btnOpenTab.addEventListener('click', () => { if (STATE.url) window.open(STATE.url, '_blank', 'noopener'); });
  btnPop.addEventListener('click', () => {
    // toggle size small/large
    const large = container.getAttribute('data-large') === '1';
    if (large) {
      container.style.width = '720px';
      container.style.height = '540px';
      container.setAttribute('data-large', '0');
      btnPop.textContent = '放大';
    } else {
      container.style.width = Math.round(window.innerWidth * 0.66) + 'px';
      container.style.height = Math.round(window.innerHeight * 0.66) + 'px';
      container.setAttribute('data-large', '1');
      btnPop.textContent = '还原';
    }
    // Recenter after resizing
    try { positionPanel('center'); } catch {}
  });
  btnClose.addEventListener('click', hide);
  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    settings.style.display = settings.style.display === 'none' ? 'block' : 'none';
  });
  // prevent header drag when interacting with settings
  settings.addEventListener('mousedown', (e) => { e.stopPropagation(); });
  settings.addEventListener('click', (e) => { e.stopPropagation(); });
  // bind settings controls
  settings.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'qp-drag-enabled') {
      STATE.dragPreviewEnabled = !!t.checked;
      saveSettings();
    } else if (t.id === 'qp-drag-threshold') {
      const v = Number(t.value);
      if (!Number.isNaN(v) && v > 0) {
        STATE.dragPreviewThreshold = v;
        saveSettings();
      }
    } else if (t.id === 'qp-open-size') {
      const v = String(t.value || 'fixed-720x540');
      STATE.openSizeKey = v;
      saveSettings();
      if (STATE.visible) { try { applyOpenSize(); positionPanel('center'); } catch {} }
    }
  });

  // ESC to close
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && STATE.visible) hide(); });

  // Alt + Hover to preview link (robust)
  // - Use modifier state from events (e.altKey) instead of manual toggling
  // - Capture key events to avoid site-level handlers swallowing them
  // - Also trigger when Alt is pressed while already hovering a link
  function previewIfAltAndLink(anchorEl) {
    if (!STATE.hoverEnabled) return;
    if (!anchorEl || !isPreviewableLink(anchorEl)) return;
    try {
      const url = new URL(anchorEl.getAttribute('href'), location.href).toString();
      dbg('Alt trigger -> preview', { href: anchorEl.getAttribute('href'), url });
      show(url);
    } catch { /* ignore */ }
  }

  // Trigger on pointer entering a link while Alt is held
  document.addEventListener('pointerover', (e) => {
    if (!STATE.hoverEnabled) return;
    if (!e.altKey) return;
    const a = findAnchorFromEvent(e);
    if (!a) return;
    dbg('Alt+pointerover on link', { href: a.getAttribute('href') });
    try {
      const url = new URL(a.getAttribute('href'), location.href).toString();
      show(url);
    } catch { previewIfAltAndLink(a); }
  }, { passive: true, capture: true });

  // Trigger when Alt is pressed while already hovering a link
  document.addEventListener('keydown', (e) => {
    // Some layouts use AltGraph; treat it as Alt as well
    const isAlt = e.altKey || e.key === 'Alt' || e.key === 'AltGraph';
    if (!isAlt) return;
    if (!STATE.hoverEnabled) return;
    // Use the current hovered link we track
    if (currentHoverA) {
      dbg('Alt keydown while hovering link', { href: currentHoverA.getAttribute('href'), key: e.key, altKey: e.altKey });
      try {
        const url = new URL(currentHoverA.getAttribute('href'), location.href).toString();
        show(url);
      } catch { previewIfAltAndLink(currentHoverA); }
    } else {
      dbg('Alt keydown with no hover target', { key: e.key, altKey: e.altKey });
    }
  }, { capture: true });

  // Messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'OPEN_QUICKPEEK') {
      show(msg.url);
    } else if (msg.type === 'TOGGLE_QUICKPEEK') {
      toggle();
    }
  });
})();
