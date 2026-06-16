// Application controller. Ties the three surfaces together:
//   1. Code pane  — the parametric mini-language (OpenSCAD-style)
//   2. Build pane — touch primitives you place/drag on the workplane (Tinkercad)
//   3. Viewport   — the shared result of whichever pane is active
//
// Both panes ultimately produce mini-language source, so the kernel only ever
// sees one input format. The build pane is a structured editor that emits
// source; a touch-built model can be opened in the code pane and vice versa.

import { loadKernel, inspect, box, cylinder, sphere, cone, roundedBox } from '../kernel/manifold.js';
import { manifoldToGeometry } from '../kernel/mesh.js';
import { compile } from '../lang/compile.js';
import { exportSTL, exportOBJ, export3MF, triggerDownload } from '../kernel/export.js';
import { Viewport } from './viewport.js';
import { buildTreeToSource, BuildTree, setNodeKind } from './buildtree.js';

// Build one shape's geometry (centered, kernel-accurate) for the editable
// build-mode view. The manifold is freed immediately after meshing.
function nodeToGeometry(node) {
  const f = (k) => { const x = node.fields.find((y) => y.key === k); return x ? x.value : 0; };
  let m;
  try {
    switch (node.kind) {
      case 'box':        m = box(f('x'), f('y'), f('z')); break;
      case 'cylinder':   m = cylinder(f('h'), f('r')); break;
      case 'sphere':     m = sphere(f('r')); break;
      case 'cone':       m = cone(f('h'), f('r1'), f('r2')); break;
      case 'roundedBox': m = roundedBox(f('x'), f('y'), f('z'), f('r')); break;
      default: return null;
    }
    const g = manifoldToGeometry(m);
    m.delete();
    return g;
  } catch (e) {
    if (m) try { m.delete(); } catch { /* freed */ }
    return null;
  }
}

const STARTER = `// Forge — parametric mode.
// Edit values or drag the sliders. Everything is millimetres.

param width     = 60;
param depth     = 40;
param height    = 20;
param wall      = 3;
param holeR     = 4;

difference() {
  roundedBox(width, depth, height, 4);
  // hollow it out
  translate([0, 0, wall]) {
    roundedBox(width - 2*wall, depth - 2*wall, height, 3);
  }
  // mounting holes
  translate([ width/2 - 8,  depth/2 - 8, 0]) cylinder(height + 2, holeR);
  translate([-width/2 + 8,  depth/2 - 8, 0]) cylinder(height + 2, holeR);
  translate([ width/2 - 8, -depth/2 + 8, 0]) cylinder(height + 2, holeR);
  translate([-width/2 + 8, -depth/2 + 8, 0]) cylinder(height + 2, holeR);
}
`;

export class App {
  constructor(root) {
    this.root = root;
    this.mode = 'code';            // 'code' | 'build'
    this.source = STARTER;
    this.overrides = {};
    this.params = [];
    this.currentModel = null;
    this.buildTree = new BuildTree();
    this.selectedNode = -1;
    this._recompileTimer = null;
  }

  async start() {
    this._render();
    await loadKernel();
    this.viewport = new Viewport(this.root.querySelector('#viewport-canvas'));
    this.viewport.onSelect = (i) => this._selectNode(i);
    this.viewport.onShapeMove = (i, pos) => this._onShapeMove(i, pos);
    this.viewport.onShapeMoveEnd = (i, pos) => this._onShapeMoveEnd(i, pos);
    this.viewport.onTransform = (i, t) => this._onTransform(i, t);
    this.viewport.onTransformEnd = (i) => this._onTransformEnd(i);
    window.__forgeExport = { exportSTL, export3MF, exportOBJ }; // scripting/test hook
    window.__dbg = { src: () => buildTreeToSource(this.buildTree), compile }; // debug
    this._bindEvents();
    this.recompile(true);
    this.root.querySelector('#boot').classList.add('gone');
  }

  // --- compile + render loop ------------------------------------------------

