// The left tool strip: a floating, dockable, user-customizable toolbar.
//
// The bar owns its own layout (which tools are standalone buttons, which live
// inside menu groups, and the order) plus where it sits (docked left/right or
// floating) — all persisted in localStorage under randr.toolbar. The actual
// tool *behaviors* stay in App: every managed button is a DOM node App wires
// once, and the toolbar only re-parents those nodes (appendChild) to arrange
// them, so their click handlers survive the move untouched. The one "shell"
// button whose behavior is the toolbar's own concern — curve quality — fires
// back to App via a callback. (code/build/result and the code-panel toggle moved
// to the dedicated top-bar segmented control.)
//
// App owns the wiring:
//   this.toolbar = new Toolbar(root)
//   this.toolbar.onQualityChange = …
//   this.toolbar.init({ mode, curveQuality })
//   this.toolbar.syncState({ mode, curveQuality })  // reflect app state on buttons

import { esc } from './escape.js';

// Curve-smoothness levels for the quality button — it cycles through these and
// shows the current fill level as its glyph. v is the segment count for round shapes.
export const QUALITY_LEVELS = [
  { v: 24,  name: 'Draft',    glyph: '◔' },
  { v: 48,  name: 'Standard', glyph: '◑' },
  { v: 64,  name: 'Smooth',   glyph: '◕' },
  { v: 128, name: 'Ultra',    glyph: '●' },
];

// Every tool that can live on the bar — the single source of truth for both the
// seed DOM (toolbarSeedHTML) and the runtime layout. Each is a single icon
// button whose node is re-parented as-is. `title` is the button tooltip;
// `label` is the shorter name the customise modal shows; `on` seeds a button
// that starts active.
const TOOLBAR_TOOLS = [
  { id: 'rail-home', glyph: '⌂', label: 'Home', title: 'Home — frame the whole plate', cat: 'View' },
  { id: 'v-grid', glyph: '▦', label: 'Grid', title: 'Grid', cat: 'View', on: true },
  { id: 'v-snap', glyph: '⌗', label: 'Snap 1 mm', title: 'Snap to 1 mm', cat: 'View', on: true },
  { id: 'v-theme', glyph: '◐', label: 'Light / dark', title: 'Dark / light mode', cat: 'View' },
  { id: 'v-mmgrid', glyph: '⊞', label: 'mm grid', title: 'mm grid', cat: 'View' },
  { id: 'v-wire', glyph: '◇', label: 'Wireframe', title: 'Wireframe', cat: 'View' },
  { id: 'v-measure', glyph: '📏', label: 'Measure', title: 'Measure', cat: 'Inspect & print' },
  { id: 'v-layers', glyph: '≣', label: 'Layer preview', title: 'Layer preview', cat: 'Inspect & print' },
  { id: 'v-overhang', glyph: '◣', label: 'Overhang', title: 'Overhang check', cat: 'Inspect & print' },
  { id: 'v-orient', glyph: '⤓', label: 'Auto-orient', title: 'Auto-orient', cat: 'Inspect & print' },
  { id: 'v-fit-plate', glyph: '⤡', label: 'Fit to plate', title: 'Fit to plate', cat: 'Inspect & print' },
  { id: 'v-cut', glyph: '✂', label: 'Cut in half', title: 'Cut in half', cat: 'Inspect & print' },
  { id: 'v-quality', glyph: '◕', label: 'Curve quality', title: 'Curve quality: Smooth — tap to cycle', cat: 'View' },
];
// Default: every tool is its own button (no "More" group) so the whole kit is
// visible at a glance. Users can still group / hide tools via the ✎ modal.
const TOOLBAR_DEFAULT = [
  { type: 'tool', id: 'rail-home' },
  { type: 'tool', id: 'v-grid' },
  { type: 'tool', id: 'v-snap' },
  { type: 'tool', id: 'v-theme' },
  { type: 'tool', id: 'v-mmgrid' },
  { type: 'tool', id: 'v-wire' },
  { type: 'tool', id: 'v-measure' },
  { type: 'tool', id: 'v-layers' },
  { type: 'tool', id: 'v-overhang' },
  { type: 'tool', id: 'v-orient' },
  { type: 'tool', id: 'v-fit-plate' },
  { type: 'tool', id: 'v-cut' },
  { type: 'tool', id: 'v-quality' },
];

