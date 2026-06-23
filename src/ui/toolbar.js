// The left tool strip: a floating, dockable, user-customizable toolbar.
//
// The bar owns its own layout (which tools are standalone buttons, which live
// inside menu groups, and the order) plus where it sits (docked left/right or
// floating) — all persisted in localStorage under randr.toolbar. The actual
// tool *behaviors* stay in App: every managed button is a DOM node App wires
// once, and the toolbar only re-parents those nodes (appendChild) to arrange
// them, so their click handlers survive the move untouched. The three "shell"
// buttons whose behavior is the toolbar's own concern — mode (code/build),
// curve quality, and the code-panel toggle — fire back to App via callbacks.
//
// App owns the wiring:
//   this.toolbar = new Toolbar(root)
//   this.toolbar.onModeToggle / onPanelToggle / onQualityChange = …
//   this.toolbar.init({ mode, curveQuality })
//   this.toolbar.syncState({ mode, curveQuality })  // reflect app state on buttons

const _esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Curve-smoothness levels for the quality button — it cycles through these and
// shows the current fill level as its glyph. v is the segment count for round shapes.
export const QUALITY_LEVELS = [
  { v: 24,  name: 'Draft',    glyph: '◔' },
  { v: 48,  name: 'Standard', glyph: '◑' },
  { v: 64,  name: 'Smooth',   glyph: '◕' },
  { v: 128, name: 'Ultra',    glyph: '●' },
];

// Every tool that can live on the bar. A `tool` is a single icon button (its
// node is re-parented as-is); an `opener` is a whole compound .menu container
// moved intact.
const TOOLBAR_TOOLS = [
  { id: 'rail-home', glyph: '⌂', label: 'Home', cat: 'View' },
  { id: 'view-mode-toggle', glyph: '◧', label: 'Edit / Result', cat: 'View' },
  { id: 'v-grid', glyph: '▦', label: 'Grid', cat: 'View' },
  { id: 'v-snap', glyph: '⌗', label: 'Snap 1 mm', cat: 'View' },
  { id: 'v-theme', glyph: '◐', label: 'Light / dark', cat: 'View' },
  { id: 'v-mmgrid', glyph: '⊞', label: 'mm grid', cat: 'View' },
  { id: 'v-wire', glyph: '◇', label: 'Wireframe', cat: 'View' },
  { id: 'v-measure', glyph: '📏', label: 'Measure', cat: 'Inspect & print' },
  { id: 'v-layers', glyph: '≣', label: 'Layer preview', cat: 'Inspect & print' },
  { id: 'v-overhang', glyph: '◣', label: 'Overhang', cat: 'Inspect & print' },
  { id: 'v-orient', glyph: '⤓', label: 'Auto-orient', cat: 'Inspect & print' },
  { id: 'v-fit-plate', glyph: '⤡', label: 'Fit to plate', cat: 'Inspect & print' },
  { id: 'v-cut', glyph: '✂', label: 'Cut in half', cat: 'Inspect & print' },
  { id: 'mode-toggle', glyph: '⬓', label: 'Mode · code / build', cat: 'Mode' },
  { id: 'v-quality', glyph: '◕', label: 'Curve quality', cat: 'View' },
  { id: 'panel-toggle', glyph: '⌨', label: 'Code panel', cat: 'Mode' },
];
const TOOLBAR_DEFAULT = [
  { type: 'tool', id: 'rail-home' },
  { type: 'tool', id: 'view-mode-toggle' },
  { type: 'tool', id: 'v-grid' },
  { type: 'tool', id: 'v-snap' },
  { type: 'tool', id: 'v-theme' },
  { type: 'group', gid: 'g-more', label: 'More', glyph: '⋯', items: ['v-mmgrid', 'v-wire', 'v-measure', 'v-layers', 'v-overhang', 'v-orient', 'v-fit-plate', 'v-cut'] },
  { type: 'tool', id: 'mode-toggle' },
  { type: 'tool', id: 'v-quality' },
  { type: 'tool', id: 'panel-toggle' },
];

export class Toolbar {
  constructor(root) {
    this.root = root;
    // callbacks set by App (mirrors the Viewport.onSelect pattern):
    this.onModeToggle = null;    // mode button tapped (code ⇄ build)
    this.onPanelToggle = null;   // code-panel show/hide tapped
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
    this.dock = saved?.dock === 'right' || saved?.dock === 'float' ? saved.dock : 'left';
    this.x = Number.isFinite(saved?.x) ? saved.x : 80;
    this.y = Number.isFinite(saved?.y) ? saved.y : 110;
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
    this.root.querySelector('#tools-more')?.remove(); // legacy ⋯ husk — its tools are managed individually now

    this.layout = Array.isArray(saved?.layout) && saved.layout.length
      ? saved.layout
      : JSON.parse(JSON.stringify(TOOLBAR_DEFAULT));
    // drop tools that no longer exist (e.g. the removed Simple/Pro toggle)
    this.layout = this.layout
      .map((e) => (e.type === 'group' ? { ...e, items: (e.items || []).filter((id) => this._nodes[id]) } : e))
      .filter((e) => e.type === 'group' || !!this._nodes[e.id]);
    // migration: surface the mode toggle on older saved layouts
    if (!this._inLayout('mode-toggle') && this._nodes['mode-toggle']) {
      this.layout.push({ type: 'tool', id: 'mode-toggle' });
    }
    // migration: the ⚙ menu's controls are now plain buttons — surface them on
    // older saved layouts (the gear-menu opener is auto-pruned above as a non-tool)
    for (const id of ['v-quality', 'panel-toggle']) {
      if (this._nodes[id] && !this._inLayout(id)) this.layout.push({ type: 'tool', id });
    }
    this.render();

    this._wireDrag(el, grip);
    this._wireButtons();
    this._wireModal();
  }