  recompile(frame = false) {
    const source = this.mode === 'build'
      ? buildTreeToSource(this.buildTree)
      : this.source;

    const { result, params, error } = compile(source, this.overrides);

    const errEl = this.root.querySelector('#error');
    if (error) {
      errEl.textContent = error;
      errEl.classList.add('show');
      this._setStatus('error');
      return;
    }
    errEl.classList.remove('show');

    // Replace the merged model and free the previous one.
    if (this.currentModel && this.currentModel !== result) {
      try { this.currentModel.delete(); } catch { /* freed */ }
    }
    this.currentModel = result;

    // Build mode shows individual shapes; code mode shows the merged solid.
    if (this.mode === 'build') {
      this.viewport.setEditMode(true);
      this._renderEditShapes();
    } else {
      this.viewport.setEditMode(false);
      this.viewport.setModel(result || null);
    }

    if (result) {
      const info = inspect(result);
      if (frame) this.viewport.frameModel({
        x: info.bbox.size[0], y: info.bbox.size[2], z: info.bbox.size[1],
      });
      this._updateHUD(info);
      this._setStatus('ok');
    } else {
      this._updateHUD(null);
      this._setStatus('empty');
    }

    // Sync params only in code mode (build mode manages its own controls).
    if (this.mode === 'code') {
      this.params = params;
      this._renderParams();
    }
  }

  _scheduleRecompile() {
    clearTimeout(this._recompileTimer);
    this._setStatus('working');
    this._recompileTimer = setTimeout(() => this.recompile(), 180);
  }

  // --- build-mode editing ---------------------------------------------------

  _renderEditShapes() {
    const items = this.buildTree.nodes
      .map((node, index) => (node.hidden ? null : {
        index, geometry: nodeToGeometry(node),
        pos: node.pos, rot: node.rot || [0, 0, 0], scale: node.scale || [1, 1, 1], op: node.op,
        color: node.color, lock: node.locked,
      }))
      .filter((it) => it && it.geometry);
    this.viewport.setEditShapes(items);
    if (this.selectedNode >= 0 && this.selectedNode < this.buildTree.nodes.length) {
      this.viewport.selectIndex(this.selectedNode);
      this._highlightBuildRow(this.selectedNode);
    } else {
      this.selectedNode = -1;
    }
  }

  _selectNode(i) {
    this.selectedNode = i;
    this.viewport.selectIndex(i);
    this._highlightBuildRow(i);
  }

  _highlightBuildRow(i) {
    this.root.querySelectorAll('.build-node').forEach((r) =>
      r.classList.toggle('sel', Number(r.dataset.node) === i));
  }

  // live during a drag: move the shape + reflect in the panel, no recompile
  _onShapeMove(i, pos) {
    const n = this.buildTree.nodes[i];
    if (!n) return;
    n.pos = pos;
    const host = this.root.querySelector('#build-list');
    if (host) ['0', '1', '2'].forEach((a) => {
      const el = host.querySelector(`input[data-pos="${i}:${a}"]`);
      if (el && document.activeElement !== el) el.value = pos[Number(a)];
    });
  }

  // drag finished: settle the merged solid + HUD (export needs it current)
  _onShapeMoveEnd(i, pos) {
    const n = this.buildTree.nodes[i];
    if (!n) return;
    n.pos = pos;
    this._recompileMergedHUD();
  }

  // gizmo drag: live pos/rot/scale into the node + panel (no recompile yet).
  // Round to kill float noise (e.g. -1.8e-15) so the emitted source stays clean.
  _onTransform(i, t) {
    const n = this.buildTree.nodes[i];
    if (!n) return;
    const r = (v, p) => { const x = Math.round(v * 10 ** p) / 10 ** p; return x === 0 ? 0 : x; };
    n.pos = t.pos.map((v) => r(v, 2));
    n.rot = t.rot.map((v) => r(v, 2));
    n.scale = t.scale.map((v) => r(v, 3));
    const host = this.root.querySelector('#build-list');
    if (!host) return;
    const set = (sel, v) => { const el = host.querySelector(sel); if (el && document.activeElement !== el) el.value = v; };
    ['0', '1', '2'].forEach((a) => {
      set(`input[data-pos="${i}:${a}"]`, n.pos[+a]);
      set(`input[data-rot="${i}:${a}"]`, n.rot[+a]);
    });
  }

  _onTransformEnd() { this._recompileMergedHUD(); }