// Bump when the default layout gains a tool, and add a matching step in
// migrateToolbar so older saved layouts surface it. Pre-versioned blobs read as v1.
// (Removing a tool needs no step — migrate prunes ids not in KNOWN_IDS.)
export const TOOLBAR_VERSION = 6;
const KNOWN_IDS = new Set(TOOLBAR_TOOLS.map((t) => t.id));

function defaultToolbarState() {
  // 'dodge' = floats opposite the parts card (placed by CSS, like the nav cube)
  return { version: TOOLBAR_VERSION, dock: 'dodge', x: 80, y: 110, layout: JSON.parse(JSON.stringify(TOOLBAR_DEFAULT)) };
}

// The single place that brings a persisted toolbar blob (any older version, or
// null / garbage) up to the current schema: drop entries whose tool no longer
// exists, then run the version steps that surface tools introduced after the
// blob was saved. New default tool? Bump TOOLBAR_VERSION and add one step here —
// don't scatter fresh `if (!layout.some(...))` checks back into init().
export function migrateToolbar(saved) {
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.layout) || !saved.layout.length) {
    return defaultToolbarState();
  }
  const version = Number.isInteger(saved.version) ? saved.version : 1;
  // v6 overhauled the default bar — every tool shown as a button, floating
  // opposite the parts card — so adopt the new default wholesale for any older blob.
  if (version < 6) return defaultToolbarState();
  const layout = saved.layout
    .map((e) => (e.type === 'group' ? { ...e, items: (e.items || []).filter((id) => KNOWN_IDS.has(id)) } : e))
    .filter((e) => e.type === 'group' || KNOWN_IDS.has(e.id));
  // future: surface tools added after v6 here (bump TOOLBAR_VERSION + push the id)
  return {
    version: TOOLBAR_VERSION,
    dock: ['right', 'float', 'dodge', 'left'].includes(saved.dock) ? saved.dock : 'dodge',
    x: Number.isFinite(saved.x) ? saved.x : 80,
    y: Number.isFinite(saved.y) ? saved.y : 110,
    layout,
  };
}

// Open `menu` (a .menu element), closing any other open one — the single
// open-at-a-time behavior shared by the toolbar groups and the ☰ app menu.
export function toggleMenu(root, menu) {
  const was = menu.classList.contains('open');
  root.querySelectorAll('.menu.open').forEach((o) => o.classList.remove('open'));
  if (!was) menu.classList.add('open');
}

// Seed markup for the bar, generated from the registry so the static DOM never
// drifts from the runtime model. Buttons land flat in #tools-body; init() then
// parks them and lays the bar out per the saved/default layout — so the order
// and grouping here don't matter, only that every managed tool is present for
// App to wire (by id) and for render() to place.
export function toolbarSeedHTML() {
  return TOOLBAR_TOOLS
    .map((t) => `<button class="rail-btn rail-labeled${t.on ? ' on' : ''}" id="${t.id}" title="${esc(t.title || t.label)}"><span class="rail-glyph" aria-hidden="true">${t.glyph}</span><span class="rail-lab">${esc(t.label)}</span></button>`)
    .join('\n          ');
}

export class Toolbar {
  constructor(root) {
    this.root = root;
    // callbacks set by App (mirrors the Viewport.onSelect pattern):
    this.onQualityChange = null; // (level) => {} — quality cycled to `level`
    // the app state the shell buttons reflect (App pushes these in via syncState):
    this._st = { mode: 'code', curveQuality: 64 };
    // placement, persisted in randr.toolbar:
    this.dock = 'left'; this.x = 80; this.y = 110;
    this.layout = [];
    this._nodes = {};   // id → wired button node (parked in #tool-store when off)
    this._store = null; // hidden parking lot that keeps handlers alive off the bar
    this._el = null;    // #tools
  }