  // is `id` placed anywhere in the layout (top-level or inside a group)?
  _inLayout(id) {
    return this.layout.some((e) => (e.type === 'group' ? (e.items || []).includes(id) : e.id === id));
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
    this.root.querySelector('#mode-toggle')?.addEventListener('click', () => this.onModeToggle?.());
    this.root.querySelector('#panel-toggle')?.addEventListener('click', () => this.onPanelToggle?.());
    this.root.querySelector('#v-quality')?.addEventListener('click', () => {
      const i = QUALITY_LEVELS.findIndex((q) => q.v === this._st.curveQuality);
      const next = QUALITY_LEVELS[(i + 1) % QUALITY_LEVELS.length];
      this.onQualityChange?.(next);
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
    el.classList.remove('dock-left', 'dock-right', 'float');
    if (this.dock === 'float') {
      el.classList.add('float');
      el.style.left = `${this.x}px`; el.style.top = `${this.y}px`; el.style.right = 'auto'; el.style.bottom = 'auto';
    } else {
      el.classList.add(this.dock === 'right' ? 'dock-right' : 'dock-left');
      el.style.left = el.style.top = el.style.right = el.style.bottom = '';
    }
  }

  _save() {
    try {
      localStorage.setItem('randr.toolbar', JSON.stringify({ dock: this.dock, x: this.x, y: this.y, layout: this.layout }));
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
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const was = menu.classList.contains('open');
          this.root.querySelectorAll('.menu.open').forEach((o) => o.classList.remove('open'));
          if (!was) menu.classList.add('open');
        });
      } else {
        place(entry.id, body); // 'tool' or 'opener'
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

  // Reflect mode (glyph/title) and curve quality (glyph/title) from the cached
  // app state, and the code-panel open-state read live from #panel (App's
  // element). Re-run after every render since re-parenting clears nothing but
  // re-runs cheaply, and after each syncState.
  _reflect() {
    const m = this.root.querySelector('#mode-toggle');
    if (m) {
      const code = this._st.mode === 'code';
      m.classList.toggle('on', code);
      m.textContent = code ? '⬒' : '⬓';
      m.title = code ? 'Code mode — tap for build' : 'Build mode — tap for code';
    }
    const p = this.root.querySelector('#panel-toggle');
    if (p) {
      const panel = this.root.querySelector('#panel');
      p.classList.toggle('on', !!panel && !panel.classList.contains('collapsed'));
      p.title = 'Code panel — show / hide';
    }
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
      const t = this._tbTool(id);
      this.layout.push({ type: t?.opener ? 'opener' : 'tool', id });
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

  _tbReset() { this.layout = JSON.parse(JSON.stringify(TOOLBAR_DEFAULT)); this._tbApply(); }

  _renderModal() {
    const body = this.root.querySelector('#toolbar-edit-body');
    if (!body) return;
    const L = this.layout;
    const groups = L.filter((e) => e.type === 'group');
    const sel = (id, current) => {
      const t = this._tbTool(id);
      const o = [`<option value="bar"${current === 'bar' ? ' selected' : ''}>Button</option>`];
      if (!t?.opener) for (const g of groups) o.push(`<option value="g:${g.gid}"${current === 'g:' + g.gid ? ' selected' : ''}>In “${_esc(g.label)}”</option>`);
      o.push(`<option value="off"${current === 'off' ? ' selected' : ''}>Off</option>`);
      return `<select class="tbm-place" data-id="${id}">${o.join('')}</select>`;
    };
    const row = (id, current) => {
      const t = this._tbTool(id) || { glyph: '?', label: id };
      return `<div class="tbm-row" data-id="${id}"><span class="tbm-ic">${t.glyph}</span><span class="tbm-lab">${_esc(t.label)}</span>${sel(id, current)}</div>`;
    };
    let h = '<p class="tbm-hint">Drag the toolbar by its ⠿ grip to move it (it snaps to a side). Set each tool as a button, put it in a menu group, or turn it off.</p>';
    h += '<div class="tbm-sec">On the bar</div><div class="tbm-list">';
    L.forEach((e, i) => {
      const mv = `<span class="tbm-mv"><button type="button" data-mv="up" data-i="${i}" title="Move up">↑</button><button type="button" data-mv="dn" data-i="${i}" title="Move down">↓</button></span>`;
      if (e.type === 'group') {
        h += `<div class="tbm-grp"><div class="tbm-grphead"><span class="tbm-gic">${e.glyph || '❏'}</span><input class="tbm-gname" data-gi="${i}" value="${_esc(e.label)}" maxlength="20" spellcheck="false">${mv}<button type="button" class="tbm-gdel" data-gi="${i}" title="Delete group">✕</button></div><div class="tbm-grpitems">`;
        (e.items || []).forEach((id) => { h += row(id, 'g:' + e.gid); });
        if (!(e.items || []).length) h += `<div class="tbm-empty">empty — assign tools to “${_esc(e.label)}” below</div>`;
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