  _setXform(mode) {
    this.viewport.setTransformMode(mode);
    this.root.querySelectorAll('[data-xform]').forEach((x) => x.classList.toggle('on', x.dataset.xform === mode));
  }

  // recompute the merged solid for HUD/export without rebuilding edit meshes
  _recompileMergedHUD() {
    const { result, error } = compile(buildTreeToSource(this.buildTree), {});
    const errEl = this.root.querySelector('#error');
    if (error) { errEl.textContent = error; errEl.classList.add('show'); this._setStatus('error'); return; }
    errEl.classList.remove('show');
    if (this.currentModel && this.currentModel !== result) {
      try { this.currentModel.delete(); } catch { /* freed */ }
    }
    this.currentModel = result;
    if (result) { this._updateHUD(inspect(result)); this._setStatus('ok'); }
    else { this._updateHUD(null); this._setStatus('empty'); }
  }

  // --- HUD + status ---------------------------------------------------------

  _updateHUD(info) {
    const dims = this.root.querySelector('#hud-dims');
    const vol = this.root.querySelector('#hud-vol');
    const tris = this.root.querySelector('#hud-tris');
    const wt = this.root.querySelector('#hud-watertight');
    if (!info) {
      dims.textContent = vol.textContent = tris.textContent = '—';
      wt.textContent = '—'; wt.className = 'hud-ok';
      return;
    }
    const [x, y, z] = info.bbox.size;
    const fmt = (n) => n.toFixed(1);
    dims.textContent = `${fmt(x)} × ${fmt(y)} × ${fmt(z)} mm`;
    vol.textContent = `${(info.volume / 1000).toFixed(2)} cm³`;
    tris.textContent = `${info.triangles.toLocaleString()} tris`;
    // manifold-3d output is watertight by construction (any component count),
    // so a valid result is always print-safe. genus is shown for info only.
    wt.textContent = info.genus > 0 ? `manifold ✓ · genus ${info.genus}` : 'manifold ✓';
    wt.className = 'hud-ok';
  }

  _setStatus(state) {
    const dot = this.root.querySelector('#status-dot');
    const label = this.root.querySelector('#status-label');
    const map = {
      ok: ['ready', 'state-ok'],
      working: ['building…', 'state-working'],
      error: ['error', 'state-error'],
      empty: ['empty', 'state-empty'],
    };
    const [text, cls] = map[state] || map.empty;
    dot.className = 'status-dot ' + cls;
    label.textContent = text;
  }

  // --- parameter sliders ----------------------------------------------------

  _renderParams() {
    const host = this.root.querySelector('#params');
    if (this.params.length === 0) {
      host.innerHTML = '<p class="muted">No params in this model. Add <code>param name = value;</code> to get a slider.</p>';
      return;
    }
    host.innerHTML = '';
    for (const p of this.params) {
      const wrap = document.createElement('div');
      wrap.className = 'param';
      const value = this.overrides[p.name] ?? p.value;
      const lo = Math.min(0, value);
      const hi = Math.max(value * 2 || 1, value + 10);
      wrap.innerHTML = `
        <div class="param-head">
          <label>${p.name}</label>
          <input type="number" step="0.1" value="${value}" data-num="${p.name}" />
        </div>
        <input type="range" min="${lo}" max="${hi}" step="0.1"
               value="${value}" data-range="${p.name}" />`;
      host.appendChild(wrap);
    }

    host.querySelectorAll('input[data-range]').forEach((el) => {
      el.addEventListener('input', () => {
        const name = el.dataset.range;
        this.overrides[name] = parseFloat(el.value);
        host.querySelector(`input[data-num="${name}"]`).value = el.value;
        this._scheduleRecompile();
      });
    });
    host.querySelectorAll('input[data-num]').forEach((el) => {
      el.addEventListener('input', () => {
        const name = el.dataset.num;
        this.overrides[name] = parseFloat(el.value);
        const range = host.querySelector(`input[data-range="${name}"]`);
        if (range) range.value = el.value;
        this._scheduleRecompile();
      });
    });
  }

  // --- events ---------------------------------------------------------------