  // Find the strip, restore saved placement + layout, park every managed node,
  // render the bar from layout, then wire drag/dock, the shell buttons, and the
  // customise modal. No-op if the markup isn't present.
  init({ mode = 'code', curveQuality = 64 } = {}) {
    const el = this.root.querySelector('#tools');
    const grip = this.root.querySelector('#tools-grip');
    if (!el || !grip) return;
    this._el = el;
    this._st = { mode, curveQuality };

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('randr.toolbar')); } catch { /* ignore */ }
    const tb = migrateToolbar(saved); // one place handles defaults, pruning, and version upgrades
    this.dock = tb.dock; this.x = tb.x; this.y = tb.y; this.layout = tb.layout;
    this._applyDock();

    // managed tool nodes → a hidden store; the bar is then rendered from layout.
    this._nodes = {};
    for (const t of TOOLBAR_TOOLS) {
      const n = this.root.querySelector('#' + t.id);
      if (n) this._nodes[t.id] = n;
    }
    const store = document.createElement('div');
    store.id = 'tool-store';
    store.style.display = 'none';
    el.appendChild(store);
    this._store = store;
    for (const id in this._nodes) store.appendChild(this._nodes[id]); // park; render places them

    this.render();

    this._wireDrag(el, grip);
    this._wireButtons();
    this._wireModal();
  }

  // Drag the strip by its grip → float + clamp to the viewport; on release snap
  // to the nearer side edge (left default) or stay floating. Persists placement.
  _wireDrag(el, grip) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
    const onMove = (e) => {
      moved = true;
      el.classList.remove('dock-left', 'dock-right'); el.classList.add('float');
      const r = el.getBoundingClientRect();
      const x = Math.max(6, Math.min(ox + e.clientX - sx, window.innerWidth - r.width - 6));
      const y = Math.max(52, Math.min(oy + e.clientY - sy, window.innerHeight - r.height - 6));
      el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.right = 'auto'; el.style.bottom = 'auto';
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) return;
      const r = el.getBoundingClientRect();
      if (r.left < 80) this.dock = 'left';
      else if (window.innerWidth - r.right < 80) this.dock = 'right';
      else { this.dock = 'float'; this.x = r.left; this.y = r.top; }
      this._applyDock();
      this._save();
    };
    grip.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; // let the ✎ customize button work
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; moved = false;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
    });
  }

  // The shell buttons whose behavior the toolbar owns. The rest of the tools
  // keep their App-bound handlers and are merely re-parented. Bound once on the
  // live nodes — the binding survives being moved into a group.
  _wireButtons() {
    this.root.querySelector('#tools-edit')?.addEventListener('click', () => this._openModal());
    this.root.querySelector('#v-quality')?.addEventListener('click', () => {
      const i = QUALITY_LEVELS.findIndex((q) => q.v === this._st.curveQuality);
      const next = QUALITY_LEVELS[(i + 1) % QUALITY_LEVELS.length];
      this.onQualityChange?.(next);
    });
    // Group toggles are delegated here (once) so render() doesn't re-bind a
    // listener per group on every layout change — it recreates the .tb-group
    // nodes each time. A group's toggle is the .rail-btn that's a direct child
    // of .tb-group (its menu-pop tools sit a level deeper).
    this.root.querySelector('#tools-body')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.rail-btn');
      if (btn && btn.parentElement?.classList.contains('tb-group')) {
        e.stopPropagation();
        toggleMenu(this.root, btn.parentElement);
      }
    });
  }

  // customise modal: close / reset / backdrop + delegated edit controls
  _wireModal() {
    this.root.querySelector('#toolbar-modal-close')?.addEventListener('click', () => this._hideModal());
    this.root.querySelector('#toolbar-reset')?.addEventListener('click', () => this._tbReset());
    const modal = this.root.querySelector('#toolbar-modal');
    modal?.addEventListener('mousedown', (e) => { if (e.target === modal) this._hideModal(); });
    const editBody = this.root.querySelector('#toolbar-edit-body');
    editBody?.addEventListener('change', (e) => {
      const s = e.target.closest('.tbm-place');
      if (s) this._tbPlace(s.dataset.id, s.value);
    });
    editBody?.addEventListener('input', (e) => {
      const nm = e.target.closest('.tbm-gname');
      if (nm) this._tbRenameGroup(+nm.dataset.gi, nm.value);
    });
    editBody?.addEventListener('click', (e) => {
      const mv = e.target.closest('[data-mv]');
      if (mv) { this._tbMove(+mv.dataset.i, mv.dataset.mv === 'up' ? -1 : 1); return; }
      const del = e.target.closest('.tbm-gdel');
      if (del) { this._tbDeleteGroup(+del.dataset.gi); return; }
      if (e.target.closest('.tbm-newgroup')) this._tbNewGroup();
    });
  }

  _applyDock() {
    const el = this._el;
    if (!el) return;
    el.classList.remove('dock-left', 'dock-right', 'float', 'dodge');
    if (this.dock === 'dodge') {
      // float, auto-placed opposite the parts card by CSS (.stage.cardleft/right)
      el.classList.add('float', 'dodge');
      el.style.left = el.style.top = el.style.right = el.style.bottom = '';
    } else if (this.dock === 'float') {
      el.classList.add('float');
      el.style.left = `${this.x}px`; el.style.top = `${this.y}px`; el.style.right = 'auto'; el.style.bottom = 'auto';
    } else {
      el.classList.add(this.dock === 'right' ? 'dock-right' : 'dock-left');
      el.style.left = el.style.top = el.style.right = el.style.bottom = '';
    }
  }

  _save() {
    try {
      localStorage.setItem('randr.toolbar', JSON.stringify({ version: TOOLBAR_VERSION, dock: this.dock, x: this.x, y: this.y, layout: this.layout }));
    } catch { /* quota */ }
  }

  // Render the strip from this.layout by re-parenting the wired tool nodes (their
  // click handlers survive the move). Unplaced tools stay parked in the hidden
  // store (= "off"). Groups reuse the .menu/.menu-pop pattern; App's global
  // document-click handler closes any open .menu.
  render() {
    const body = this.root.querySelector('#tools-body');
    const store = this._store;
    if (!body || !store) return;
    for (const id in this._nodes) store.appendChild(this._nodes[id]); // park everything first
    body.innerHTML = '';
    const place = (id, parent) => { const n = this._nodes[id]; if (n) parent.appendChild(n); };
    for (const entry of this.layout || []) {
      if (entry.type === 'group') {
        // Skip a group whose tools are all missing — otherwise opening it shows
        // a stranded empty menu box.
        const vis = (entry.items || []).filter((id) => this._nodes[id]);
        if (!vis.length) continue;
        const menu = document.createElement('div');
        menu.className = 'menu tb-group';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rail-btn';
        btn.textContent = entry.glyph || '⋯';
        btn.title = entry.label || 'Group';
        const pop = document.createElement('div');
        pop.className = 'menu-pop';
        for (const id of (entry.items || [])) place(id, pop);
        menu.append(btn, pop);
        body.appendChild(menu);
      } else {
        place(entry.id, body); // a top-level tool button
      }
    }
    this._reflect();
  }

  // App pushes the live mode + curve-quality in; reflect them on the buttons.
  syncState({ mode, curveQuality } = {}) {
    if (mode !== undefined) this._st.mode = mode;
    if (curveQuality !== undefined) this._st.curveQuality = curveQuality;
    this._reflect();
  }

  // Reflect curve quality (glyph/title) from the cached app state. Re-run after
  // every render since re-parenting clears nothing but re-runs cheaply, and after
  // each syncState. (code/build/result + the code panel live on the top bar now.)
  _reflect() {
    const q = this.root.querySelector('#v-quality');
    if (q) {
      const lvl = QUALITY_LEVELS.find((x) => x.v === this._st.curveQuality) || QUALITY_LEVELS[2];
      q.textContent = lvl.glyph;
      q.title = `Curve quality: ${lvl.name} — tap to cycle`;
    }
  }

  // --- customise modal (the ✎) ----------------------------------------------
  _showModal() { this.root.querySelector('#toolbar-modal')?.classList.remove('hidden'); }
  _hideModal() { this.root.querySelector('#toolbar-modal')?.classList.add('hidden'); }
  _openModal() { this._renderModal(); this._showModal(); }

  _tbTool(id) { return TOOLBAR_TOOLS.find((t) => t.id === id); }

  // re-render the bar, persist, and refresh the modal after any layout change
  _tbApply() { this.render(); this._save(); this._renderModal(); }

  _tbRemove(id) {
    const L = this.layout;
    for (let i = L.length - 1; i >= 0; i--) {
      if (L[i].type === 'group') L[i].items = (L[i].items || []).filter((x) => x !== id);
      else if (L[i].id === id) L.splice(i, 1);
    }
  }

  _tbPlace(id, dest) {
    this._tbRemove(id);
    if (dest === 'bar') {
      this.layout.push({ type: 'tool', id });
    } else if (dest && dest.startsWith('g:')) {
      const gid = dest.slice(2);
      const g = this.layout.find((e) => e.type === 'group' && e.gid === gid);
      if (g) (g.items = g.items || []).push(id);
    } // 'off' → just leave it removed
    this._tbApply();
  }

  _tbMove(i, dir) {
    const L = this.layout, j = i + dir;
    if (j < 0 || j >= L.length) return;
    [L[i], L[j]] = [L[j], L[i]];
    this._tbApply();
  }

  _tbNewGroup() {
    this.layout.push({ type: 'group', gid: 'g' + Date.now().toString(36), label: 'New group', glyph: '❏', items: [] });
    this._tbApply();
  }

  _tbRenameGroup(i, name) {
    const g = this.layout[i];
    if (g?.type === 'group') { g.label = name.trim() || 'Group'; this.render(); this._save(); }
  }

  _tbDeleteGroup(i) {
    const g = this.layout[i];
    if (g?.type === 'group') { this.layout.splice(i, 1); this._tbApply(); } // its tools drop to Off
  }

  _tbReset() {
    this.layout = JSON.parse(JSON.stringify(TOOLBAR_DEFAULT));
    this.dock = 'dodge'; this._applyDock(); // back to floating opposite the card
    this._tbApply();
  }

  _renderModal() {
    const body = this.root.querySelector('#toolbar-edit-body');
    if (!body) return;
    const L = this.layout;
    const groups = L.filter((e) => e.type === 'group');
    const sel = (id, current) => {
      const o = [`<option value="bar"${current === 'bar' ? ' selected' : ''}>Button</option>`];
      for (const g of groups) o.push(`<option value="g:${g.gid}"${current === 'g:' + g.gid ? ' selected' : ''}>In “${esc(g.label)}”</option>`);
      o.push(`<option value="off"${current === 'off' ? ' selected' : ''}>Off</option>`);
      return `<select class="tbm-place" data-id="${id}">${o.join('')}</select>`;
    };
    const row = (id, current) => {
      const t = this._tbTool(id) || { glyph: '?', label: id };
      return `<div class="tbm-row" data-id="${id}"><span class="tbm-ic">${t.glyph}</span><span class="tbm-lab">${esc(t.label)}</span>${sel(id, current)}</div>`;
    };
    let h = '<p class="tbm-hint">The bar floats opposite the parts panel by default — drag its ⠿ grip to move it (it snaps to a side); Reset returns it to floating. Set each tool as a button, put it in a menu group, or turn it off.</p>';
    h += '<div class="tbm-sec">On the bar</div><div class="tbm-list">';
    L.forEach((e, i) => {
      const mv = `<span class="tbm-mv"><button type="button" data-mv="up" data-i="${i}" title="Move up">↑</button><button type="button" data-mv="dn" data-i="${i}" title="Move down">↓</button></span>`;
      if (e.type === 'group') {
        h += `<div class="tbm-grp"><div class="tbm-grphead"><span class="tbm-gic">${e.glyph || '❏'}</span><input class="tbm-gname" data-gi="${i}" value="${esc(e.label)}" maxlength="20" spellcheck="false">${mv}<button type="button" class="tbm-gdel" data-gi="${i}" title="Delete group">✕</button></div><div class="tbm-grpitems">`;
        (e.items || []).forEach((id) => { h += row(id, 'g:' + e.gid); });
        if (!(e.items || []).length) h += `<div class="tbm-empty">empty — assign tools to “${esc(e.label)}” below</div>`;
        h += '</div></div>';
      } else {
        h += `<div class="tbm-toprow">${row(e.id, 'bar')}${mv}</div>`;
      }
    });
    h += '</div><button type="button" class="tbm-newgroup">＋ New group</button>';
    const placed = new Set();
    L.forEach((e) => { if (e.type === 'group') (e.items || []).forEach((x) => placed.add(x)); else placed.add(e.id); });
    const off = TOOLBAR_TOOLS.filter((t) => !placed.has(t.id));
    if (off.length) {
      h += '<div class="tbm-sec">Off — not on the bar</div><div class="tbm-list">';
      off.forEach((t) => { h += row(t.id, 'off'); });
      h += '</div>';
    }
    body.innerHTML = h;
  }
}
