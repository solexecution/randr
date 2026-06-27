// Code-pane chrome: line numbers, params sidebar resize/collapse, editor shortcuts.

const LS_HEIGHT = 'randr.paramsPaneH';
const LS_EDITOR_H = 'randr.codeEditorPaneH';
const LS_WIDTH = 'randr.paramsPaneW'; // legacy (side layout)
const LS_COLLAPSED = 'randr.paramsPaneCollapsed';
const LS_WRAP = 'randr.editorWrap';
const LS_SIDEBAR_W = 'randr.sidebarW';
const LS_CODE_CARD_W = 'randr.codeCardW'; // legacy key
const DEFAULT_PARAMS_H = 168;
const MIN_PARAMS_H = 72;
const MIN_CODE_CARD_W = 280;
const DEFAULT_CODE_CARD_W = 440;
/** Minimum height of `.code-main` (toolbar + padding + a usable editor strip). */
const MIN_EDITOR_H = 204;

function $(root, sel) { return root.querySelector(sel); }

const ERROR_ROW_RE = /^Row (\d+), column (\d+) — (.+)$/s;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseCompileError(msg) {
  const m = msg.match(ERROR_ROW_RE);
  if (!m) return { line: null, col: null, message: msg, raw: msg };
  return { line: +m[1], col: +m[2], message: m[3], raw: msg };
}

function offsetForLine(value, lineNum) {
  if (lineNum < 1) return 0;
  let line = 1;
  let i = 0;
  while (line < lineNum && i < value.length) {
    const n = value.indexOf('\n', i);
    if (n === -1) return value.length;
    i = n + 1;
    line++;
  }
  return i;
}

function lineMetrics(editor) {
  const st = getComputedStyle(editor);
  return {
    lh: parseFloat(st.lineHeight) || 20,
    padY: parseFloat(st.paddingTop) || 10,
    padTop: parseFloat(st.paddingTop) || 10,
    padBottom: parseFloat(st.paddingBottom) || 10,
  };
}

/** Hidden mirror for wrap-aware caret position and per-line visual row counts. */
function createMeasureEl() {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;overflow:hidden;';
  document.body.appendChild(el);
  return el;
}

function syncMeasureEl(measureEl, editor, wrapOn) {
  const st = getComputedStyle(editor);
  measureEl.style.font = st.font;
  measureEl.style.fontSize = st.fontSize;
  measureEl.style.fontFamily = st.fontFamily;
  measureEl.style.lineHeight = st.lineHeight;
  measureEl.style.letterSpacing = st.letterSpacing;
  measureEl.style.tabSize = st.tabSize;
  measureEl.style.boxSizing = st.boxSizing;
  measureEl.style.width = `${editor.clientWidth}px`;
  measureEl.style.padding = st.padding;
  measureEl.style.whiteSpace = wrapOn ? 'pre-wrap' : 'pre';
  measureEl.style.overflowWrap = wrapOn ? 'break-word' : 'normal';
  measureEl.style.wordBreak = wrapOn ? 'break-word' : 'normal';
}

function measureLineRows(measureEl, line, lh) {
  measureEl.textContent = line.length === 0 ? ' ' : line;
  const { padTop, padBottom } = lineMetrics(measureEl);
  const contentH = measureEl.offsetHeight - padTop - padBottom;
  return Math.max(1, Math.ceil(contentH / lh - 1e-6));
}

function caretVisualRowOnLine(measureEl, lineText, caretCol, lh) {
  measureEl.textContent = '';
  measureEl.appendChild(document.createTextNode(lineText.slice(0, caretCol)));
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  measureEl.appendChild(mark);
  return Math.floor(mark.offsetTop / lh + 1e-6);
}

function caretBandTop(editor, measureEl, wrapOn) {
  const { lh, padY } = lineMetrics(editor);
  if (!wrapOn) {
    const caretLine = editor.value.slice(0, editor.selectionStart).split('\n').length;
    return padY + (caretLine - 1) * lh;
  }
  syncMeasureEl(measureEl, editor, true);
  const pos = editor.selectionStart;
  measureEl.textContent = '';
  measureEl.appendChild(document.createTextNode(editor.value.slice(0, pos)));
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  measureEl.appendChild(mark);
  return padY + mark.offsetTop;
}