  _bindEvents() {
    const $ = (s) => this.root.querySelector(s);

    // editor
    const editor = $('#editor');
    editor.value = this.source;
    editor.addEventListener('input', () => {
      this.source = editor.value;
      this.overrides = {}; // editing code resets param overrides
      this._scheduleRecompile();
    });

    // mode tabs (also open the panel so the tools are visible)
    this.root.querySelectorAll('[data-mode]').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.mode = tab.dataset.mode;
        this.root.querySelectorAll('[data-mode]').forEach((t) => t.classList.toggle('active', t === tab));
        $('#pane-code').classList.toggle('hidden', this.mode !== 'code');
        $('#pane-build').classList.toggle('hidden', this.mode !== 'build');
        this._setPanel(true);
        this.overrides = {};
        this.recompile(true);
      });
    });

    // collapsible panel
    $('#panel-toggle').addEventListener('click', () => this._setPanel());

    // export dropdown
    const menu = $('#export-menu');
    $('#export-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
    const out = (fn, name) => { if (this.currentModel) triggerDownload(fn(this.currentModel), name); menu.classList.remove('open'); };
    $('#btn-stl').addEventListener('click', () => out(exportSTL, 'part.stl'));
    $('#btn-3mf').addEventListener('click', () => out(export3MF, 'part.3mf'));
    $('#btn-obj').addEventListener('click', () => out(exportOBJ, 'part.obj'));
    document.addEventListener('click', () => menu.classList.remove('open'));

    // view controls
    $('#v-fit').addEventListener('click', () => this.viewport.fitView());
    $('#v-top').addEventListener('click', () => this.viewport.setView('top'));
    $('#v-front').addEventListener('click', () => this.viewport.setView('front'));
    $('#v-grid').addEventListener('click', (e) => e.currentTarget.classList.toggle('on', this.viewport.toggleGrid()));
    $('#v-wire').addEventListener('click', (e) => e.currentTarget.classList.toggle('on', this.viewport.toggleWireframe()));

    // HUD collapse
    $('#hud-toggle').addEventListener('click', () => $('#hud').classList.toggle('collapsed'));

    // transform-mode toolbar (gizmo)
    this.root.querySelectorAll('[data-xform]').forEach((b) =>
      b.addEventListener('click', () => this._setXform(b.dataset.xform)));

    // build pane
    this._bindBuildPane();

    // keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (typing) return;
      const k = e.key.toLowerCase();
      if (k === 'f') { this.viewport.fitView(); return; }
      if (k === 'g') { $('#v-grid').classList.toggle('on', this.viewport.toggleGrid()); return; }
      if (this.mode === 'build' && 'wer'.includes(k) && !e.ctrlKey && !e.metaKey) {
        this._setXform({ w: 'translate', e: 'rotate', r: 'scale' }[k]); return;
      }
      if (this.mode === 'build' && this.selectedNode >= 0) {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this._deleteNode(this.selectedNode); }
        else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this._duplicateNode(this.selectedNode); }
      }
    });
  }

  // Open/close the left drawer. _setPanel() toggles; _setPanel(true|false) forces.
  _setPanel(open) {
    const panel = this.root.querySelector('#panel');
    const collapse = open === undefined ? !panel.classList.contains('collapsed') : !open;
    panel.classList.toggle('collapsed', collapse);
    this.root.querySelector('#panel-toggle').classList.toggle('on', !collapse);
  }

  _bindBuildPane() {
    this.root.querySelectorAll('[data-add]').forEach((b) =>
      b.addEventListener('click', () => this._addShape(b.dataset.add)));
    this._renderBuildTree();
  }

  _addShape(kind) {
    this.buildTree.add(kind);
    this.selectedNode = this.buildTree.nodes.length - 1;
    this._renderBuildTree();
    this.recompile();
  }

  _deleteNode(i) {
    this.buildTree.nodes.splice(i, 1);
    this.selectedNode = -1;
    this._renderBuildTree();
    this.recompile();
  }

  _duplicateNode(i) {
    const src = this.buildTree.nodes[i];
    if (!src) return;
    const copy = {
      kind: src.kind,
      op: src.op,
      pos: [src.pos[0] + 6, src.pos[1] + 6, src.pos[2]],
      rot: [...(src.rot || [0, 0, 0])],
      fields: src.fields.map((f) => ({ ...f })),
    };
    this.buildTree.nodes.splice(i + 1, 0, copy);
    this.selectedNode = i + 1;
    this._renderBuildTree();
    this.recompile();
  }

  _renderBuildTree() {
    const host = this.root.querySelector('#build-list');
    host.innerHTML = '';
    if (this.buildTree.nodes.length === 0) {
      host.innerHTML = '<p class="muted">Tap a shape above to add it. Click a shape in the scene and drag it on the plate. Mark each one solid or hole, then export.</p>';
      return;
    }
    const KINDS = ['box', 'cylinder', 'sphere', 'cone', 'roundedBox'];
    const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    this.buildTree.nodes.forEach((node, idx) => {
      const row = document.createElement('div');
      row.className = 'build-node'
        + (node.op === 'hole' ? ' is-hole' : '')
        + (idx === this.selectedNode ? ' sel' : '')
        + (node.hidden ? ' is-hidden' : '');
      row.dataset.node = idx;
      const dims = node.fields.map((f) =>
        `<label>${f.label}<input type="number" step="0.5" value="${f.value}" data-field="${idx}:${f.key}"></label>`).join('');
      row.innerHTML = `
        <div class="bn-head">
          <select class="bn-type" data-type="${idx}" title="Shape type">
            ${KINDS.map((k) => `<option value="${k}" ${k === node.kind ? 'selected' : ''}>${k === 'roundedBox' ? 'rounded' : k}</option>`).join('')}
          </select>
          <input type="color" class="bn-color" data-color="${idx}" value="${hex(node.color)}" title="Colour" ${node.op === 'hole' ? 'disabled' : ''}>
          <div class="bn-ops">
            <button class="bn-op ${node.op}" data-op="${idx}" title="Toggle solid / hole">${node.op}</button>
            <button class="bn-ic ${node.locked ? 'on' : ''}" data-lock="${idx}" title="Lock position">${node.locked ? '🔒' : '🔓'}</button>
            <button class="bn-ic" data-hide="${idx}" title="${node.hidden ? 'Show' : 'Hide'}">${node.hidden ? '🚫' : '👁'}</button>
            <button class="bn-ic bn-del" data-del="${idx}" title="Delete">✕</button>
          </div>
        </div>
        <div class="bn-fields">${dims}</div>
        <div class="bn-fields bn-xyz">
          <label>x<input type="number" step="0.5" value="${node.pos[0]}" data-pos="${idx}:0"></label>
          <label>y<input type="number" step="0.5" value="${node.pos[1]}" data-pos="${idx}:1"></label>
          <label>z<input type="number" step="0.5" value="${node.pos[2]}" data-pos="${idx}:2"></label>
          <label>rx<input type="number" step="15" value="${node.rot[0]}" data-rot="${idx}:0"></label>
          <label>ry<input type="number" step="15" value="${node.rot[1]}" data-rot="${idx}:1"></label>
          <label>rz<input type="number" step="15" value="${node.rot[2]}" data-rot="${idx}:2"></label>
        </div>`;
      row.addEventListener('mousedown', (e) => {
        if (e.target.closest('input, button, select')) return;
        this._selectNode(idx);
      });
      host.appendChild(row);
    });

    const nodes = this.buildTree.nodes;
    host.querySelectorAll('[data-type]').forEach((el) => el.addEventListener('change', () => {
      setNodeKind(nodes[+el.dataset.type], el.value); this._renderBuildTree(); this.recompile();
    }));
    host.querySelectorAll('[data-color]').forEach((el) => el.addEventListener('input', () => {
      nodes[+el.dataset.color].color = parseInt(el.value.slice(1), 16); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-op]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.op]; n.op = n.op === 'hole' ? 'solid' : 'hole'; this._renderBuildTree(); this.recompile();
    }));
    host.querySelectorAll('[data-lock]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.lock]; n.locked = !n.locked; this._renderBuildTree(); this.recompile();
    }));
    host.querySelectorAll('[data-hide]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.hide]; n.hidden = !n.hidden; this._renderBuildTree(); this.recompile();
    }));
    host.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => this._deleteNode(+el.dataset.del)));
    host.querySelectorAll('[data-field]').forEach((el) => el.addEventListener('input', () => {
      const [i, key] = el.dataset.field.split(':');
      nodes[+i].fields.find((f) => f.key === key).value = parseFloat(el.value);
      this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-pos]').forEach((el) => el.addEventListener('input', () => {
      const [i, a] = el.dataset.pos.split(':'); nodes[+i].pos[+a] = parseFloat(el.value); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-rot]').forEach((el) => el.addEventListener('input', () => {
      const [i, a] = el.dataset.rot.split(':'); nodes[+i].rot[+a] = parseFloat(el.value); this._scheduleRecompile();
    }));
  }

  // --- markup ---------------------------------------------------------------

  _render() {
    this.root.innerHTML = `
      <div id="boot"><div class="boot-inner"><span class="boot-mark">◆</span><p>loading kernel…</p></div></div>

      <div class="stage">
        <canvas id="viewport-canvas"></canvas>

        <header class="topbar">
          <button class="icon-btn on" id="panel-toggle" title="Toggle panel">☰</button>
          <div class="brand"><span class="brand-mark">◆</span> FORGE <em>cad</em></div>
          <div class="tabs">
            <button data-mode="code" class="active">code</button>
            <button data-mode="build">build</button>
          </div>
          <div class="spacer"></div>
          <div class="viewtools">
            <button class="icon-btn" id="v-fit" title="Fit to view (F)">⤢</button>
            <button class="icon-btn" id="v-top" title="Top view">⊟</button>
            <button class="icon-btn" id="v-front" title="Front view">⊡</button>
            <button class="icon-btn on" id="v-grid" title="Toggle grid (G)">▦</button>
            <button class="icon-btn" id="v-wire" title="Toggle wireframe">◇</button>
          </div>
          <div class="menu" id="export-menu">
            <button class="exp" id="export-btn">⤓ Export ▾</button>
            <div class="menu-pop">
              <button id="btn-stl">STL — for slicing</button>
              <button id="btn-3mf">3MF — units, best</button>
              <button id="btn-obj">OBJ — mesh</button>
            </div>
          </div>
        </header>

        <aside class="panel" id="panel">
          <section id="pane-code" class="pane">
            <div class="pane-title">model source</div>
            <textarea id="editor" spellcheck="false"></textarea>
            <div id="error" class="error"></div>
            <div class="pane-title">parameters</div>
            <div id="params" class="params"></div>
          </section>

          <section id="pane-build" class="pane hidden">
            <div class="xform" id="xform">
              <button data-xform="translate" class="on" title="Move (W)">↔ move</button>
              <button data-xform="rotate" title="Rotate (E)">⟳ turn</button>
              <button data-xform="scale" title="Scale (R)">⤢ size</button>
            </div>
            <div class="pane-title">add shape</div>
            <div class="add-row">
              <button data-add="box">box</button>
              <button data-add="cylinder">cylinder</button>
              <button data-add="sphere">sphere</button>
              <button data-add="cone">cone</button>
              <button data-add="roundedBox">rounded</button>
            </div>
            <p class="hint">Click a shape to select · drag it on the plate to move · <b>Del</b> remove · <b>Ctrl+D</b> duplicate</p>
            <div class="pane-title">parts</div>
            <div id="build-list" class="build-list"></div>
          </section>
        </aside>

        <div class="hud" id="hud">
          <div class="hud-head">
            <span class="hud-title">readout</span>
            <button class="hud-x" id="hud-toggle" title="Collapse">⌄</button>
          </div>
          <div class="hud-body">
            <div class="hud-row"><span class="hud-key">size</span><span id="hud-dims">—</span></div>
            <div class="hud-row"><span class="hud-key">volume</span><span id="hud-vol">—</span></div>
            <div class="hud-row"><span class="hud-key">mesh</span><span id="hud-tris">—</span></div>
            <div class="hud-row"><span class="hud-key">state</span><span id="hud-watertight" class="hud-ok">—</span></div>
          </div>
        </div>

        <div class="status">
          <span id="status-dot" class="status-dot state-empty"></span>
          <span id="status-label">empty</span>
        </div>
      </div>`;
  }
}