function scrollEditorToLine(editor, lineNum) {
  const value = editor.value;
  const start = offsetForLine(value, lineNum);
  const end = value.indexOf('\n', start);
  const lineEnd = end === -1 ? value.length : end;
  editor.focus();
  editor.setSelectionRange(start, lineEnd);
  const { lh, padY } = lineMetrics(editor);
  editor.scrollTop = Math.max(0, (lineNum - 3) * lh + padY - editor.clientHeight * 0.25);
}

function lineRange(value, start, end) {
  const ls = value.lastIndexOf('\n', start - 1) + 1;
  const le = value.indexOf('\n', end);
  return [ls, le === -1 ? value.length : le];
}

function selectedLineRanges(value, start, end) {
  const [a, b] = lineRange(value, start, end);
  const ranges = [];
  let p = a;
  while (p <= b) {
    const n = value.indexOf('\n', p);
    const le = n === -1 ? value.length : n;
    ranges.push([p, le]);
    if (le >= value.length) break;
    p = le + 1;
  }
  return ranges;
}

function replaceRange(value, start, end, text) {
  return value.slice(0, start) + text + value.slice(end);
}

/** Strip // comments (respecting quoted strings) from every line; drop blank lines. */
export function removeComments(value) {
  const out = value.split('\n').map(stripLineComment).filter((l) => l.trim() !== '');
  return out.join('\n');
}

function stripLineComment(line) {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === quote && line[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i).replace(/\s+$/, '');
  }
  return line;
}

function toggleComment(value, start, end) {
  const ranges = selectedLineRanges(value, start, end);
  const lines = ranges.map(([s, e]) => value.slice(s, e));
  const allCommented = lines.every((l) => /^\s*\/\//.test(l));
  const out = lines.map((l) => {
    if (allCommented) return l.replace(/^(\s*)\/\/\s?/, '$1');
    const m = l.match(/^(\s*)/);
    return `${m[1]}// ${l.slice(m[1].length)}`;
  });
  const joined = out.join('\n');
  return { value: replaceRange(value, ranges[0][0], ranges[ranges.length - 1][1], joined), selStart: ranges[0][0], selEnd: ranges[0][0] + joined.length };
}

function indentLines(value, start, end, outdent) {
  const ranges = selectedLineRanges(value, start, end);
  const lines = ranges.map(([s, e]) => value.slice(s, e));
  const out = lines.map((l) => {
    if (outdent) {
      if (l.startsWith('  ')) return l.slice(2);
      if (l.startsWith('\t')) return l.slice(1);
      return l;
    }
    return `  ${l}`;
  });
  const joined = out.join('\n');
  return { value: replaceRange(value, ranges[0][0], ranges[ranges.length - 1][1], joined), selStart: ranges[0][0], selEnd: ranges[0][0] + joined.length };
}

function duplicateLine(value, caret) {
  const [ls, le] = lineRange(value, caret, caret);
  const line = value.slice(ls, le);
  const insert = `\n${line}`;
  const at = le;
  return { value: replaceRange(value, at, at, insert), caret: at + insert.length };
}

function insertTab(value, start, end) {
  if (start !== end) return indentLines(value, start, end, false);
  const tab = '  ';
  return { value: replaceRange(value, start, end, tab), caret: start + tab.length };
}

function outdentTab(value, start, end) {
  if (start !== end) return indentLines(value, start, end, true);
  const [ls] = lineRange(value, start, end);
  const line = value.slice(ls, value.indexOf('\n', ls) === -1 ? value.length : value.indexOf('\n', ls));
  if (line.startsWith('  ')) {
    return { value: replaceRange(value, ls, ls + 2, ''), caret: Math.max(ls, start - 2) };
  }
  if (line.startsWith('\t')) {
    return { value: replaceRange(value, ls, ls + 1, ''), caret: Math.max(ls, start - 1) };
  }
  return { value, caret: start };
}

function maxCodeCardW() {
  const rail = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) || 0;
  return Math.max(MIN_CODE_CARD_W, window.innerWidth - rail - 8);
}

function workspaceH(workspace) {
  return workspace?.getBoundingClientRect().height ?? 0;
}

function maxParamsH(workspace) {
  if (!workspace) return 280;
  const h = workspaceH(workspace);
  return Math.max(MIN_PARAMS_H, h - MIN_EDITOR_H);
}

function clampParamsH(workspace, h) {
  return Math.min(maxParamsH(workspace), Math.max(MIN_PARAMS_H, h));
}

/** Keep the editor block height within what the workspace can actually fit. */
function clampEditorPaneH(workspace, editorH, splitterH) {
  const wh = workspaceH(workspace);
  if (wh <= 0) return Math.max(MIN_EDITOR_H, editorH);
  const maxEd = wh - splitterH - MIN_PARAMS_H;
  return Math.max(MIN_EDITOR_H, Math.min(editorH, maxEd));
}

function paramsHForEditorPane(workspace, editorPaneH, splitterPx) {
  const h = workspaceH(workspace);
  if (h <= 0) return DEFAULT_PARAMS_H;
  return clampParamsH(workspace, h - splitterPx - editorPaneH);
}

/** Restore the editor anchor from localStorage, preferring a consistent editor+params pair. */
function loadEditorAnchor(workspace, paramsH, splitterH) {
  const wh = workspaceH(workspace);
  let savedEditor = null;
  let savedParams = null;
  try {
    const ep = parseFloat(localStorage.getItem(LS_EDITOR_H));
    if (ep >= MIN_EDITOR_H) savedEditor = ep;
    const ph = parseFloat(localStorage.getItem(LS_HEIGHT))
      ?? parseFloat(localStorage.getItem(LS_WIDTH));
    if (ph >= MIN_PARAMS_H) savedParams = ph;
  } catch { /* quota */ }
  if (savedEditor != null && savedParams != null
      && Math.abs((wh - splitterH - savedEditor) - savedParams) <= 2) {
    return clampEditorPaneH(workspace, savedEditor, splitterH);
  }
  if (savedEditor != null && wh > 0) {
    return clampEditorPaneH(workspace, savedEditor, splitterH);
  }
  if (savedParams != null && wh > 0) {
    return clampEditorPaneH(workspace, wh - splitterH - savedParams, splitterH);
  }
  if (wh > 0) return clampEditorPaneH(workspace, wh - splitterH - paramsH, splitterH);
  return MIN_EDITOR_H;
}

/** Wire line gutter, params split pane, and in-editor shortcuts onto App. */
export function installCodeEditor(app) {
  const root = app.root;
  const editor = $(root, '#editor');
  const workspace = $(root, '#code-workspace');
  const paramsPane = $(root, '#code-params-pane');
  const splitter = $(root, '#code-splitter');
  const showBtn = $(root, '#params-show');
  const hideBtn = $(root, '#params-hide');
  const wrapBtn = $(root, '#editor-wrap-toggle');
  const stripBtn = $(root, '#strip-comments');
  const card = $(root, '#part-card');
  const cardResize = $(root, '#card-resize');
  const gutter = $(root, '#editor-gutter');
  const lnPre = $(root, '#editor-ln');
  const activeBand = $(root, '#editor-active-line');
  if (!editor || !workspace || !paramsPane) return;

  let paramsH = DEFAULT_PARAMS_H;
  let editorPaneH = null;
  let paramsCollapsed = false;
  let wrapOn = false;
  let sidebarW = DEFAULT_CODE_CARD_W;
  try {
    const h = parseFloat(localStorage.getItem(LS_HEIGHT))
      ?? parseFloat(localStorage.getItem(LS_WIDTH));
    const maxP = maxParamsH(workspace);
    if (h >= MIN_PARAMS_H && h <= maxP) paramsH = h;
    paramsCollapsed = localStorage.getItem(LS_COLLAPSED) === '1';
    wrapOn = localStorage.getItem(LS_WRAP) === '1';
    const sw = parseFloat(localStorage.getItem(LS_SIDEBAR_W))
      ?? parseFloat(localStorage.getItem(LS_CODE_CARD_W));
    if (sw >= MIN_CODE_CARD_W) sidebarW = Math.min(sw, maxCodeCardW());
  } catch { /* quota */ }

  const splitterPx = () => splitter?.offsetHeight ?? 12;

  editorPaneH = loadEditorAnchor(workspace, paramsH, splitterPx());

  function syncEditorPaneH() {
    const h = workspaceH(workspace);
    if (h > 0) editorPaneH = clampEditorPaneH(workspace, h - splitterPx() - paramsH, splitterPx());
  }

  function persistParamsSize() {
    try {
      localStorage.setItem(LS_HEIGHT, String(paramsH));
      if (editorPaneH != null) localStorage.setItem(LS_EDITOR_H, String(Math.round(editorPaneH)));
    } catch { /* quota */ }
  }

  function setParamsH(next, { persist = false, syncEditor = false } = {}) {
    paramsH = clampParamsH(workspace, next);
    paramsPane.style.setProperty('--params-pane-h', `${paramsH}px`);
    if (syncEditor) syncEditorPaneH();
    if (persist) persistParamsSize();
  }

  /** Keep the editor block size stable; params bar absorbs workspace height changes. */
  function applyParamsFromEditorAnchor() {
    if (paramsCollapsed) return;
    const h = workspaceH(workspace);
    if (h <= 0) return;
    if (editorPaneH == null) syncEditorPaneH();
    else editorPaneH = clampEditorPaneH(workspace, editorPaneH, splitterPx());
    setParamsH(paramsHForEditorPane(workspace, editorPaneH, splitterPx()), { persist: true });
  }

  function applySidebarWidth() {
    if (!card) return;
    sidebarW = Math.min(maxCodeCardW(), Math.max(MIN_CODE_CARD_W, sidebarW));
    card.style.setProperty('--sidebar-w', `${sidebarW}px`);
    try { localStorage.setItem(LS_SIDEBAR_W, String(Math.round(sidebarW))); } catch { /* quota */ }
  }

  applySidebarWidth();

  function onWorkspaceResize() {
    applyParamsFromEditorAnchor();
  }

  window.addEventListener('resize', () => {
    applySidebarWidth();
    onWorkspaceResize();
  });

  if (typeof ResizeObserver !== 'undefined') {
    const workspaceRo = new ResizeObserver(() => onWorkspaceResize());
    workspaceRo.observe(workspace);
  }

  function applyParamsLayout() {
    workspace.classList.toggle('params-collapsed', paramsCollapsed);
    if (paramsCollapsed) {
      if (showBtn) showBtn.hidden = false;
      if (hideBtn) hideBtn.hidden = true;
    } else {
      editorPaneH = clampEditorPaneH(workspace, editorPaneH ?? MIN_EDITOR_H, splitterPx());
      setParamsH(paramsHForEditorPane(workspace, editorPaneH, splitterPx()));
      if (showBtn) showBtn.hidden = true;
      if (hideBtn) hideBtn.hidden = false;
    }
    try { localStorage.setItem(LS_COLLAPSED, paramsCollapsed ? '1' : '0'); } catch { /* quota */ }
    if (!paramsCollapsed) persistParamsSize();
  }

  function applyWrap() {
    workspace.classList.toggle('editor-wrap-on', wrapOn);
    editor.setAttribute('wrap', wrapOn ? 'soft' : 'off');
    if (wrapBtn) wrapBtn.classList.toggle('on', wrapOn);
    try { localStorage.setItem(LS_WRAP, wrapOn ? '1' : '0'); } catch { /* quota */ }
    app._updateEditorGutter?.();
  }

  function toggleParams() {
    paramsCollapsed = !paramsCollapsed;
    applyParamsLayout();
  }

  applyParamsLayout();

  showBtn?.addEventListener('click', toggleParams);
  hideBtn?.addEventListener('click', toggleParams);
  wrapBtn?.addEventListener('click', () => { wrapOn = !wrapOn; applyWrap(); });

  stripBtn?.addEventListener('click', () => {
    const before = editor.value;
    const after = removeComments(before);
    if (after === before) {
      app._toast?.('No // comments to remove');
      return;
    }
    applyEdit({ value: after, selStart: 0, selEnd: 0, caret: 0 });
    app._toast?.('Comments removed — Ctrl+Z to undo');
  });

  // --- resizable sidebar (inner edge of the docked card — code or build) ---
  if (cardResize && card) {
    let drag = null;
    const isDocked = () => card.classList.contains('dock-left') || card.classList.contains('dock-right');
    const dockSide = () => (card.classList.contains('dock-left') ? 'left' : 'right');
    const onMove = (e) => {
      if (!drag) return;
      const dx = dockSide() === 'right' ? drag.x - e.clientX : e.clientX - drag.x;
      sidebarW = Math.min(maxCodeCardW(), Math.max(MIN_CODE_CARD_W, drag.w + dx));
      card.style.setProperty('--sidebar-w', `${sidebarW}px`);
    };
    const onUp = () => {
      if (!drag) return;
      drag = null;
      cardResize.classList.remove('dragging');
      document.body.style.cursor = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      applySidebarWidth();
    };
    cardResize.addEventListener('pointerdown', (e) => {
      if (!isDocked() || card.classList.contains('collapsed')) return;
      e.preventDefault();
      e.stopPropagation();
      drag = { x: e.clientX, w: sidebarW };
      cardResize.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      cardResize.setPointerCapture(e.pointerId);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    cardResize.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sidebarW = maxCodeCardW();
      applySidebarWidth();
      app._toast?.('Panel expanded to full width');
    });
  }

  app._applySidebarWidth = applySidebarWidth;
  app._applyParamsAnchor = applyParamsFromEditorAnchor;

  // --- resizable params bar (drag splitter up/down) ---
  if (splitter) {
    let drag = null;
    const onMove = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      setParamsH(drag.h + dy);
    };
    const onUp = () => {
      if (!drag) return;
      drag = null;
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setParamsH(paramsH, { persist: true, syncEditor: true });
    };
    splitter.addEventListener('pointerdown', (e) => {
      if (paramsCollapsed) return;
      e.preventDefault();
      drag = { y: e.clientY, h: paramsH };
      splitter.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      splitter.setPointerCapture(e.pointerId);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  let errorLine = null;
  const measureEl = createMeasureEl();
  const editorWrap = $(root, '.editor-wrap');

  // --- line numbers + active / error line ---
  function updateActiveLineBand() {
    if (!activeBand) return;
    const value = editor.value;
    if (!value) { activeBand.style.display = 'none'; return; }
    activeBand.style.display = 'block';
    const { lh } = lineMetrics(editor);
    const top = caretBandTop(editor, measureEl, wrapOn) - editor.scrollTop;
    activeBand.style.transform = `translateY(${top}px)`;
    activeBand.style.height = `${lh}px`;
  }

  function updateGutter() {
    if (!lnPre || !gutter) return;
    const value = editor.value;
    const pos = editor.selectionStart;
    const caretLine = value.slice(0, pos).split('\n').length;
    const lines = value.split('\n');
    const { lh } = lineMetrics(editor);
    const parts = [];

    if (!wrapOn) {
      lines.forEach((_, i) => {
        const n = i + 1;
        let cls = 'ln';
        if (n === errorLine) cls += ' error-line';
        else if (n === caretLine) cls += ' active';
        parts.push(`<span class="${cls}" data-line="${n}">${n}</span>`);
      });
    } else {
      syncMeasureEl(measureEl, editor, true);
      const caretLineIdx = caretLine - 1;
      const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
      const caretCol = pos - lineStart;
      const caretRowOnLine = caretVisualRowOnLine(
        measureEl, lines[caretLineIdx] ?? '', caretCol, lh,
      );
      for (let i = 0; i < lines.length; i++) {
        const n = i + 1;
        const rows = measureLineRows(measureEl, lines[i], lh);
        for (let r = 0; r < rows; r++) {
          const isFirst = r === 0;
          let cls = isFirst ? 'ln' : 'ln ln-cont';
          if (n === errorLine) cls += ' error-line';
          else if (i === caretLineIdx && r === caretRowOnLine) cls += ' active';
          const label = isFirst ? String(n) : '';
          parts.push(`<span class="${cls}" data-line="${n}">${label}</span>`);
        }
      }
    }

    lnPre.innerHTML = parts.join('') || '<span class="ln active" data-line="1">1</span>';
    gutter.scrollTop = editor.scrollTop;
    updateActiveLineBand();
  }

  app._updateEditorGutter = updateGutter;
  applyWrap();

  gutter?.addEventListener('click', (e) => {
    const el = e.target.closest('.ln');
    if (!el) return;
    const n = parseInt(el.dataset.line, 10);
    if (n > 0) scrollEditorToLine(editor, n);
  });

  if (editorWrap && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => updateGutter());
    ro.observe(editorWrap);
  }

  app._setErrorLine = (line) => {
    errorLine = line;
    updateGutter();
    if (line) scrollEditorToLine(editor, line);
  };

  const errEl = $(root, '#error');
  if (errEl) {
    errEl.addEventListener('click', (e) => {
      if (e.target.closest('.error-copy')) return;
      if (errorLine) scrollEditorToLine(editor, errorLine);
    });
    errEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && errorLine) { e.preventDefault(); scrollEditorToLine(editor, errorLine); }
    });
  }

  app._showCompileError = (message) => {
    if (!errEl) return;
    if (!message) {
      errEl.classList.remove('show', 'has-row');
      errEl.textContent = '';
      errorLine = null;
      updateGutter();
      return;
    }
    const parsed = parseCompileError(message);
    errorLine = parsed.line;
    updateGutter();
    if (parsed.line) {
      errEl.classList.add('has-row');
      errEl.innerHTML = `<div class="error-head"><span class="error-loc">Row ${parsed.line}, column ${parsed.col}</span><button type="button" class="error-copy" title="Copy error message">Copy</button></div><span class="error-msg">${escapeHtml(parsed.message)}</span><span class="error-hint">Click here or the row number on the left to jump to that line</span>`;
      errEl.querySelector('.error-copy')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = parsed.raw;
        navigator.clipboard?.writeText(text).then(
          () => app._toast?.('Error copied'),
          () => app._toast?.('Could not copy — select the text instead'),
        );
      });
      scrollEditorToLine(editor, parsed.line);
    } else {
      errEl.classList.remove('has-row');
      errEl.textContent = message;
    }
    errEl.classList.add('show');
  };

  const syncScroll = () => {
    const pre = $(root, '.editor-hl');
    if (pre) { pre.scrollTop = editor.scrollTop; pre.scrollLeft = editor.scrollLeft; }
    if (gutter) gutter.scrollTop = editor.scrollTop;
    updateActiveLineBand();
  };

  editor.addEventListener('scroll', syncScroll);
  ['keyup', 'click', 'mouseup', 'input'].forEach((ev) =>
    editor.addEventListener(ev, () => updateGutter()));

  function applyEdit({ value, selStart, selEnd, caret }) {
    editor.value = value;
    app.source = value;
    app.overrides = {};
    app._codeMirror = null;
    editor.setSelectionRange(caret ?? selStart, caret ?? selEnd);
    app._highlightEditor();
    app._scheduleRecompile();
    updateGutter();
  }

  editor.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;

    if (mod && k === '\\') { e.preventDefault(); toggleParams(); return; }
    if (mod && k === 'Enter') { e.preventDefault(); app.recompile?.(); return; }
    if (mod && (k === '/' || k === '?')) {
      e.preventDefault();
      const { value, selStart, selEnd } = toggleComment(editor.value, editor.selectionStart, editor.selectionEnd);
      applyEdit({ value, selStart, selEnd });
      return;
    }
    if (mod && k.toLowerCase() === 'd') {
      e.preventDefault();
      const { value, caret } = duplicateLine(editor.value, editor.selectionStart);
      applyEdit({ value, caret });
      return;
    }
    if (mod && k === ']') {
      e.preventDefault();
      const { value, selStart, selEnd } = indentLines(editor.value, editor.selectionStart, editor.selectionEnd, false);
      applyEdit({ value, selStart, selEnd });
      return;
    }
    if (mod && k === '[') {
      e.preventDefault();
      const { value, selStart, selEnd } = indentLines(editor.value, editor.selectionStart, editor.selectionEnd, true);
      applyEdit({ value, selStart, selEnd });
      return;
    }
    if (k === 'Tab') {
      e.preventDefault();
      const fn = e.shiftKey ? outdentTab : insertTab;
      const { value, caret, selStart, selEnd } = fn(editor.value, editor.selectionStart, editor.selectionEnd);
      applyEdit({ value, selStart, selEnd, caret });
      return;
    }
  });

  updateGutter();
}

export {
  clampEditorPaneH,
  clampParamsH,
  paramsHForEditorPane,
  loadEditorAnchor,
  MIN_EDITOR_H,
  MIN_PARAMS_H,
};