// Application controller. Ties the three surfaces together:
//   1. Code pane  — the parametric mini-language (OpenSCAD-style)
//   2. Build pane — touch primitives you place/drag on the workplane (Tinkercad)
//   3. Viewport   — the shared result of whichever pane is active
//
// Both panes ultimately produce mini-language source, so the kernel only ever
// sees one input format. The build pane is a structured editor that emits
// source; a touch-built model can be opened in the code pane and vice versa.

import { loadKernel, inspect, box, cylinder, sphere, cone, pyramid, torus, wedge, dome, slot, star, roundedBox, roundedCylinder, chamferedBox, chamferedCylinder, tube, prism, text, thread, bolt, nut, meshSolid, importSTL, importOBJ, registerSolid, imported, solidMesh, setCurveQuality } from '../kernel/manifold.js';
import { manifoldToGeometry } from '../kernel/mesh.js';
import { compile } from '../lang/compile.js';
import { exportSTL, exportOBJ, export3MF, export3MFColored, triggerDownload } from '../kernel/export.js';
import { Viewport, BUILD_VOLUME } from './viewport.js';
import { buildTreeToSource, buildColoredParts, effField, supportsClearance, isShellable, supportsFillet, isFastener, applyMetricSize, currentMetricSize, METRIC_SIZES, BuildTree, setNodeKind } from './buildtree.js';
import { sourceToNodes } from './importBuild.js';
import { RECIPES } from './recipes.js';
import gcodeHelp from '../help/gcode.md?raw';
import * as Projects from './projects.js';

// --- code-editor syntax highlighting ---------------------------------------
// Tokenise the mini-language for a colour layer behind the textarea. Keeps
// comments + whitespace (the real tokenizer drops them), so it can't reuse it.
const HL_KEYWORDS = new Set(['param', 'true', 'false', 'PI']);
const HL_FUNCS = new Set([
  'box', 'cube', 'cylinder', 'sphere', 'cone', 'pyramid', 'torus', 'wedge',
  'dome', 'slot', 'star', 'roundedBox', 'roundedCylinder', 'chamferedBox',
  'chamferedCylinder', 'tube', 'prism', 'text', 'thread', 'bolt', 'nut', 'imported',
  'extrude', 'revolve', 'translate', 'rotate', 'scale', 'mirror',
  'union', 'difference', 'intersection', 'hull',
  'sin', 'cos', 'tan', 'sqrt', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'pow',
]);
function hlEscape(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function highlightCode(src) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|((?:\d[\d.]*(?:[eE][+-]?\d+)?(?:mm|cm|deg|rad)?)|\.\d+)|([A-Za-z_]\w*)|([+\-*/%=<>!]+)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += hlEscape(src.slice(last, m.index));
    const t = m[0];
    let cls = '';
    if (m[1]) cls = 'c';            // comment
    else if (m[2]) cls = 's';       // string
    else if (m[3]) cls = 'n';       // number
    else if (m[4]) cls = HL_KEYWORDS.has(t) ? 'k' : (HL_FUNCS.has(t) ? 'f' : ''); // keyword / function
    else if (m[5]) cls = 'o';       // operator
    out += cls ? `<span class="hl-${cls}">${hlEscape(t)}</span>` : hlEscape(t);
    last = m.index + t.length;
  }
  out += hlEscape(src.slice(last));
  return out;
}

// Tiny markdown -> HTML for the help modal (headings, lists, bold, `code`, hr).
function mdToHtml(md) {
  const inline = (s) => hlEscape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  let html = '', list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, ''), t = line.trim();
    let m;
    if (/^---+$/.test(t)) { close(); html += '<hr>'; }
    else if ((m = t.match(/^(#{1,6})\s+(.*)/))) { close(); const l = m[1].length; html += `<h${l}>${inline(m[2])}</h${l}>`; }
    else if ((m = line.match(/^(\s*)\d+\.\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[2])}</li>`; }
    else if ((m = line.match(/^(\s*)[-*]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[2])}</li>`; }
    else if (t === '') { close(); }
    else { close(); html += `<p>${inline(t)}</p>`; }
  }
  close();
  return html;
}

// Build one shape's geometry (centered, kernel-accurate) for the editable
// build-mode view. The manifold is freed immediately after meshing.
function nodeToGeometry(node) {
  const f = (k) => effField(node, k);
  let m;
  try {
    switch (node.kind) {
      case 'box':        m = box(f('x'), f('y'), f('z')); break;
      case 'cylinder':   m = cylinder(f('h'), f('r')); break;
      case 'sphere':     m = sphere(f('r')); break;
      case 'cone':       m = cone(f('h'), f('r1'), f('r2')); break;
      case 'pyramid':    m = pyramid(f('h'), f('r')); break;
      case 'torus':      m = torus(f('radius'), f('tube')); break;
      case 'wedge':      m = wedge(f('w'), f('d'), f('h')); break;
      case 'dome':       m = dome(f('r')); break;
      case 'slot':       m = slot(f('length'), f('r'), f('h')); break;
      case 'star':       m = star(f('points'), f('outer'), f('inner'), f('h')); break;
      case 'roundedBox': m = roundedBox(f('x'), f('y'), f('z'), f('r')); break;
      case 'roundedCylinder': m = roundedCylinder(f('h'), f('r'), f('fillet')); break;
      case 'chamferedBox': m = chamferedBox(f('x'), f('y'), f('z'), f('c')); break;
      case 'chamferedCylinder': m = chamferedCylinder(f('h'), f('r'), f('chamfer')); break;
      case 'tube':       m = tube(f('h'), f('router'), f('rinner')); break;
      case 'prism':      m = prism(f('h'), f('r'), f('sides')); break;
      case 'text':       m = text(f('str'), f('size'), f('height')); break;
      case 'imported':   m = imported(node.meshId || ''); break;
      case 'thread':     m = thread(f('length'), f('pitch'), f('d'), 0.61 * f('pitch')); break;
      case 'bolt':       m = bolt(f('d'), f('pitch'), f('length'), f('headAF'), f('headH')); break;
      case 'nut':        m = nut(f('d'), f('pitch'), f('thickness'), f('af')); break;
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

// Ready-made parametric starters (loaded into the code pane). All flat-bottomed
// and print-safe on the A1 mini.
const TEMPLATES = {
  'soap dish': `// Soap dish with drainage
param w = 100; param d = 70; param h = 22; param wall = 3; param holeR = 3;
difference() {
  box(w, d, h);
  translate([0, 0, wall]) { box(w - 2*wall, d - 2*wall, h); }
  translate([-24, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
  translate([-12, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
  translate([0, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
  translate([12, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
  translate([24, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
}
`,
  'pen cup': `// Pen / tool cup
param w = 70; param d = 70; param h = 90; param wall = 2.5;
difference() {
  box(w, d, h);
  translate([0, 0, wall]) box(w - 2*wall, d - 2*wall, h);
}
`,
  'coaster': `// Coaster with rim
param r = 45; param h = 6; param wall = 3;
difference() {
  cylinder(h, r);
  translate([0, 0, wall]) cylinder(h, r - wall);
}
`,
  'stacking bin': `// Stacking bin
param w = 60; param d = 42; param h = 45; param wall = 2;
difference() {
  box(w, d, h);
  translate([0, 0, wall + 1]) box(w - 2*wall, d - 2*wall, h);
}
`,
  'bolt & nut': `// Threaded bolt with a matching nut (coarse, printable)
param d = 16; param pitch = 2.5;
bolt(d, pitch, 20, 24, 10);
translate([34, 0, 0]) nut(d, pitch, 12, 24);
`,
  'washer': `// Washer
tube(2.5, 11, 5.5);
`,
  'L-bracket': `// L-bracket with mounting holes
param t = 4; param w = 32; param d = 24; param h = 28; param hole = 4;
difference() {
  union() {
    translate([0, 0, t/2]) box(w, d, t);
    translate([-w/2 + t/2, 0, h/2]) box(t, d, h);
  }
  translate([w/4, 0, t/2]) cylinder(t + 2, hole/2);
  translate([-w/2 + t/2, 0, h*0.7]) rotate([0, 90, 0]) cylinder(t + 6, hole/2);
}
`,
  'knob': `// Stacked rounded knob
union() {
  roundedCylinder(6, 16, 4);
  translate([0, 0, 6]) roundedCylinder(10, 11, 4);
}
`,
};

export class App {
  constructor(root) {
    this.root = root;
    this.mode = 'code';            // 'code' | 'build'
    this.source = STARTER;
    this.overrides = {};
    this.params = [];
    this.currentModel = null;
    this.printRot = [0, 0, 0]; // print orientation (deg) wrapped around the model at compile
    this.printScale = 1; // uniform scale-to-fit wrapped around the model at compile (1 = none)
    this.buildTree = new BuildTree();
    this.selectedNode = -1;
    this.selectedNodes = [];
    this.workplane = null; // {origin,normal,rot} build frame, or null for ground
    this.viewMode = 'edit'; // build view: 'edit' (parts + ghost) | 'result' (combined solid)
    this.multiSelect = false; // sticky additive selection (touch-friendly — taps add to the selection)
    this._layerMode = false;  // layer-preview (slice) view active
    this.project = null;    // current saved project meta {id,name,created,modified,seconds} or null
    this._workSeconds = 0;  // accumulated active-edit time for the current project
    this._recompileTimer = null;
    this.history = [];
    this.histIdx = -1;
    this._restoring = false;
  }

  async start() {
    this._render();
    await loadKernel();
    this.viewport = new Viewport(this.root.querySelector('#viewport-canvas'));
    this.viewport.onSelect = (i, additive) => this._selectNode(i, additive);
    this.viewport.onContext = (i, x, y) => this._showContextMenu(i, x, y);
    this.viewport.onShapeMove = (i, pos) => this._onShapeMove(i, pos);
    this.viewport.onShapeMoveEnd = (i, pos) => this._onShapeMoveEnd(i, pos);
    this.viewport.onTransform = (i, t) => this._onTransform(i, t);
    this.viewport.onTransformEnd = (i) => this._onTransformEnd(i);
    window.__forgeExport = { exportSTL, export3MF, export3MFColored, exportOBJ, build3MF: () => this._build3MF() }; // scripting/test hook
    window.__dbg = { src: () => buildTreeToSource(this.buildTree), compile, meshSolid, importSTL, importOBJ, registerSolid, coloredParts: () => buildColoredParts(this.buildTree) }; // debug
    window.__recipes = RECIPES; // simple-mode makes (test hook)
    this._bindEvents();
    this.recompile(true);
    this._pushHistory();
    this._initProjects(); // restore last project (or adopt the starter as the first)
    this.root.querySelector('#boot').classList.add('gone');
  }

  // --- compile + render loop ------------------------------------------------

  recompile(frame = false) {
    if (this._layerMode) this._exitLayers(); // any model change leaves the slice preview
    this._syncBuildTools(); // keep the floating tools button in sync with the mode
    let source = this.mode === 'build'
      ? buildTreeToSource(this.buildTree)
      : this.source;

    // Print orientation + scale-to-fit: wrap the whole model. No-op at defaults.
    const pr = this.printRot;
    if (pr && (pr[0] || pr[1] || pr[2]) && source.trim()) {
      source = `rotate([${pr[0]}, ${pr[1]}, ${pr[2]}]) {\n${source}\n}`;
    }
    const ps = this.printScale;
    if (ps && ps !== 1 && source.trim()) {
      source = `scale([${ps}, ${ps}, ${ps}]) {\n${source}\n}`;
    }

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

    // Build mode shows individual shapes (with an optional ghost of the
    // combined result); code mode — and build's "result" view — show the
    // merged solid.
    if (this.mode === 'build' && this.viewMode !== 'result') {
      this.viewport.setEditMode(true);
      this._renderEditShapes();
      this.viewport.setGhost(this._wantGhost() ? result : null);
    } else {
      this.viewport.setEditMode(false);
      this.viewport.setModel(result || null);
      this.viewport.setGhost(null);
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
      this._highlightEditor();
      this._scheduleCursorHighlight(); // setModel wiped the glow — re-light at the caret
    }
  }

  _scheduleRecompile() {
    clearTimeout(this._recompileTimer);
    this._setStatus('working');
    this._recompileTimer = setTimeout(() => { this.recompile(); this._pushHistory(); }, 180);
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
    this.selectedNodes = this.selectedNodes.filter((i) => i < this.buildTree.nodes.length);
    this.selectedNode = this.selectedNodes.length ? this.selectedNodes[this.selectedNodes.length - 1] : -1;
    this.viewport.setSelection(this.selectedNodes);
    this._highlightBuildRows();
    this._renderAlignBar();
  }

  // The ghost preview only helps when the combined result differs from the
  // parts — i.e. a subtract/intersect group is present.
  _wantGhost() {
    return this.buildTree.nodes.some((n) => !n.hidden && n.group != null && n.groupMode && n.groupMode !== 'union');
  }

  // Toggle the build view: 'edit' (parts + result ghost) vs 'result' (the
  // combined solid). The toggle is how you get back to editing — no separate
  // enter-group step needed.
  _setViewMode(mode) {
    this.viewMode = mode;
    this.root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
    if (this.mode !== 'build') return;
    if (mode === 'result') {
      this.viewport.setEditMode(false);
      this.viewport.setModel(this.currentModel || null);
      this.viewport.setGhost(null);
    } else {
      this.viewport.setEditMode(true);
      this._renderEditShapes();
      this.viewport.setGhost(this._wantGhost() ? this.currentModel : null);
    }
  }

  // All node indices that share a node's group (or just itself if ungrouped).
  _members(i) {
    const nodes = this.buildTree.nodes;
    const g = nodes[i] ? nodes[i].group : null;
    if (g == null) return [i];
    return nodes.map((n, k) => (n.group === g ? k : -1)).filter((k) => k >= 0);
  }

  _selectNode(i, additive) {
    if (i < 0) {
      if (!additive) this.selectedNodes = [];
    } else if (additive) {
      // toggle the whole group the clicked shape belongs to
      const grp = this._members(i);
      const present = grp.every((k) => this.selectedNodes.includes(k));
      this.selectedNodes = present
        ? this.selectedNodes.filter((k) => !grp.includes(k))
        : [...new Set([...this.selectedNodes, ...grp])];
    } else {
      this.selectedNodes = this._members(i);
    }
    this.selectedNode = this.selectedNodes.length ? this.selectedNodes[this.selectedNodes.length - 1] : -1;
    this.viewport.setSelection(this.selectedNodes);
    this._highlightBuildRows();
    this._renderAlignBar();
  }

  _highlightBuildRows() {
    const sel = new Set(this.selectedNodes);
    this.root.querySelectorAll('.build-node').forEach((r) =>
      r.classList.toggle('sel', sel.has(Number(r.dataset.node))));
  }

  // The build tools live in a floating dock (bottom-right). Show its button only
  // in build mode, and collapse the dock when leaving build so it never lingers
  // over the code view.
  _syncBuildTools() {
    const build = this.mode === 'build';
    const fab = this.root.querySelector('#tools-fab');
    const dock = this.root.querySelector('#tools-dock');
    if (fab) fab.classList.toggle('hidden', !build);
    if (!build) {
      if (dock) dock.classList.remove('open');
      if (fab) fab.classList.remove('on');
    }
  }

  // --- layer preview (slice into printed layers) ---------------------------
  _toggleLayers() {
    if (this._layerMode) { this._exitLayers(); this.recompile(); return; }
    const n = this.viewport.showLayers(this.currentModel || null);
    if (!n) { this._toast('Nothing to slice yet'); return; }
    this._layerMode = true;
    this._layerCount = n;
    const range = this.root.querySelector('#layer-range');
    if (range) { range.max = String(n - 1); range.value = String(n - 1); }
    this._updateLayerLabel(n - 1);
    this.root.querySelector('#layer-bar')?.classList.remove('hidden');
    this.root.querySelector('#v-layers')?.classList.add('on');
  }

  _exitLayers() {
    if (!this._layerMode) return;
    this._layerMode = false;
    this.viewport.hideLayers();
    this.root.querySelector('#layer-bar')?.classList.add('hidden');
    this.root.querySelector('#v-layers')?.classList.remove('on');
  }

  _updateLayerLabel(i) {
    const lbl = this.root.querySelector('#layer-label');
    if (lbl) lbl.textContent = `layer ${i + 1} / ${this._layerCount}`;
  }

  // The build tools stay visible so they're always discoverable; their buttons
  // just disable until the selection meets each tool's requirement (place/array
  // need 1 part, align/group need 2). The whole build pane is hidden in code
  // mode, so nothing leaks there.
  _renderAlignBar() {
    const sel = this.selectedNodes.length;
    const nodes = this.buildTree.nodes;
    const show = (id, disabled) => {
      const bar = this.root.querySelector(id);
      if (!bar) return;
      bar.classList.remove('hidden');
      bar.querySelectorAll('button').forEach((b) => { b.disabled = disabled; });
    };
    show('#opsbar', sel < 1);
    show('#arraybar', sel < 1);
    show('#alignbar', sel < 2);
    const grp = this.root.querySelector('#groupbar');
    if (grp) {
      grp.classList.remove('hidden');
      const hasGroup = this.selectedNodes.some((i) => nodes[i] && nodes[i].group != null);
      const canGroup = sel >= 2;
      const gb = grp.querySelector('[data-group="group"]');
      const ub = grp.querySelector('[data-group="ungroup"]');
      if (gb) gb.disabled = !canGroup;
      if (ub) ub.disabled = !hasGroup;
      // boolean-mode buttons: only meaningful for a group; disable (don't hide)
      // off a group so the option stays discoverable. Highlight the active one.
      const modes = new Set(this.selectedNodes.map((i) => nodes[i]).filter((n) => n && n.group != null).map((n) => n.groupMode || 'union'));
      const active = modes.size === 1 ? [...modes][0] : null;
      grp.querySelectorAll('[data-gmode]').forEach((b) => {
        b.disabled = !hasGroup;
        b.classList.toggle('on', hasGroup && b.dataset.gmode === active);
      });
    }
    this._updateSelReadout();
  }

  // Show the selection's overall W x D x H in the HUD (a quick measuring aid).
  _updateSelReadout() {
    const row = this.root.querySelector('#hud-sel-row');
    const out = this.root.querySelector('#hud-sel');
    if (!row || !out) return;
    if (this.mode !== 'build' || !this.selectedNodes.length) { row.classList.add('hidden'); return; }
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    let any = false;
    this.selectedNodes.forEach((i) => {
      const b = this.viewport.shapeBounds(i); if (!b) return;
      any = true;
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); }
    });
    if (!any) { row.classList.add('hidden'); return; }
    const f = (v) => v.toFixed(1);
    out.textContent = `${f(mx[0] - mn[0])} × ${f(mx[1] - mn[1])} × ${f(mx[2] - mn[2])} mm`;
    row.classList.remove('hidden');
  }

  // Combine the selected shapes into one group (their holes scope to the group,
  // and they move/duplicate/delete as a unit).
  _group() {
    const sel = this.selectedNodes;
    if (sel.length < 2) return;
    const nodes = this.buildTree.nodes;
    const id = nodes.reduce((m, n) => (n.group != null && n.group > m ? n.group : m), 0) + 1;
    sel.forEach((i) => { if (nodes[i]) nodes[i].group = id; });
    this.selectedNodes = this._members(sel[sel.length - 1]);
    this.selectedNode = this.selectedNodes[this.selectedNodes.length - 1];
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._toast(`Grouped ${sel.length} parts`);
  }

  // Dissolve any groups represented in the selection back into loose parts.
  _ungroup() {
    const nodes = this.buildTree.nodes;
    const gids = new Set(this.selectedNodes.map((i) => nodes[i] && nodes[i].group).filter((g) => g != null));
    if (!gids.size) return;
    nodes.forEach((n) => { if (gids.has(n.group)) n.group = null; });
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._toast('Ungrouped');
  }

  // Set how the selected group(s) combine: union (join), subtract (first minus
  // the rest), or intersect (keep only the overlap).
  _setGroupMode(mode) {
    const nodes = this.buildTree.nodes;
    const gids = new Set(this.selectedNodes.map((i) => nodes[i] && nodes[i].group).filter((g) => g != null));
    if (!gids.size) return;
    nodes.forEach((n) => { if (gids.has(n.group)) n.groupMode = mode; });
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._renderAlignBar();
  }

  // Mirror the selection across an axis through each shape's own centre (a
  // negative scale — manifold mirrors cleanly, DoubleSide keeps the preview lit).
  _flip(axis) {
    const k = { x: 0, y: 1, z: 2 }[axis];
    const nodes = this.buildTree.nodes;
    let any = false;
    this.selectedNodes.forEach((i) => {
      const n = nodes[i]; if (!n) return;
      const s = [...(n.scale || [1, 1, 1])]; s[k] = -s[k]; n.scale = s; any = true;
    });
    if (!any) return;
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
  }

  // Arrow-key nudge: move the selection by the snap step (x10 with Shift),
  // shifting meshes directly so threaded parts don't re-mesh each press.
  _nudge(d) {
    const nodes = this.buildTree.nodes;
    let any = false;
    this.selectedNodes.forEach((i) => {
      const n = nodes[i]; if (!n || n.locked) return;
      n.pos = [n.pos[0] + d[0], n.pos[1] + d[1], n.pos[2] + d[2]]; any = true;
    });
    if (!any) return;
    this.viewport.shiftSelected(d[0], d[1], d[2]);
    const host = this.root.querySelector('#build-list');
    if (host) this.selectedNodes.forEach((i) => {
      const n = nodes[i]; if (!n) return;
      ['0', '1', '2'].forEach((a) => { const el = host.querySelector(`input[data-pos="${i}:${a}"]`); if (el) el.value = n.pos[+a]; });
    });
    this._recompileMergedHUD();
    this._scheduleHistory();
  }

  _scheduleHistory() { clearTimeout(this._histTimer); this._histTimer = setTimeout(() => this._pushHistory(), 400); }

  // Replicate the selection into a row (linear) or ring (polar). The whole
  // array becomes one group so it moves/edits as a unit.
  _arrayOp(kind) {
    if (!this.selectedNodes.length) return;
    const nodes = this.buildTree.nodes;
    const n = Math.max(2, Math.min(64, parseInt(this.root.querySelector('#arr-n').value, 10) || 2));
    const gap = parseFloat(this.root.querySelector('#arr-gap').value) || 0;
    const gid = nodes.reduce((m, x) => (x.group != null && x.group > m ? x.group : m), 0) + 1;
    const src = this.selectedNodes.map((i) => nodes[i]).filter(Boolean);
    const clone = (s, dx, dy, dz, drz) => ({
      kind: s.kind, op: s.op, pos: [s.pos[0] + dx, s.pos[1] + dy, s.pos[2] + dz],
      rot: [s.rot[0], s.rot[1], s.rot[2] + (drz || 0)], scale: [...(s.scale || [1, 1, 1])],
      color: s.color, locked: s.locked, hidden: s.hidden, group: gid, fields: s.fields.map((f) => ({ ...f })),
    });
    const copies = [];
    if (kind === 'polar') {
      for (let k = 1; k < n; k++) {
        const a = (k * 360) / n, rad = (a * Math.PI) / 180, ca = Math.cos(rad), sa = Math.sin(rad);
        src.forEach((s) => {
          const x = s.pos[0], y = s.pos[1];
          copies.push(clone(s, (x * ca - y * sa) - x, (x * sa + y * ca) - y, 0, a));
        });
      }
    } else {
      const ax = kind === 'x' ? 0 : 1;
      for (let k = 1; k < n; k++) src.forEach((s) => { const d = [0, 0, 0]; d[ax] = k * gap; copies.push(clone(s, d[0], d[1], d[2], 0)); });
    }
    src.forEach((s) => { s.group = gid; }); // originals join the array group too
    nodes.push(...copies);
    this.selectedNodes = nodes.map((x, i) => (x.group === gid ? i : -1)).filter((i) => i >= 0);
    this.selectedNode = this.selectedNodes[this.selectedNodes.length - 1];
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._renderAlignBar();
    this._toast(`Array ×${n}`);
  }

  // Rest the primary (last-selected) part on top of the other selected parts,
  // keeping its X/Y — the quick "put this on top of that" move.
  _stack() {
    if (this.selectedNodes.length < 2) return;
    const prim = this.selectedNode;
    const others = this.selectedNodes.filter((i) => i !== prim);
    const tops = others.map((i) => this.viewport.shapeBounds(i)).filter(Boolean).map((b) => b.max[2]);
    const pb = this.viewport.shapeBounds(prim);
    if (!tops.length || !pb) return;
    const shift = Math.max(...tops) - pb.min[2];
    const n = this.buildTree.nodes[prim];
    n.pos[2] = Math.round((n.pos[2] + shift) * 100) / 100 || 0;
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
  }

  // place ops on the selection: drop to plate, center, level (reset rot), reset scale
  _placeOp(act) {
    if (act === 'stack') return this._stack();
    const nodes = this.buildTree.nodes;
    this.selectedNodes.forEach((i) => {
      const n = nodes[i];
      if (!n) return;
      if (act === 'drop') { const ext = this.viewport.shapeExtent(i); if (ext) n.pos[2] = Math.round(-ext.minZ * 100) / 100 || 0; }
      else if (act === 'center') { n.pos[0] = 0; n.pos[1] = 0; }
      else if (act === 'level') { n.rot = [0, 0, 0]; }
      else if (act === 'scale') { n.scale = [1, 1, 1]; }
    });
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
  }

  // line up every selected shape with the primary on one axis
  // Align selected shapes by their min / centre / max edge on an axis to the
  // selection's bounding box (Tinkercad-style). spec = "x:min" | "y:center" ...
  _align(spec) {
    const [axis, mode] = spec.split(':');
    const k = { x: 0, y: 1, z: 2 }[axis];
    if (k === undefined || this.selectedNodes.length < 2) return;
    const nodes = this.buildTree.nodes;
    const bounds = this.selectedNodes.map((i) => ({ i, b: this.viewport.shapeBounds(i) })).filter((o) => o.b);
    if (bounds.length < 2) return;
    const selMin = Math.min(...bounds.map((o) => o.b.min[k]));
    const selMax = Math.max(...bounds.map((o) => o.b.max[k]));
    const target = mode === 'min' ? selMin : mode === 'max' ? selMax : (selMin + selMax) / 2;
    bounds.forEach(({ i, b }) => {
      const anchor = mode === 'min' ? b.min[k] : mode === 'max' ? b.max[k] : (b.min[k] + b.max[k]) / 2;
      nodes[i].pos[k] = Math.round((nodes[i].pos[k] + (target - anchor)) * 100) / 100 || 0;
    });
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
  }

  _deleteSelected() {
    if (!this.selectedNodes.length) return;
    const set = new Set(this.selectedNodes);
    this.buildTree.nodes = this.buildTree.nodes.filter((_, i) => !set.has(i));
    this.selectedNodes = [];
    this.selectedNode = -1;
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._renderAlignBar();
  }

  _duplicateSelected() {
    if (!this.selectedNodes.length) return;
    const nodes = this.buildTree.nodes;
    let nextG = nodes.reduce((m, n) => (n.group != null && n.group > m ? n.group : m), 0) + 1;
    const remap = new Map(); // old group id -> fresh id, so the copy is its own group
    const copies = this.selectedNodes.map((i) => nodes[i]).filter(Boolean).map((s) => {
      let g = null;
      if (s.group != null) { if (!remap.has(s.group)) remap.set(s.group, nextG++); g = remap.get(s.group); }
      return {
        kind: s.kind, op: s.op, pos: [s.pos[0] + 6, s.pos[1] + 6, s.pos[2]],
        rot: [...s.rot], scale: [...(s.scale || [1, 1, 1])],
        color: s.color, locked: s.locked, hidden: s.hidden, group: g, collapsed: s.collapsed,
        meshId: s.meshId, meshName: s.meshName, fields: s.fields.map((f) => ({ ...f })),
      };
    });
    const start = this.buildTree.nodes.length;
    this.buildTree.nodes.push(...copies);
    this.selectedNodes = copies.map((_, k) => start + k);
    this.selectedNode = this.selectedNodes[this.selectedNodes.length - 1];
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._renderAlignBar();
  }

  // --- right-click context menu (full action hub) -------------------------
  _showContextMenu(i, x, y) {
    const menu = this.root.querySelector('#ctx-menu');
    if (!menu) return;
    if (i < 0) { menu.classList.add('hidden'); return; }
    if (!this.selectedNodes.includes(i)) this._selectNode(i, false); // act on what was clicked
    const nodes = this.buildTree.nodes, n = nodes[i];
    if (!n) { menu.classList.add('hidden'); return; }
    const can2 = this.selectedNodes.length >= 2;
    const hasGroup = this.selectedNodes.some((j) => nodes[j] && nodes[j].group != null);

    const keys = {
      dup: 'Ctrl+D', op: 'H', lock: 'L', hide: '⇧H', del: 'Del', explode: '⇧B',
      group: 'Ctrl+G', ungroup: '⇧Ctrl+G',
      'xf:translate': 'W', 'xf:rotate': 'E', 'xf:scale': 'R',
      'place:drop': 'B', 'place:center': 'C', 'place:level': '⇧E', 'place:scale': '⇧R', 'place:stack': 'S',
      'flip:x': 'X', 'flip:y': 'Y', 'flip:z': 'Z',
    };
    const btn = (act, label, danger) => `<button data-act="${act}" class="ctx-it${danger ? ' ctx-danger' : ''}"><span>${label}</span>${keys[act] ? `<span class="ctx-key">${keys[act]}</span>` : ''}</button>`;
    const sub = (label, items) => `<div class="ctx-it ctx-has-sub"><span>${label}</span><span class="ctx-arr">▸</span><div class="ctx-sub">${items.map(([a, l]) => btn(a, l)).join('')}</div></div>`;
    const sep = '<div class="ctx-sep"></div>';

    let h = '';
    h += btn('dup', 'Duplicate');
    h += btn('op', n.op === 'hole' ? 'Make solid' : 'Make hole');
    h += btn('lock', n.locked ? 'Unlock' : 'Lock');
    h += btn('hide', n.hidden ? 'Show' : 'Hide');
    h += sep;
    h += sub('Transform', [['xf:translate', 'Move'], ['xf:rotate', 'Turn'], ['xf:scale', 'Size']]);
    h += sub('Place', [['place:drop', 'Drop to base'], ['place:center', 'Center on plate'], ['place:level', 'Level (reset turn)'], ['place:scale', 'Reset size'], ['place:stack', 'Stack on top'], ['placeface', 'Onto a face…'], ['flip:x', 'Mirror X'], ['flip:y', 'Mirror Y'], ['flip:z', 'Mirror Z']]);
    if (can2) h += sub('Align', [['align:x:min', 'X — left'], ['align:x:center', 'X — center'], ['align:x:max', 'X — right'], ['align:y:min', 'Y — front'], ['align:y:center', 'Y — center'], ['align:y:max', 'Y — back'], ['align:z:min', 'Z — down'], ['align:z:center', 'Z — center'], ['align:z:max', 'Z — up']]);
    h += sub('Array', [['arr:x', 'Row along X'], ['arr:y', 'Row along Y'], ['arr:polar', 'Ring']]);
    if (can2) h += btn('group', 'Group');
    if (hasGroup) { h += btn('ungroup', 'Ungroup'); h += sub('Combine', [['gmode:union', 'Join (∪)'], ['gmode:subtract', 'Subtract (∖)'], ['gmode:intersect', 'Intersect (∩)'], ['gmode:hull', 'Hull / blend (⬭)']]); }
    h += sep;
    h += btn('explode', 'Break apart');
    h += btn('del', 'Delete', true);
    menu.innerHTML = h;

    menu.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
      menu.classList.add('hidden');
      this._ctxAction(b.dataset.act, i);
    }));

    menu.classList.remove('hidden', 'ctx-left');
    const mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 320;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - mh - 8))}px`;
    if (x > window.innerWidth * 0.55) menu.classList.add('ctx-left'); // flyouts open leftward near the right edge
  }

  _ctxAction(act, i) {
    const n = this.buildTree.nodes[i];
    const reflow = () => { this._renderBuildTree(); this.recompile(); this._pushHistory(); this._renderAlignBar(); };
    switch (act) {
      case 'dup': return this._duplicateSelected();
      case 'del': return this._deleteSelected();
      case 'op': if (n) { n.op = n.op === 'hole' ? 'solid' : 'hole'; reflow(); } return;
      case 'lock': if (n) { n.locked = !n.locked; reflow(); } return;
      case 'hide': if (n) { n.hidden = !n.hidden; reflow(); } return;
      case 'group': return this._group();
      case 'ungroup': return this._ungroup();
      case 'explode': return this._explodeNode(i);
      case 'placeface': return this._placeOnFace();
    }
    const c = act.indexOf(':');
    if (c < 0) return;
    const pre = act.slice(0, c), arg = act.slice(c + 1);
    if (pre === 'xf') this._setXform(arg);
    else if (pre === 'place') this._placeOp(arg);
    else if (pre === 'flip') this._flip(arg);
    else if (pre === 'align') this._align(arg);
    else if (pre === 'arr') this._arrayOp(arg);
    else if (pre === 'gmode') this._setGroupMode(arg);
  }

  // Break a part into its separate connected pieces (great for an imported STL
  // that's really several objects) so each can be moved / edited / cut on its own.
  _explodeNode(i) {
    const nodes = this.buildTree.nodes, n = nodes[i];
    if (!n) return;
    let man = null;
    try {
      const solo = { ...n, op: 'solid', group: null, groupMode: 'union', hidden: false };
      man = compile(buildTreeToSource({ nodes: [solo] }), {}).result;
    } catch { this._toast('Couldn’t break this part apart'); return; }
    if (!man) { this._toast('Nothing to break apart'); return; }
    let comps = [];
    try { comps = man.decompose(); } catch { comps = []; }
    if (!comps || comps.length <= 1) {
      this._toast('This is one connected piece — nothing to break apart');
      return;
    }
    const pieces = comps.map((c, k) => {
      const id = `piece-${Date.now()}-${k}`;
      try { registerSolid(id, c); } catch { return null; }
      return {
        kind: 'imported', op: n.op, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
        color: n.color, locked: false, hidden: false, group: null, groupMode: 'union',
        collapsed: false, meshId: id, meshName: `${n.meshName || 'piece'} ${k + 1}`, fields: [],
      };
    }).filter(Boolean);
    if (!pieces.length) { this._toast('Couldn’t break this part apart'); return; }
    this.buildTree.nodes.splice(i, 1, ...pieces);
    this.selectedNodes = []; this.selectedNode = -1;
    this._renderBuildTree(); this.recompile(); this._pushHistory(); this._renderAlignBar();
    this._toast(`Broke into ${pieces.length} pieces`);
  }

  // live during a drag: move the shape (whole group moves together) + reflect
  // in the panel, no recompile
  _onShapeMove(i, pos) {
    const nodes = this.buildTree.nodes;
    const n = nodes[i];
    if (!n) return;
    const dx = pos[0] - n.pos[0], dy = pos[1] - n.pos[1];
    const sel = this.selectedNodes.includes(i) ? this.selectedNodes : [i];
    const host = this.root.querySelector('#build-list');
    sel.forEach((j) => {
      const m = nodes[j]; if (!m) return;
      m.pos = (j === i) ? pos : [m.pos[0] + dx, m.pos[1] + dy, m.pos[2]];
      if (host) ['0', '1', '2'].forEach((a) => {
        const el = host.querySelector(`input[data-pos="${j}:${a}"]`);
        if (el && document.activeElement !== el) el.value = m.pos[+a];
      });
    });
  }

  // drag finished: settle the merged solid + HUD (export needs it current)
  _onShapeMoveEnd(i, pos) {
    const n = this.buildTree.nodes[i];
    if (!n) return;
    n.pos = pos;
    this._recompileMergedHUD();
    this._pushHistory();
  }

  // gizmo drag: live pos/rot/scale into the node + panel (no recompile yet).
  // Round to kill float noise (e.g. -1.8e-15) so the emitted source stays clean.
  _onTransform(i, t) {
    const nodes = this.buildTree.nodes;
    const n = nodes[i];
    if (!n) return;
    const r = (v, p) => { const x = Math.round(v * 10 ** p) / 10 ** p; return x === 0 ? 0 : x; };
    const newPos = t.pos.map((v) => r(v, 2));
    const newRot = t.rot.map((v) => r(v, 2));
    const newScale = t.scale.map((v) => r(v, 3));
    const sel = this.selectedNodes.includes(i) ? this.selectedNodes : [i];
    // Move applies as a rigid delta to the whole group; rotate/scale apply the
    // same delta/factor to each member (predictable for v1).
    const dPos = [newPos[0] - n.pos[0], newPos[1] - n.pos[1], newPos[2] - n.pos[2]];
    const dRot = [newRot[0] - n.rot[0], newRot[1] - n.rot[1], newRot[2] - n.rot[2]];
    const s0 = n.scale || [1, 1, 1];
    const fS = [newScale[0] / (s0[0] || 1), newScale[1] / (s0[1] || 1), newScale[2] / (s0[2] || 1)];
    sel.forEach((j) => {
      const m = nodes[j]; if (!m) return;
      if (j === i) { m.pos = newPos; m.rot = newRot; m.scale = newScale; return; }
      m.pos = [m.pos[0] + dPos[0], m.pos[1] + dPos[1], m.pos[2] + dPos[2]];
      m.rot = [m.rot[0] + dRot[0], m.rot[1] + dRot[1], m.rot[2] + dRot[2]];
      const ms = m.scale || [1, 1, 1];
      m.scale = [ms[0] * fS[0], ms[1] * fS[1], ms[2] * fS[2]];
    });
    const host = this.root.querySelector('#build-list');
    if (!host) return;
    const set = (q, v) => { const el = host.querySelector(q); if (el && document.activeElement !== el) el.value = v; };
    sel.forEach((j) => {
      const m = nodes[j]; if (!m) return;
      ['0', '1', '2'].forEach((a) => { set(`input[data-pos="${j}:${a}"]`, m.pos[+a]); set(`input[data-rot="${j}:${a}"]`, m.rot[+a]); });
    });
  }

  // Single shape: cheap merged-only refresh. Group: rebuild every edit mesh so
  // the non-primary members (which the gizmo doesn't move live) catch up.
  _onTransformEnd() {
    if (this.selectedNodes.length > 1) this.recompile();
    else this._recompileMergedHUD();
    this._pushHistory();
  }

  _setXform(mode) {
    this.viewport.setTransformMode(mode);
    this.root.querySelectorAll('[data-xform]').forEach((x) => x.classList.toggle('on', x.dataset.xform === mode));
  }

  // --- undo / redo (snapshot history) --------------------------------------

  _snapshot() {
    return JSON.stringify({ mode: this.mode, source: this.source, nodes: this.buildTree.nodes, printRot: this.printRot, printScale: this.printScale });
  }

  _pushHistory() {
    if (this._restoring) return;
    const snap = this._snapshot();
    if (this.histIdx >= 0 && this.history[this.histIdx] === snap) return;
    this.history.splice(this.histIdx + 1);
    this.history.push(snap);
    if (this.history.length > 80) this.history.shift();
    this.histIdx = this.history.length - 1;
    this._updateHistoryButtons();
    this._scheduleAutosave();
  }

  _restore(snap) {
    const d = JSON.parse(snap);
    this._restoring = true;
    this.mode = d.mode;
    this.source = d.source;
    this.buildTree.nodes = d.nodes;
    this.printRot = d.printRot || [0, 0, 0];
    this.printScale = d.printScale || 1;
    this.selectedNode = -1;
    this.overrides = {};
    this.root.querySelectorAll('[data-mode]').forEach((t) => t.classList.toggle('active', t.dataset.mode === this.mode));
    this.root.querySelector('#pane-code').classList.toggle('hidden', this.mode !== 'code');
    this.root.querySelector('#pane-build').classList.toggle('hidden', this.mode !== 'build');
    this.root.querySelector('#editor').value = this.source;
    this._renderBuildTree();
    this.recompile(true);
    this._restoring = false;
    this._updateHistoryButtons();
  }

  _undo() { if (this.histIdx > 0) { this.histIdx--; this._restore(this.history[this.histIdx]); } }
  _redo() { if (this.histIdx < this.history.length - 1) { this.histIdx++; this._restore(this.history[this.histIdx]); } }

  _updateHistoryButtons() {
    const u = this.root.querySelector('#v-undo'), r = this.root.querySelector('#v-redo');
    if (u) u.disabled = this.histIdx <= 0;
    if (r) r.disabled = this.histIdx >= this.history.length - 1;
  }

  // Switch code<->build keeping the SAME object on screen. build->code shows
  // the source that builds the current parts; code->build imports the source
  // into editable parts (or keeps the parts if the code is their clean mirror).
  _switchMode(mode) {
    const $ = (s) => this.root.querySelector(s);
    if (mode === this.mode) { this._setPanel(true); return; }
    if (mode === 'code') {
      this.source = buildTreeToSource(this.buildTree) || this.source;
      this._codeMirror = this.source; // clean mirror — reused if we switch back unedited
      $('#editor').value = this.source;
      this.overrides = {};
      this.mode = 'code';
    } else {
      if (this._codeMirror !== this.source) {
        try {
          const nodes = sourceToNodes(this.source);
          this._liftToPlate(nodes);
          this.buildTree.nodes = nodes;
          this.selectedNodes = []; this.selectedNode = -1;
        } catch (e) {
          const why = (e && e.name === 'ForgeError' && e.message) ? e.message
            : 'This design uses features build mode can’t edit yet';
          this._toast(`${why} — staying in code`);
          this._setPanel(true);
          return; // stay in code rather than show a different object
        }
      }
      this.mode = 'build';
    }
    this.root.querySelectorAll('[data-mode]').forEach((t) => t.classList.toggle('active', t.dataset.mode === this.mode));
    $('#pane-code').classList.toggle('hidden', this.mode !== 'code');
    $('#pane-build').classList.toggle('hidden', this.mode !== 'build');
    this._setPanel(true);
    if (this.mode === 'build') this._renderBuildTree();
    this.recompile(true);
    this._pushHistory();
  }

  _loadTemplate(key) {
    const src = TEMPLATES[key];
    if (!src) return;
    this._closeAddModal();
    // In build mode, bring the template in as editable parts. If it uses
    // something the build tree can't hold, fall back to loading it as code.
    if (this.mode === 'build') {
      try {
        const nodes = sourceToNodes(src);
        this._liftToPlate(nodes);
        this.buildTree.nodes = nodes;
        this.selectedNode = -1;
        this.selectedNodes = [];
        this._renderBuildTree();
        this._renderAlignBar();
        this.recompile(true);
        this._pushHistory();
        this._toast(`Loaded “${key}” — ${nodes.length} part${nodes.length === 1 ? '' : 's'}`);
        return;
      } catch (e) {
        this._toast(`“${key}” opened in code (too complex for build)`);
        // fall through to the code-pane load below
      }
    }
    this.mode = 'code';
    this.source = src;
    this.overrides = {};
    this._codeMirror = null;
    this.root.querySelectorAll('[data-mode]').forEach((t) => t.classList.toggle('active', t.dataset.mode === 'code'));
    this.root.querySelector('#pane-code').classList.remove('hidden');
    this.root.querySelector('#pane-build').classList.add('hidden');
    this.root.querySelector('#editor').value = src;
    this._setPanel(true);
    this.recompile(true);
    this._pushHistory();
  }

  // Shift a set of freshly-imported nodes up so the assembly's lowest point
  // rests on the plate (build-mode shapes sit on z=0, unlike centred code).
  _liftToPlate(nodes) {
    const { result } = compile(buildTreeToSource({ nodes }), {});
    if (!result) return;
    try {
      const minz = result.boundingBox().min[2];
      if (minz) nodes.forEach((n) => { n.pos[2] = Math.round((n.pos[2] - minz) * 100) / 100 || 0; });
    } finally {
      try { result.delete(); } catch { /* freed */ }
    }
  }

  // Brief in-page status toast (never a native dialog).
  _toast(msg) {
    let t = this.root.querySelector('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      this.root.querySelector('.stage').appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // --- projects (local, persisted in localStorage) --------------------------

  // The full design as a plain serializable object. Imported STL meshes are
  // captured by value (welded arrays) so a saved project is self-contained.
  _serializeDesign() {
    const nodes = this.buildTree.nodes;
    const meshes = {};
    for (const n of nodes) {
      if (n.kind === 'imported' && n.meshId && !meshes[n.meshId]) {
        const md = solidMesh(n.meshId);
        if (md) meshes[n.meshId] = md;
      }
    }
    return { v: 1, mode: this.mode, source: this.source, viewMode: this.viewMode, nodes, meshes };
  }

  // Load a serialized design into the app (restores imported meshes first).
  _applyDesign(data) {
    if (!data) return;
    if (data.meshes) {
      for (const id in data.meshes) {
        const md = data.meshes[id];
        try { registerSolid(id, meshSolid(md.p, md.t)); } catch { /* skip bad mesh */ }
      }
    }
    this.mode = data.mode === 'code' ? 'code' : 'build';
    this.source = data.source || '';
    this.viewMode = data.viewMode === 'result' ? 'result' : 'edit';
    this.buildTree.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    this.overrides = {};
    this._codeMirror = null;
    this.selectedNodes = []; this.selectedNode = -1;
    this.root.querySelectorAll('[data-mode]').forEach((t) => t.classList.toggle('active', t.dataset.mode === this.mode));
    this.root.querySelector('#pane-code').classList.toggle('hidden', this.mode !== 'code');
    this.root.querySelector('#pane-build').classList.toggle('hidden', this.mode !== 'build');
    this.root.querySelector('#editor').value = this.source;
    this.root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === this.viewMode));
    this._renderBuildTree();
    this.recompile(true);
    this.history = []; this.histIdx = -1; this._pushHistory();
    this._updateHistoryButtons();
  }

  // Write the current design into the open project (+ metadata). No-op if none.
  _saveCurrent() {
    if (!this.project) return null;
    this.project.modified = Date.now();
    this.project.seconds = this._workSeconds;
    const entry = Projects.saveProject(this.project, this._serializeDesign());
    Projects.setCurrentId(this.project.id);
    return entry;
  }

  _scheduleAutosave() {
    if (!this.project || this._restoring) return;
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => this._saveCurrent(), 1500);
  }

  _newProject() {
    if (this.project) this._saveCurrent();
    const meta = { id: Projects.newId(), name: this._uniqueName('Untitled'), created: Date.now(), modified: Date.now(), seconds: 0 };
    this.project = meta;
    this._workSeconds = 0;
    this._applyDesign({ v: 1, mode: 'build', source: '', viewMode: 'edit', nodes: [], meshes: {} });
    this._saveCurrent();
    this._updateProjectName();
    this._toast(`New project · ${meta.name}`);
  }

  _saveProject() {
    if (!this.project) { this._promptName('Save project as', '', (name) => this._doSaveAs(name)); return; }
    const entry = this._saveCurrent();
    this._updateProjectName();
    this._toast(entry ? `Saved “${this.project.name}”` : 'Save failed — local storage full');
  }

  _doSaveAs(name) {
    const clean = (name || '').trim();
    if (!clean) return;
    if (this.project) this._saveCurrent(); // checkpoint the source project first
    const meta = { id: Projects.newId(), name: this._uniqueName(clean), created: Date.now(), modified: Date.now(), seconds: this._workSeconds };
    this.project = meta;
    const entry = Projects.saveProject(meta, this._serializeDesign());
    Projects.setCurrentId(meta.id);
    this._updateProjectName();
    this._toast(entry ? `Saved as “${meta.name}”` : 'Save failed — local storage full');
  }

  _openProject(id) {
    const meta = Projects.listProjects().find((p) => p.id === id);
    const data = Projects.loadProject(id);
    if (!meta || !data) { this._toast('Could not open that project'); return; }
    if (this.project && this.project.id !== id) this._saveCurrent();
    this.project = { id: meta.id, name: meta.name, created: meta.created, modified: meta.modified, seconds: meta.seconds || 0 };
    this._workSeconds = meta.seconds || 0;
    this._applyDesign(data);
    Projects.setCurrentId(id);
    this._updateProjectName();
    this._closeModal('#proj-modal');
    this._toast(`Opened “${meta.name}”`);
  }

  _deleteProject(id) {
    Projects.deleteProject(id);
    if (this.project && this.project.id === id) {
      // deleted the open one — fall back to most recent, or a fresh project
      const next = Projects.listProjects().sort((a, b) => b.modified - a.modified)[0];
      if (next) this._openProject(next.id); else this._newProject();
    }
    this._renderProjectList();
    this._updateProjectName();
  }

  _renameCurrentProject(name) {
    const clean = (name || '').trim();
    if (!clean || !this.project) return;
    this.project.name = this._uniqueName(clean, this.project.id);
    Projects.renameProject(this.project.id, this.project.name, Date.now());
    this._updateProjectName();
    this._renderProjectList();
  }

  // Make a name unique within the index (append " 2", " 3", …).
  _uniqueName(base, exceptId) {
    const taken = new Set(Projects.listProjects().filter((p) => p.id !== exceptId).map((p) => p.name));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  _updateProjectName() {
    const el = this.root.querySelector('#proj-name');
    if (el) el.textContent = this.project ? this.project.name : 'Untitled';
  }

  // Count visible (engaged) seconds for the current project; flush periodically.
  _setupWorkTimer() {
    let ticks = 0;
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !this.project) return;
      this._workSeconds += 5;
      if (++ticks % 6 === 0) Projects.touchSeconds(this.project.id, this._workSeconds); // flush ~every 30s
    }, 5000);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.project) Projects.touchSeconds(this.project.id, this._workSeconds);
    });
  }

  // On boot: restore the last project, else adopt the most recent, else create
  // the first one from the current starter design.
  _initProjects() {
    this._setupWorkTimer();
    const cur = Projects.getCurrentId();
    const list = Projects.listProjects();
    const meta = (cur && list.find((p) => p.id === cur)) || list.sort((a, b) => b.modified - a.modified)[0];
    if (meta) this._openProject(meta.id);
    else this._doSaveAs('Untitled'); // first run — save the starter as project #1
  }

  _fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }

  _fmtWork(sec) {
    if (!sec || sec < 60) return '< 1 min';
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m} min`;
  }

  _fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', '
      + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  _renderProjectList() {
    const host = this.root.querySelector('#proj-list');
    if (!host) return;
    const list = Projects.listProjects().sort((a, b) => b.modified - a.modified);
    if (!list.length) { host.innerHTML = '<p class="muted">No saved projects yet.</p>'; return; }
    host.innerHTML = list.map((p) => `
      <div class="proj-row${this.project && p.id === this.project.id ? ' current' : ''}" data-pid="${p.id}">
        <div class="proj-main" data-open="${p.id}">
          <div class="proj-name">${String(p.name).replace(/</g, '&lt;')}${this.project && p.id === this.project.id ? ' ·<span class="proj-cur"> open</span>' : ''}</div>
          <div class="proj-meta">${this._fmtSize(p.size || 0)} · ${this._fmtWork(p.seconds)} worked · created ${this._fmtDate(p.created)} · edited ${this._fmtDate(p.modified)}</div>
        </div>
        <div class="proj-acts">
          <button data-open="${p.id}" title="Open">Open</button>
          <button data-rename="${p.id}" title="Rename">✎</button>
          <button data-del="${p.id}" title="Delete" class="proj-del">✕</button>
        </div>
      </div>`).join('');
  }

  _openModal(sel) { const m = this.root.querySelector(sel); if (m) m.classList.remove('hidden'); }
  _closeModal(sel) { const m = this.root.querySelector(sel); if (m) m.classList.add('hidden'); }

  // Small reusable name-input modal (no native prompt). cb gets the typed name.
  _promptName(title, initial, cb) {
    this._nameCb = cb;
    this.root.querySelector('#name-title').textContent = title;
    const input = this.root.querySelector('#name-input');
    input.value = initial || '';
    this._openModal('#name-modal');
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }

  // Refresh the colour layer behind the code textarea.
  _highlightEditor() {
    const code = this.root.querySelector('#editor-code');
    const ed = this.root.querySelector('#editor');
    if (code && ed) code.innerHTML = highlightCode(ed.value);
  }

  _scheduleCursorHighlight() {
    clearTimeout(this._cursorTimer);
    this._cursorTimer = setTimeout(() => this._highlightCursorShape(), 70);
  }

  // Glow the shape in the 3D view whose code the caret is sitting in. We import
  // the source to build nodes (each tagged with its source span), find the
  // smallest span containing the caret, and compile just that node — forced to
  // a solid so a hole still shows as a positive ghost where it cuts. Anything
  // build mode can't represent (extrude/revolve/loops) just clears the glow.
  _highlightCursorShape() {
    if (this.mode !== 'code') { this.viewport.clearHighlight(); return; }
    const ed = this.root.querySelector('#editor');
    if (!ed) return;
    const caret = ed.selectionStart;
    let nodes;
    try { nodes = sourceToNodes(this.source); }
    catch { this.viewport.clearHighlight(); return; }
    let hit = null;
    for (const n of nodes) {
      if (n.srcStart == null || caret < n.srcStart || caret > n.srcEnd) continue;
      if (!hit || (n.srcEnd - n.srcStart) < (hit.srcEnd - hit.srcStart)) hit = n;
    }
    if (!hit) { this.viewport.clearHighlight(); return; }
    let result = null;
    try {
      const solo = { ...hit, op: 'solid', group: null, groupMode: 'union', hidden: false };
      result = compile(buildTreeToSource({ nodes: [solo] }), {}).result;
    } catch { this.viewport.clearHighlight(); return; }
    this.viewport.highlightSolid(result || null); // copies geometry, safe to free
    if (result) { try { result.delete(); } catch { /* freed */ } }
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
    this._updateSelReadout();
  }

  // Auto-orient for printing: score the 6 axis-aligned face-down orientations by
  // overhang area (tie-broken by bed contact and height) and apply the best as a
  // print rotation (wrapped at compile, undoable). Candidates are single-axis, so
  // the score is independent of Euler order.
  _autoOrient() {
    const src = this.mode === 'build' ? buildTreeToSource(this.buildTree) : this.source;
    if (!src || !src.trim()) { this._toast('Nothing to orient'); return; }
    const base = compile(src, this.overrides).result;
    if (!base) { this._toast('Nothing to orient'); return; }
    const mesh = base.getMesh();
    try { base.delete(); } catch { /* freed */ }

    const D = Math.PI / 180;
    const rot = (p, rx, ry, rz) => {
      let [x, y, z] = p, c, s, t;
      c = Math.cos(rx * D); s = Math.sin(rx * D); t = y; y = c * t - s * z; z = s * t + c * z;
      c = Math.cos(ry * D); s = Math.sin(ry * D); t = x; x = c * t + s * z; z = -s * t + c * z;
      c = Math.cos(rz * D); s = Math.sin(rz * D); t = x; x = c * t - s * y; y = s * t + c * y;
      return [x, y, z];
    };
    const vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp;
    const nVert = vp.length / np;
    const metrics = (R) => {
      // pass 1: rotate the verts, find the bed level (min Z)
      const rv = new Array(nVert);
      let minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < nVert; k++) {
        const o = k * np;
        const p = rot([vp[o], vp[o + 1], vp[o + 2]], R[0], R[1], R[2]);
        rv[k] = p;
        if (p[2] < minZ) minZ = p[2];
        if (p[2] > maxZ) maxZ = p[2];
      }
      // pass 2: a downward face is overhang only if it's ELEVATED above the bed;
      // downward faces sitting on the plate are bed contact, not overhang.
      const bedEps = 0.5;
      let overhang = 0, bed = 0;
      for (let i = 0; i < tv.length; i += 3) {
        const p0 = rv[tv[i]], p1 = rv[tv[i + 1]], p2 = rv[tv[i + 2]];
        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        const area = len / 2, down = -nz / len;
        const elevated = Math.min(p0[2], p1[2], p2[2]) > minZ + bedEps;
        if (!elevated && down > 0.985) bed += area;            // resting on the plate
        else if (elevated && down > 0.7) overhang += area;     // steep floating overhang
        else if (elevated && down > 0.5) overhang += area * 0.4;
      }
      return { overhang, bed, height: maxZ - minZ };
    };

    const CANDIDATES = [[0, 0, 0], [90, 0, 0], [-90, 0, 0], [180, 0, 0], [0, 90, 0], [0, -90, 0]];
    let best = null, bestScore = Infinity, baseOverhang = 0;
    for (const R of CANDIDATES) {
      const m = metrics(R);
      if (!R[0] && !R[1] && !R[2]) baseOverhang = m.overhang;
      const score = m.overhang - m.bed * 0.1 + m.height * 0.02;
      if (score < bestScore - 1e-6) { bestScore = score; best = { R, m }; }
    }
    if (!best) return;

    this.printRot = best.R.slice();
    this.recompile();
    this._pushHistory();
    if (this.mode === 'build' && this.viewMode !== 'result') this._setViewMode('result');
    if (!best.R[0] && !best.R[1] && !best.R[2]) this._toast('Already well-oriented for printing');
    else {
      const cut = baseOverhang > 0 ? Math.max(0, Math.round((1 - best.m.overhang / baseOverhang) * 100)) : 0;
      this._toast(`Auto-oriented · overhang ↓ ${cut}%`);
    }
  }

  // Scale the whole model down uniformly so it fits the build plate (2% margin),
  // applied as a print scale wrapped at compile (undoable). Accounts for the
  // current print orientation. No-op (resets to 100%) if it already fits.
  _scaleToFit() {
    let src = this.mode === 'build' ? buildTreeToSource(this.buildTree) : this.source;
    const pr = this.printRot;
    if (pr && (pr[0] || pr[1] || pr[2]) && src.trim()) src = `rotate([${pr[0]}, ${pr[1]}, ${pr[2]}]) {\n${src}\n}`;
    const base = src.trim() ? compile(src, this.overrides).result : null;
    if (!base) { this._toast('Nothing to scale'); return; }
    const bb = base.boundingBox();
    try { base.delete(); } catch { /* freed */ }
    const maxDim = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    const limit = BUILD_VOLUME.x;
    if (maxDim <= limit) {
      if (this.printScale !== 1) { this.printScale = 1; this.recompile(); this._pushHistory(); }
      this._toast('Already fits the build plate');
      return;
    }
    this.printScale = +((limit / maxDim) * 0.98).toFixed(4);
    this.recompile();
    this._pushHistory();
    if (this.mode === 'build' && this.viewMode !== 'result') this._setViewMode('result');
    this._toast(`Scaled to ${Math.round(this.printScale * 100)}% to fit the plate`);
  }

  // Build the 3MF blob. In build mode with several distinctly-coloured parts we
  // emit a multi-object 3MF (one base material per part) so a slicer can assign
  // a filament each; otherwise a plain single-mesh 3MF of the merged model.
  _build3MF() {
    if (this.mode === 'build') {
      const parts = buildColoredParts(this.buildTree)
        .map((p) => ({ manifold: compile(p.source, {}).result, color: p.color }))
        .filter((p) => p.manifold);
      const distinct = new Set(parts.map((p) => p.color));
      if (parts.length > 1 && distinct.size > 1) return export3MFColored(parts);
    }
    return export3MF(this.currentModel);
  }

  // --- HUD + status ---------------------------------------------------------

  _updateHUD(info) {
    const dims = this.root.querySelector('#hud-dims');
    const vol = this.root.querySelector('#hud-vol');
    const tris = this.root.querySelector('#hud-tris');
    const wt = this.root.querySelector('#hud-watertight');
    const fit = this.root.querySelector('#hud-fit');
    const fil = this.root.querySelector('#hud-filament');
    if (!info) {
      dims.textContent = vol.textContent = tris.textContent = '—';
      dims.classList.remove('hud-bad');
      wt.textContent = '—'; wt.className = 'hud-ok';
      if (fit) { fit.textContent = '—'; fit.className = 'hud-ok'; }
      if (fil) fil.textContent = '—';
      this.viewport.setBuildVolumeExceeded(false);
      return;
    }
    const [x, y, z] = info.bbox.size;
    const fmt = (n) => n.toFixed(1);
    dims.textContent = `${fmt(x)} × ${fmt(y)} × ${fmt(z)} mm`;
    vol.textContent = `${(info.volume / 1000).toFixed(2)} cm³`;
    if (fil) {
      const grams = (info.volume / 1000) * 1.24;  // PLA density ~1.24 g/cm³
      const metres = info.volume / 2.405 / 1000;  // 1.75 mm filament ≈ 2.405 mm² section
      fil.textContent = `≈ ${grams.toFixed(1)} g · ${metres.toFixed(1)} m`;
    }
    tris.textContent = `${info.triangles.toLocaleString()} tris`;
    // manifold-3d output is watertight by construction (any component count),
    // so a valid result is always print-safe. genus is shown for info only.
    wt.textContent = info.genus > 0 ? `manifold ✓ · genus ${info.genus}` : 'manifold ✓';
    wt.className = 'hud-ok';
    // Build-volume fit check against the A1-mini envelope (180³).
    const over = [x > BUILD_VOLUME.x, y > BUILD_VOLUME.y, z > BUILD_VOLUME.z];
    const exceeded = over[0] || over[1] || over[2];
    dims.classList.toggle('hud-bad', exceeded);
    if (fit) {
      if (exceeded) {
        const axes = ['X', 'Y', 'Z'].filter((_, i) => over[i]).join('/');
        fit.textContent = `⚠ too big — ${axes} > ${BUILD_VOLUME.x}mm`;
        fit.className = 'hud-bad';
      } else {
        fit.textContent = `✓ fits A1 mini (${BUILD_VOLUME.x}mm)`;
        fit.className = 'hud-ok';
      }
    }
    this.viewport.setBuildVolumeExceeded(exceeded);
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
    this._highlightEditor();
    editor.addEventListener('input', () => {
      this.source = editor.value;
      this.overrides = {}; // editing code resets param overrides
      this._codeMirror = null; // code edited by hand — no longer a clean mirror of the build tree
      this._highlightEditor();
      this._scheduleRecompile();
    });
    // keep the colour layer scroll-aligned with the textarea
    editor.addEventListener('scroll', () => {
      const pre = $('#editor-hl');
      if (pre) { pre.scrollTop = editor.scrollTop; pre.scrollLeft = editor.scrollLeft; }
    });
    // glow the shape the caret is in (caret-move events; typing re-runs it via
    // recompile). The glow persists when focus leaves the editor so you can
    // orbit the model while it stays lit.
    ['keyup', 'click', 'mouseup'].forEach((ev) =>
      editor.addEventListener(ev, () => this._scheduleCursorHighlight()));

    // mode tabs (also open the panel so the tools are visible)
    this.root.querySelectorAll('[data-mode]').forEach((tab) => {
      tab.addEventListener('click', () => this._switchMode(tab.dataset.mode));
    });

    // collapsible panel
    $('#panel-toggle').addEventListener('click', () => this._setPanel());

    // export dropdown
    const menu = $('#export-menu');
    $('#export-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
    const out = (fn, name) => { if (this.currentModel) triggerDownload(fn(this.currentModel), name); menu.classList.remove('open'); };
    $('#btn-stl').addEventListener('click', () => out(exportSTL, 'part.stl'));
    $('#btn-3mf').addEventListener('click', () => { if (this.currentModel) triggerDownload(this._build3MF(), 'part.3mf'); menu.classList.remove('open'); });
    $('#btn-obj').addEventListener('click', () => out(exportOBJ, 'part.obj'));
    document.addEventListener('click', () => menu.classList.remove('open'));

    // templates dropdown
    const tpl = $('#tpl-menu');
    $('#tpl-btn').addEventListener('click', (e) => { e.stopPropagation(); tpl.classList.toggle('open'); });
    this.root.querySelectorAll('[data-tpl]').forEach((b) =>
      b.addEventListener('click', () => { this._loadTemplate(b.dataset.tpl); tpl.classList.remove('open'); }));
    document.addEventListener('click', () => tpl.classList.remove('open'));

    // projects (File) dropdown
    const proj = $('#proj-menu');
    $('#proj-btn').addEventListener('click', (e) => { e.stopPropagation(); proj.classList.toggle('open'); });
    document.addEventListener('click', () => proj.classList.remove('open'));
    $('#proj-new').addEventListener('click', () => this._newProject());
    $('#proj-save').addEventListener('click', () => this._saveProject());
    $('#proj-saveas').addEventListener('click', () => this._promptName('Save project as', this.project ? this.project.name : '', (n) => this._doSaveAs(n)));
    $('#proj-open').addEventListener('click', () => { this._renderProjectList(); this._openModal('#proj-modal'); });

    // projects manager modal
    const pm = $('#proj-modal');
    $('#proj-modal-close').addEventListener('click', () => this._closeModal('#proj-modal'));
    pm.addEventListener('click', (e) => { if (e.target === pm) this._closeModal('#proj-modal'); });
    $('#proj-list').addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      const ren = e.target.closest('[data-rename]');
      const del = e.target.closest('[data-del]');
      if (open) { this._openProject(open.dataset.open); return; }
      if (ren) { const id = ren.dataset.rename; const cur = Projects.listProjects().find((p) => p.id === id); this._promptName('Rename project', cur ? cur.name : '', (n) => { if (this.project && this.project.id === id) this._renameCurrentProject(n); else { Projects.renameProject(id, this._uniqueName((n || '').trim(), id), Date.now()); this._renderProjectList(); } }); return; }
      if (del) {
        const id = del.dataset.del;
        if (del.dataset.confirm) { this._deleteProject(id); return; } // second click confirms
        del.dataset.confirm = '1'; del.textContent = 'sure?'; del.classList.add('confirm');
        setTimeout(() => { if (del.isConnected) { del.textContent = '✕'; del.classList.remove('confirm'); delete del.dataset.confirm; } }, 2600);
      }
    });

    // name-input modal (Save as / Rename)
    const nameModal = $('#name-modal');
    const nameInput = $('#name-input');
    const nameOk = () => { const cb = this._nameCb; this._nameCb = null; this._closeModal('#name-modal'); if (cb) cb(nameInput.value); };
    $('#name-ok').addEventListener('click', nameOk);
    $('#name-cancel').addEventListener('click', () => { this._nameCb = null; this._closeModal('#name-modal'); });
    nameModal.addEventListener('click', (e) => { if (e.target === nameModal) { this._nameCb = null; this._closeModal('#name-modal'); } });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameOk(); } });

    // undo / redo + snap
    $('#v-undo').addEventListener('click', () => this._undo());
    $('#v-redo').addEventListener('click', () => this._redo());
    $('#v-snap').addEventListener('click', (e) => e.currentTarget.classList.toggle('on', this.viewport.setSnap(!this.viewport.snap)));
    this._updateHistoryButtons();

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

    // floating tools dock: the bottom-right button expands/collapses the bars
    const toolsFab = this.root.querySelector('#tools-fab');
    const toolsDock = this.root.querySelector('#tools-dock');
    if (toolsFab && toolsDock) {
      toolsFab.addEventListener('click', () => {
        toolsFab.classList.toggle('on', toolsDock.classList.toggle('open'));
      });
      const toolsClose = this.root.querySelector('#tools-dock-close');
      if (toolsClose) toolsClose.addEventListener('click', () => {
        toolsDock.classList.remove('open');
        toolsFab.classList.remove('on');
      });

      // Drag the dock by its header (pointer events → works on touch + mouse).
      const head = this.root.querySelector('#tools-dock-head');
      if (head) {
        let sx = 0, sy = 0, ox = 0, oy = 0;
        const onMove = (e) => {
          const r = toolsDock.getBoundingClientRect();
          const x = Math.max(6, Math.min(ox + e.clientX - sx, window.innerWidth - r.width - 6));
          const y = Math.max(50, Math.min(oy + e.clientY - sy, window.innerHeight - 44));
          toolsDock.style.left = `${x}px`; toolsDock.style.top = `${y}px`;
          toolsDock.style.right = 'auto'; toolsDock.style.bottom = 'auto';
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };
        head.addEventListener('pointerdown', (e) => {
          if (e.target.closest('button')) return; // let the ✕ work
          const r = toolsDock.getBoundingClientRect();
          sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          e.preventDefault();
        });
      }
    }

    // multi-select toggle: a sticky additive mode so a tap (no Shift) adds to
    // the selection — the way to multi-select on a touchscreen.
    const multiBtn = this.root.querySelector('#multi-toggle');
    if (multiBtn) multiBtn.addEventListener('click', () => {
      this.multiSelect = !this.multiSelect;
      this.viewport.multiSelect = this.multiSelect;
      multiBtn.classList.toggle('on', this.multiSelect);
      this._toast(this.multiSelect ? 'Multi-select on — tap parts to add them' : 'Multi-select off');
    });

    // dismiss the right-click context menu on any click outside it
    window.addEventListener('mousedown', (e) => {
      const menu = this.root.querySelector('#ctx-menu');
      if (menu && !menu.classList.contains('hidden') && !e.target.closest('#ctx-menu')) menu.classList.add('hidden');
    });

    // help (Learn G-code) modal
    const helpModal = this.root.querySelector('#help-modal');
    const helpBtn = this.root.querySelector('#help-btn');
    if (helpBtn && helpModal) {
      helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'));
      const hc = this.root.querySelector('#help-close');
      if (hc) hc.addEventListener('click', () => helpModal.classList.add('hidden'));
      helpModal.addEventListener('mousedown', (e) => { if (e.target === helpModal) helpModal.classList.add('hidden'); });
    }

    // resizable left panel — drag its right edge (pointer events: touch + mouse)
    const presize = this.root.querySelector('#panel-resize');
    const stage = this.root.querySelector('.stage');
    if (presize && stage) {
      let sx = 0, sw = 0;
      const move = (e) => {
        const w = Math.max(240, Math.min(560, sw + (e.clientX - sx)));
        stage.style.setProperty('--panel-w', `${w}px`);
      };
      const up = () => { presize.classList.remove('dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      presize.addEventListener('pointerdown', (e) => {
        sx = e.clientX;
        sw = this.root.querySelector('#panel').getBoundingClientRect().width;
        presize.classList.add('dragging');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        e.preventDefault();
      });
    }

    // layer preview: toggle + scrub
    const layerBtn = this.root.querySelector('#v-layers');
    if (layerBtn) layerBtn.addEventListener('click', () => this._toggleLayers());
    const layerRange = this.root.querySelector('#layer-range');
    if (layerRange) layerRange.addEventListener('input', () => {
      const i = +layerRange.value;
      this.viewport.setLayerVisible(i);
      this._updateLayerLabel(i);
    });

    // curve smoothness — global segment count for round primitives
    const qualitySel = this.root.querySelector('#v-quality');
    if (qualitySel) qualitySel.addEventListener('change', () => {
      this.curveQuality = +qualitySel.value;
      setCurveQuality(this.curveQuality);
      this.recompile();
    });

    // measure tool: toggle + floating distance label fed by the viewport
    this.viewport.measureLabel = this.root.querySelector('#measure-label');
    this.viewport.onMeasure = (info) => {
      const el = this.viewport.measureLabel;
      if (info && el) el.innerHTML =
        `<b>${info.dist.toFixed(1)} mm</b><span>X ${info.x.toFixed(1)} · Y ${info.y.toFixed(1)} · Z ${info.z.toFixed(1)}</span>`;
    };
    const measBtn = this.root.querySelector('#v-measure');
    if (measBtn) measBtn.addEventListener('click', () => {
      this.measureMode = !this.measureMode;
      this.viewport.setMeasureMode(this.measureMode);
      measBtn.classList.toggle('on', this.measureMode);
    });

    // overhang analysis: tint downward faces that need support (uses the merged
    // result mesh, so switch a build-mode edit view over to result first)
    const ohBtn = this.root.querySelector('#v-overhang');
    if (ohBtn) ohBtn.addEventListener('click', () => {
      this.overhangMode = !this.overhangMode;
      if (this.overhangMode && this.mode === 'build' && this.viewMode !== 'result') this._setViewMode('result');
      const on = this.viewport.setOverhangView(this.overhangMode);
      ohBtn.classList.toggle('on', on);
    });

    const orientBtn = this.root.querySelector('#v-orient');
    if (orientBtn) orientBtn.addEventListener('click', () => this._autoOrient());

    const fitBtn = this.root.querySelector('#v-fit-plate');
    if (fitBtn) fitBtn.addEventListener('click', () => this._scaleToFit());

    // build view toggle: edit (parts + ghost) vs result (combined solid)
    this.root.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => this._setViewMode(b.dataset.view)));

    // align toolbar (appears when 2+ shapes are selected)
    this.root.querySelectorAll('[data-align]').forEach((b) =>
      b.addEventListener('click', () => this._align(b.dataset.align)));

    // place toolbar (drop to base, center, level, reset scale)
    this.root.querySelectorAll('[data-op-act]').forEach((b) =>
      b.addEventListener('click', () => this._placeOp(b.dataset.opAct)));

    // group / ungroup toolbar + boolean mode
    this.root.querySelectorAll('[data-group]').forEach((b) =>
      b.addEventListener('click', () => (b.dataset.group === 'group' ? this._group() : this._ungroup())));
    this.root.querySelectorAll('[data-gmode]').forEach((b) =>
      b.addEventListener('click', () => this._setGroupMode(b.dataset.gmode)));

    // workplane toolbar
    this.root.querySelectorAll('[data-wp]').forEach((b) =>
      b.addEventListener('click', () => (b.dataset.wp === 'face' ? this._pickWorkplane() : this._resetWorkplane())));

    // mirror / flip + array toolbars
    this.root.querySelectorAll('[data-flip]').forEach((b) =>
      b.addEventListener('click', () => this._flip(b.dataset.flip)));
    this.root.querySelectorAll('[data-arr]').forEach((b) =>
      b.addEventListener('click', () => this._arrayOp(b.dataset.arr)));

    // build pane
    this._bindBuildPane();

    // keep the Add popover stuck under its button on resize
    window.addEventListener('resize', () => {
      const m = this.root.querySelector('#add-modal');
      if (m && !m.classList.contains('hidden')) this._positionAddModal();
    });

    // keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      // Save works anywhere, even with a field focused
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); this._saveProject(); return; }
      if (e.key === 'Escape') {
        const ctx = this.root.querySelector('#ctx-menu');
        if (ctx && !ctx.classList.contains('hidden')) { e.preventDefault(); ctx.classList.add('hidden'); return; }
        for (const sel of ['#name-modal', '#proj-modal', '#add-modal', '#help-modal']) {
          const m = this.root.querySelector(sel);
          if (m && !m.classList.contains('hidden')) { e.preventDefault(); if (sel === '#name-modal') this._nameCb = null; m.classList.add('hidden'); return; }
        }
      }
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); this._undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this._redo(); return; }
      if (k === 'f') { this.viewport.fitView(); return; }
      if (k === 'g') { $('#v-grid').classList.toggle('on', this.viewport.toggleGrid()); return; }
      if (this.mode === 'build' && 'wer'.includes(k) && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        this._setXform({ w: 'translate', e: 'rotate', r: 'scale' }[k]); return;
      }
      // single-key tool shortcuts (build mode, something selected) — mirror the
      // right-click menu's accelerators
      if (this.mode === 'build' && !e.ctrlKey && !e.metaKey && this.selectedNodes.length) {
        const reflow = () => { this._renderBuildTree(); this.recompile(); this._pushHistory(); this._renderAlignBar(); };
        const each = (fn) => { this.selectedNodes.forEach((j) => { const n = this.buildTree.nodes[j]; if (n) fn(n); }); reflow(); };
        if (e.shiftKey) {
          if (k === 'e') { this._placeOp('level'); return; }
          if (k === 'r') { this._placeOp('scale'); return; }
          if (k === 'h') { each((n) => { n.hidden = !n.hidden; }); return; }
          if (k === 'b') { this._explodeNode(this.selectedNode); return; }
        } else {
          if (k === 'h') { each((n) => { n.op = n.op === 'hole' ? 'solid' : 'hole'; }); return; }
          if (k === 'l') { each((n) => { n.locked = !n.locked; }); return; }
          if (k === 'b') { this._placeOp('drop'); return; }
          if (k === 'c') { this._placeOp('center'); return; }
          if (k === 's') { this._placeOp('stack'); return; }
          if (k === 'x' || k === 'y' || k === 'z') { this._flip(k); return; }
        }
      }
      if (this.mode === 'build' && (e.ctrlKey || e.metaKey) && k === 'g') {
        e.preventDefault(); if (e.shiftKey) this._ungroup(); else this._group(); return;
      }
      if (this.mode === 'build' && this.selectedNodes.length && !e.ctrlKey && !e.metaKey) {
        const s = e.shiftKey ? 10 : 1;
        const nudge = { ArrowLeft: [-s, 0, 0], ArrowRight: [s, 0, 0], ArrowUp: [0, s, 0], ArrowDown: [0, -s, 0], PageUp: [0, 0, s], PageDown: [0, 0, -s] };
        if (nudge[e.key]) { e.preventDefault(); this._nudge(nudge[e.key]); return; }
      }
      if (this.mode === 'build' && this.selectedNodes.length) {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this._deleteSelected(); }
        else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this._duplicateSelected(); }
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
    // shape/part buttons live in the Add modal; one handler covers them all
    this.root.querySelectorAll('[data-add]').forEach((b) =>
      b.addEventListener('click', () => this._addShape(b.dataset.add)));
    const collapseAll = this.root.querySelector('#collapse-all');
    if (collapseAll) collapseAll.addEventListener('click', () => this._collapseAll());

    // Add modal: open / close / backdrop-dismiss
    const modal = this.root.querySelector('#add-modal');
    const openBtn = this.root.querySelector('#add-open');
    const closeBtn = this.root.querySelector('#add-close');
    if (openBtn) openBtn.addEventListener('click', () => this._openAddModal());
    if (closeBtn) closeBtn.addEventListener('click', () => this._closeAddModal());
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) this._closeAddModal(); });

    // STL import (from the modal's Import category)
    const fileInput = this.root.querySelector('#stl-file');
    const importBtn = this.root.querySelector('#modal-import');
    if (importBtn && fileInput) {
      importBtn.addEventListener('click', () => { fileInput.click(); this._closeAddModal(); });
      fileInput.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._importSTLFile(f);
        e.target.value = '';
      });
    }
    this._renderBuildTree();
  }

  _openAddModal() {
    // Adding parts is a build-mode action; if in code, switch first (carrying
    // the design over via the importer). If that can't happen, don't open.
    if (this.mode !== 'build') {
      this._switchMode('build');
      if (this.mode !== 'build') return;
    }
    const m = this.root.querySelector('#add-modal');
    if (!m) return;
    m.classList.remove('hidden');
    this._positionAddModal();
  }

  // Stick the modal panel just under the "+" button (clamped to the viewport).
  _positionAddModal() {
    const btn = this.root.querySelector('#add-open');
    const panel = this.root.querySelector('#add-modal .modal-panel');
    if (!btn || !panel) return;
    const r = btn.getBoundingClientRect();
    const gap = 8;
    panel.style.top = `${r.bottom + gap}px`;
    panel.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - gap - 14)}px`;
    let left = r.left;
    const pw = panel.offsetWidth;
    if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;
    panel.style.left = `${Math.max(12, left)}px`;
  }
  _closeAddModal() { const m = this.root.querySelector('#add-modal'); if (m) m.classList.add('hidden'); }

  // Read a user-chosen STL, build a watertight solid, and add it as a part.
  _importSTLFile(file) {
    const isObj = /\.obj$/i.test(file.name);
    const reader = new FileReader();
    reader.onerror = () => this._toast('Could not read the file');
    reader.onload = () => {
      let man;
      try { man = isObj ? importOBJ(reader.result) : importSTL(reader.result); }
      catch (err) { this._toast(`Import failed — not a valid ${isObj ? 'OBJ' : 'STL'}`); return; }
      if (!man || man.numTri() === 0) { this._toast('Import failed — mesh is not watertight'); try { man && man.delete(); } catch { /* freed */ } return; }
      const id = (isObj ? 'obj-' : 'stl-') + (this._meshSeq = (this._meshSeq || 0) + 1);
      registerSolid(id, man);
      const node = this.buildTree.add('imported');
      node.meshId = id;
      node.meshName = file.name.replace(/\.(stl|obj)$/i, '');
      const idx = this.buildTree.nodes.length - 1;
      this.selectedNodes = [idx];
      this.selectedNode = idx;
      this._renderBuildTree();
      this.recompile(true);
      this._pushHistory();
      this._renderAlignBar();
      this._toast(`Imported ${file.name}`);
    };
    if (isObj) reader.readAsText(file); else reader.readAsArrayBuffer(file);
  }

  _addShape(kind) {
    const node = this.buildTree.add(kind);
    const idx = this.buildTree.nodes.length - 1;
    // If a workplane is active, spawn the part oriented to and resting on it.
    // node.pos[2] currently holds the kind's sit-on-plate offset (base height),
    // so we offset the origin along the plane normal by that amount.
    if (node && this.workplane) {
      const { origin: o, normal: n, rot } = this.workplane;
      const h = node.pos[2];
      const r2 = (v) => Math.round(v * 100) / 100 || 0;
      node.pos = [r2(o[0] + n[0] * h), r2(o[1] + n[1] * h), r2(o[2] + n[2] * h)];
      node.rot = [...rot];
    }
    this.selectedNodes = idx >= 0 ? [idx] : [];
    this.selectedNode = idx;
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._renderAlignBar();
    this._closeAddModal();
  }

  // Arm a face pick to set the build workplane; clicking empty space resets to
  // ground. New shapes then spawn on this plane until reset.
  _pickWorkplane() {
    this._toast('Click a face to set the workplane (or empty space for ground)');
    this.viewport.armWorkplanePick((info) => {
      this.workplane = info;
      this.viewport.setWorkplane(info);
      this._toast(info ? 'Workplane set — new shapes build on this face' : 'Workplane reset to ground');
    });
  }

  _resetWorkplane() {
    this.workplane = null;
    this.viewport.setWorkplane(null);
    this._toast('Workplane: ground');
  }

  // Drop the selected part flat onto a face you click on another part: orient
  // its "up" to the face normal and seat its base on the face (snap to surface).
  _placeOnFace() {
    if (this.selectedNode < 0) { this._toast('Select a part first, then click a face to drop it onto'); return; }
    const idx = this.selectedNode;
    this._toast('Click the face to drop this part onto');
    this.viewport.armWorkplanePick((info) => {
      if (!info) { this._toast('Place on face — cancelled'); return; }
      const node = this.buildTree.nodes[idx];
      if (!node) return;
      const ext = this.viewport.shapeLocalZ(idx);
      const off = ext ? -ext.minZ : 0; // origin -> base, along the face normal
      const { origin: o, normal: n, rot } = info;
      const r2 = (v) => Math.round(v * 100) / 100 || 0;
      node.rot = [...rot];
      node.pos = [r2(o[0] + n[0] * off), r2(o[1] + n[1] * off), r2(o[2] + n[2] * off)];
      this._renderBuildTree();
      this.recompile();
      this._pushHistory();
      this._renderAlignBar();
      this._toast('Placed on face');
    });
  }

  _deleteNode(i) {
    this.buildTree.nodes.splice(i, 1);
    this.selectedNode = -1;
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
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
    this._pushHistory();
  }

  _renderBuildTree() {
    const host = this.root.querySelector('#build-list');
    host.innerHTML = '';
    if (this.buildTree.nodes.length === 0) {
      host.innerHTML = '<p class="muted">Tap a shape above to add it. Click a shape in the scene and drag it on the plate. Mark each one solid or hole, then export.</p>';
      return;
    }
    const KINDS = ['box', 'cylinder', 'sphere', 'cone', 'pyramid', 'torus', 'wedge', 'dome', 'slot', 'star', 'roundedBox', 'roundedCylinder', 'chamferedBox', 'chamferedCylinder', 'tube', 'prism', 'text', 'thread', 'bolt', 'nut'];
    const KIND_LABEL = { roundedBox: 'rounded', roundedCylinder: 'r-cyl', chamferedBox: 'cham-box', chamferedCylinder: 'cham-cyl', thread: 'rod' };
    const COUNT_KEYS = new Set(['sides', 'segments', 'n', 'count', 'teeth', 'points']);
    const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    this.buildTree.nodes.forEach((node, idx) => {
      const row = document.createElement('div');
      row.className = 'build-node'
        + (node.op === 'hole' ? ' is-hole' : '')
        + (idx === this.selectedNode ? ' sel' : '')
        + (node.hidden ? ' is-hidden' : '')
        + (node.collapsed ? ' collapsed' : '');
      row.dataset.node = idx;
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const dims = node.fields.map((f) => {
        if (f.type === 'text') {
          return `<label class="bn-text">${f.label}<input type="text" value="${esc(f.value)}" data-field="${idx}:${f.key}" spellcheck="false"></label>`;
        }
        const isCount = COUNT_KEYS.has(f.key);
        return `<label${isCount ? '' : ' data-unit="mm"'}>${f.label}<input type="number" step="${isCount ? 1 : 0.5}" value="${f.value}" data-field="${idx}:${f.key}"></label>`;
      }).join('');
      row.innerHTML = `
        <div class="bn-head">
          <button class="bn-collapse" data-collapse="${idx}" title="${node.collapsed ? 'Expand' : 'Collapse'}">${node.collapsed ? '▸' : '▾'}</button>
          ${node.group != null ? `<span class="bn-grp" title="Group ${node.group}">G${node.group}</span>` : ''}
          ${node.kind === 'imported'
            ? `<span class="bn-type bn-imported" title="Imported mesh">⬇ ${esc(node.meshName || 'mesh')}</span>`
            : `<select class="bn-type" data-type="${idx}" title="Shape type">
            ${KINDS.map((k) => `<option value="${k}" ${k === node.kind ? 'selected' : ''}>${KIND_LABEL[k] || k}</option>`).join('')}
          </select>`}
          <span class="bn-color-wrap">
            <input type="color" class="bn-swatch" data-color="${idx}" value="${hex(node.color)}" title="Pick colour" ${node.op === 'hole' ? 'disabled' : ''}>
            <input type="text" class="bn-hex" data-hex="${idx}" value="${hex(node.color)}" maxlength="7" spellcheck="false" title="Hex colour" ${node.op === 'hole' ? 'disabled' : ''}>
          </span>
        </div>
        <div class="bn-toolbar">
          <button class="bn-op ${node.op}" data-op="${idx}" title="Toggle solid / hole">${node.op}</button>
          <div class="bn-actions">
            <button class="bn-ic ${node.locked ? 'on' : ''}" data-lock="${idx}" title="Lock position">${node.locked ? '🔒' : '🔓'}</button>
            <button class="bn-ic" data-hide="${idx}" title="${node.hidden ? 'Show' : 'Hide'}">${node.hidden ? '🚫' : '👁'}</button>
            <button class="bn-ic" data-clone="${idx}" title="Duplicate (Ctrl+D)">⧉</button>
            <button class="bn-ic bn-del" data-del="${idx}" title="Delete">✕</button>
          </div>
        </div>
        ${isFastener(node.kind) ? `<div class="bn-size">
          <label>standard size<select data-size="${idx}">
            <option value="">custom</option>
            ${METRIC_SIZES.map((s) => `<option value="${s.key}" ${currentMetricSize(node) === s.key ? 'selected' : ''}>${s.key}</option>`).join('')}
          </select></label>
          <span class="bn-size-hint">sets Ø + pitch${node.kind === 'thread' ? '' : ' + hex'}</span>
        </div>` : ''}
        <div class="bn-fields">${dims}</div>
        <div class="bn-fields bn-xyz">
          <label data-unit="mm">x<input type="number" step="0.5" value="${node.pos[0]}" data-pos="${idx}:0"></label>
          <label data-unit="mm">y<input type="number" step="0.5" value="${node.pos[1]}" data-pos="${idx}:1"></label>
          <label data-unit="mm">z<input type="number" step="0.5" value="${node.pos[2]}" data-pos="${idx}:2"></label>
          <label data-unit="°">rx<input type="number" step="15" value="${node.rot[0]}" data-rot="${idx}:0"></label>
          <label data-unit="°">ry<input type="number" step="15" value="${node.rot[1]}" data-rot="${idx}:1"></label>
          <label data-unit="°">rz<input type="number" step="15" value="${node.rot[2]}" data-rot="${idx}:2"></label>
        </div>
        ${(supportsClearance(node.kind) || isShellable(node.kind)) ? `<div class="bn-clear">
          ${supportsClearance(node.kind) ? `<label>fit clearance<input type="number" step="0.05" value="${node.clearance || 0}" data-clear="${idx}"></label>` : ''}
          ${isShellable(node.kind) ? `<label>wall (hollow)<input type="number" step="0.2" value="${node.hollow || 0}" data-hollow="${idx}"></label>` : ''}
          <span class="bn-clear-hint">mm · press-fit / hollow shell</span>
        </div>` : ''}
        ${supportsFillet(node.kind) ? `<div class="bn-clear">
          <label>edge fillet<input type="number" step="0.5" min="0" value="${node.fillet || 0}" data-fillet="${idx}"></label>
          <label class="bn-bevel-lab"><input type="checkbox" data-bevel="${idx}" ${node.bevel ? 'checked' : ''}> bevel</label>
          <span class="bn-clear-hint">mm · rounds edges (✓ = chamfer)</span>
        </div>` : ''}`;
      row.addEventListener('mousedown', (e) => {
        if (e.target.closest('input, button, select')) return;
        this._selectNode(idx, e.shiftKey || this.multiSelect);
      });
      host.appendChild(row);
    });

    const nodes = this.buildTree.nodes;
    host.querySelectorAll('[data-type]').forEach((el) => el.addEventListener('change', () => {
      setNodeKind(nodes[+el.dataset.type], el.value); this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-color]').forEach((el) => el.addEventListener('input', () => {
      const i = +el.dataset.color;
      nodes[i].color = parseInt(el.value.slice(1), 16);
      const hx = host.querySelector(`[data-hex="${i}"]`); if (hx) hx.value = el.value;
      this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-hex]').forEach((el) => el.addEventListener('input', () => {
      let v = el.value.trim(); if (v[0] !== '#') v = '#' + v;
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) return; // hold until it's a complete hex
      const i = +el.dataset.hex;
      nodes[i].color = parseInt(v.slice(1), 16);
      const sw = host.querySelector(`[data-color="${i}"]`); if (sw) sw.value = v;
      this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-op]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.op]; n.op = n.op === 'hole' ? 'solid' : 'hole'; this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-lock]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.lock]; n.locked = !n.locked; this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-hide]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.hide]; n.hidden = !n.hidden; this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-collapse]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.collapse]; n.collapsed = !n.collapsed;
      el.closest('.build-node').classList.toggle('collapsed', n.collapsed);
      el.textContent = n.collapsed ? '▸' : '▾';
      el.title = n.collapsed ? 'Expand' : 'Collapse';
      this._updateCollapseAllLabel();
    }));
    host.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => this._deleteNode(+el.dataset.del)));
    host.querySelectorAll('[data-clone]').forEach((el) => el.addEventListener('click', () => {
      this._selectNode(+el.dataset.clone, false); this._duplicateSelected();
    }));
    host.querySelectorAll('[data-field]').forEach((el) => el.addEventListener('input', () => {
      const [i, key] = el.dataset.field.split(':');
      const f = nodes[+i].fields.find((x) => x.key === key);
      f.value = f.type === 'text' ? el.value : parseFloat(el.value);
      this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-pos]').forEach((el) => el.addEventListener('input', () => {
      const [i, a] = el.dataset.pos.split(':'); nodes[+i].pos[+a] = parseFloat(el.value); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-rot]').forEach((el) => el.addEventListener('input', () => {
      const [i, a] = el.dataset.rot.split(':'); nodes[+i].rot[+a] = parseFloat(el.value); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-clear]').forEach((el) => el.addEventListener('input', () => {
      nodes[+el.dataset.clear].clearance = parseFloat(el.value) || 0; this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-hollow]').forEach((el) => el.addEventListener('input', () => {
      nodes[+el.dataset.hollow].hollow = Math.max(0, parseFloat(el.value) || 0); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-fillet]').forEach((el) => el.addEventListener('input', () => {
      nodes[+el.dataset.fillet].fillet = Math.max(0, parseFloat(el.value) || 0); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-bevel]').forEach((el) => el.addEventListener('change', () => {
      nodes[+el.dataset.bevel].bevel = el.checked; this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-size]').forEach((el) => el.addEventListener('change', () => {
      if (!el.value) return;
      applyMetricSize(nodes[+el.dataset.size], el.value);
      this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    this._updateCollapseAllLabel();
  }

  // The "collapse/expand all" control reflects and flips every part card's
  // collapsed state (purely a UI fold — no recompile).
  _updateCollapseAllLabel() {
    const btn = this.root.querySelector('#collapse-all');
    if (!btn) return;
    const nodes = this.buildTree.nodes;
    btn.style.display = nodes.length ? '' : 'none';
    btn.textContent = (nodes.length && nodes.every((n) => n.collapsed)) ? 'expand all' : 'collapse all';
  }

  _collapseAll() {
    const nodes = this.buildTree.nodes;
    if (!nodes.length) return;
    const anyExpanded = nodes.some((n) => !n.collapsed);
    nodes.forEach((n) => { n.collapsed = anyExpanded; });
    this._renderBuildTree();
  }

  // --- markup ---------------------------------------------------------------

  _render() {
    this.root.innerHTML = `
      <div id="boot"><div class="boot-inner"><span class="boot-mark">◆</span><p>loading kernel…</p></div></div>

      <div class="stage">
        <canvas id="viewport-canvas"></canvas>

        <header class="topbar">
          <button class="icon-btn on" id="panel-toggle" title="Toggle panel">☰</button>
          <div class="brand"><span class="brand-mark">◆</span> Rand<em>R</em></div>
          <div class="tabs">
            <button data-mode="code" class="active">code</button>
            <button data-mode="build">build</button>
          </div>
          <button class="icon-btn add-btn" id="add-open" title="Add a shape, part, or ready-made object">+</button>
          <div class="spacer"></div>
          <div class="viewtools">
            <button class="icon-btn" id="v-undo" title="Undo (Ctrl+Z)">↶</button>
            <button class="icon-btn" id="v-redo" title="Redo (Ctrl+Y)">↷</button>
            <span class="tb-sep"></span>
            <button class="icon-btn" id="v-fit" title="Fit to view (F)">⤢</button>
            <button class="icon-btn" id="v-top" title="Top view">⊟</button>
            <button class="icon-btn" id="v-front" title="Front view">⊡</button>
            <button class="icon-btn on" id="v-grid" title="Toggle grid (G)">▦</button>
            <button class="icon-btn" id="v-wire" title="Toggle wireframe">◇</button>
            <button class="icon-btn" id="v-layers" title="Layer preview — slice into layers">≣</button>
            <button class="icon-btn on" id="v-snap" title="Snap to 1 mm / 15°">⌗</button>
            <button class="icon-btn" id="v-measure" title="Measure distance — click two points">📏</button>
            <button class="icon-btn" id="v-overhang" title="Overhang check — red faces need support">◣</button>
            <button class="icon-btn" id="v-orient" title="Auto-orient for printing (least support)">⤓</button>
            <button class="icon-btn" id="v-fit-plate" title="Scale to fit the build plate">⤡</button>
            <select class="quality-sel" id="v-quality" title="Curve smoothness for round shapes (cylinders, spheres…)">
              <option value="24">◍ Draft</option>
              <option value="48">◍ Standard</option>
              <option value="64" selected>◍ Smooth</option>
              <option value="128">◍ Ultra</option>
            </select>
            <span class="tb-sep"></span>
            <button class="icon-btn" id="help-btn" title="Learn G-code">?</button>
          </div>
          <div class="menu" id="proj-menu">
            <button class="exp" id="proj-btn">🗂 <span id="proj-name">Untitled</span> ▾</button>
            <div class="menu-pop">
              <button id="proj-new">New project</button>
              <button id="proj-save">Save <span class="kbd">Ctrl+S</span></button>
              <button id="proj-saveas">Save as…</button>
              <button id="proj-open">Open / manage…</button>
            </div>
          </div>
          <div class="menu" id="tpl-menu">
            <button class="exp" id="tpl-btn">✦ Templates ▾</button>
            <div class="menu-pop">
              <button data-tpl="soap dish">Soap dish</button>
              <button data-tpl="pen cup">Pen cup</button>
              <button data-tpl="coaster">Coaster</button>
              <button data-tpl="stacking bin">Stacking bin</button>
              <button data-tpl="bolt & nut">Bolt &amp; nut 🔩</button>
            </div>
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
            <div class="editor-wrap">
              <pre class="editor-hl" aria-hidden="true"><code id="editor-code"></code></pre>
              <textarea id="editor" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"></textarea>
            </div>
            <div id="error" class="error"></div>
            <div class="pane-title">parameters</div>
            <div id="params" class="params"></div>
          </section>

          <section id="pane-build" class="pane hidden">
            <input type="file" id="stl-file" accept=".stl,.obj,model/stl,application/sla" hidden>
            <p class="hint">Click to select · drag to move — snaps to nearby parts (hold <b>Alt</b> to free) · Shift-click multi-select · select 2+ to <b>align</b> / <b>group</b> · <b>Del</b> · <b>Ctrl+D</b></p>
            <div class="parts-head">
              <span class="pane-title">parts</span>
              <button id="collapse-all" class="mini-btn" title="Collapse or expand all parts">collapse all</button>
            </div>
            <div id="build-list" class="build-list"></div>
          </section>
        </aside>
        <div id="panel-resize" title="Drag to resize the panel"></div>

        <button id="tools-fab" class="tools-fab hidden" title="Build tools" aria-label="Build tools">
          <span class="tf-ico">⛭</span><span class="tf-label">Tools</span>
        </button>
        <div id="tools-dock" class="tools-dock" role="dialog" aria-label="Build tools">
          <div class="tools-dock-head" id="tools-dock-head">
            <span class="tools-dock-title"><span class="tools-grip">⠿</span> Tools</span>
            <button id="tools-dock-close" class="modal-x" title="Collapse" aria-label="Collapse tools">✕</button>
          </div>
          <div class="tools-dock-body">
            <div class="xform" id="xform">
              <button data-xform="translate" class="on" title="Move (W)">↔ move</button>
              <button data-xform="rotate" title="Rotate (E)">⟳ turn</button>
              <button data-xform="scale" title="Scale (R)">⤢ size</button>
              <button id="multi-toggle" title="Multi-select: tap parts to add them to the selection (no Shift needed — for touch)">⊹ multi</button>
            </div>
            <div class="xform" id="viewbar">
              <span class="xform-label">view</span>
              <button data-view="edit" class="on" title="Edit the parts (ghosts the result of subtract/intersect groups)">◧ edit</button>
              <button data-view="result" title="Preview the combined result">◨ result</button>
            </div>
            <div class="xform" id="wpbar">
              <span class="xform-label">plane</span>
              <button data-wp="face" title="Click a face to build on it">⊞ on face</button>
              <button data-wp="ground" title="Reset the workplane to the ground">⊞ ground</button>
            </div>
            <div class="xform hidden" id="opsbar">
              <span class="xform-label">place</span>
              <button data-op-act="drop" title="Drop onto the plate">⤓ base</button>
              <button data-op-act="center" title="Center on the plate">⊹ center</button>
              <button data-op-act="level" title="Reset rotation">⟲ level</button>
              <button data-op-act="scale" title="Reset scale to 1:1">1:1</button>
              <button data-op-act="stack" title="Rest the last-selected part on top of the others">↥ stack</button>
              <button data-flip="x" title="Mirror across X">⇋X</button>
              <button data-flip="y" title="Mirror across Y">⇋Y</button>
              <button data-flip="z" title="Mirror across Z">⇋Z</button>
            </div>
            <div class="xform hidden" id="arraybar">
              <span class="xform-label">array</span>
              <label class="arr-f">×<input type="number" id="arr-n" value="4" min="2" max="64" step="1"></label>
              <label class="arr-f">gap<input type="number" id="arr-gap" value="25" step="1"></label>
              <button data-arr="x" title="Row along X">↔ X</button>
              <button data-arr="y" title="Row along Y">↕ Y</button>
              <button data-arr="polar" title="Ring around the centre">⟳ ring</button>
            </div>
            <div class="xform hidden" id="alignbar">
              <span class="xform-label">align</span>
              <div class="align-grid">
                <span class="ag-ax">X</span>
                <button data-align="x:min" title="Align left (X min)">⊣</button>
                <button data-align="x:center" title="Center on X">┼</button>
                <button data-align="x:max" title="Align right (X max)">⊢</button>
                <span class="ag-ax">Y</span>
                <button data-align="y:min" title="Align front (Y min)">⊣</button>
                <button data-align="y:center" title="Center on Y">┼</button>
                <button data-align="y:max" title="Align back (Y max)">⊢</button>
                <span class="ag-ax">Z</span>
                <button data-align="z:min" title="Align down (Z min)">⊣</button>
                <button data-align="z:center" title="Center on Z">┼</button>
                <button data-align="z:max" title="Align up (Z max)">⊢</button>
              </div>
            </div>
            <div class="xform hidden" id="groupbar">
              <span class="xform-label">group</span>
              <button data-group="group" title="Group selection (Ctrl+G)">▣ group</button>
              <button data-group="ungroup" title="Ungroup (Ctrl+Shift+G)">▢ ungroup</button>
              <button data-gmode="union" title="Join (union)">∪</button>
              <button data-gmode="subtract" title="Subtract — first part minus the rest">∖</button>
              <button data-gmode="intersect" title="Keep only the overlap (intersection)">∩</button>
              <button data-gmode="hull" title="Hull — smooth blend / loft across the parts">⬭</button>
            </div>
          </div>
        </div>

        <div id="layer-bar" class="layer-bar hidden">
          <span id="layer-label" class="layer-label">layer</span>
          <input type="range" id="layer-range" min="0" max="0" value="0" step="1" aria-label="Layer">
        </div>

        <div id="ctx-menu" class="ctx-menu hidden" role="menu"></div>

        <div id="help-modal" class="modal-overlay center hidden">
          <div class="modal-panel help-panel">
            <div class="modal-head">
              <span class="modal-title">Learn G-code</span>
              <button class="modal-x" id="help-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body help-body">${mdToHtml(gcodeHelp)}</div>
          </div>
        </div>

        <div id="proj-modal" class="modal-overlay center hidden">
          <div class="modal-panel">
            <div class="modal-head">
              <span class="modal-title">Projects</span>
              <button class="modal-x" id="proj-modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
              <div id="proj-list" class="proj-list"></div>
            </div>
          </div>
        </div>

        <div id="name-modal" class="modal-overlay center hidden">
          <div class="modal-panel name-panel">
            <div class="modal-head">
              <span class="modal-title" id="name-title">Name</span>
              <button class="modal-x" id="name-cancel" aria-label="Cancel">✕</button>
            </div>
            <div class="modal-body">
              <input type="text" id="name-input" class="name-input" placeholder="Project name" spellcheck="false" maxlength="60">
              <div class="name-actions"><button id="name-ok" class="add-open-btn">Save</button></div>
            </div>
          </div>
        </div>

        <div id="add-modal" class="modal-overlay hidden">
          <div class="modal-panel" role="dialog" aria-label="Add to scene">
            <div class="modal-head">
              <span class="modal-title">Add to scene</span>
              <button class="modal-x" id="add-close" title="Close (Esc)">✕</button>
            </div>
            <div class="modal-body">
              <section class="cat">
                <h4>Basic shapes</h4>
                <div class="cat-grid">
                  <button data-add="box">□ box</button>
                  <button data-add="cylinder">▮ cylinder</button>
                  <button data-add="sphere">● sphere</button>
                  <button data-add="cone">▲ cone</button>
                  <button data-add="pyramid">◭ pyramid</button>
                  <button data-add="prism">⬡ prism</button>
                  <button data-add="wedge">◣ wedge</button>
                  <button data-add="torus">◍ torus</button>
                  <button data-add="dome">◗ dome</button>
                  <button data-add="slot">▭ slot</button>
                  <button data-add="star">★ star</button>
                </div>
              </section>
              <section class="cat">
                <h4>Rounded &amp; chamfered</h4>
                <div class="cat-grid">
                  <button data-add="roundedBox">▢ round box</button>
                  <button data-add="roundedCylinder">▯ round cyl</button>
                  <button data-add="chamferedBox">◇ cham box</button>
                  <button data-add="chamferedCylinder">⬢ cham cyl</button>
                  <button data-add="tube">◎ tube</button>
                </div>
              </section>
              <section class="cat">
                <h4>Text</h4>
                <div class="cat-grid">
                  <button data-add="text">T text</button>
                </div>
              </section>
              <section class="cat">
                <h4>Fasteners</h4>
                <div class="cat-grid">
                  <button data-add="bolt">🔩 bolt</button>
                  <button data-add="nut">⬢ nut</button>
                  <button data-add="thread">▎ rod</button>
                </div>
              </section>
              <section class="cat">
                <h4>Ready-made · adjustable</h4>
                <div class="cat-grid">
                  <button data-tpl="soap dish">Soap dish</button>
                  <button data-tpl="pen cup">Pen cup</button>
                  <button data-tpl="coaster">Coaster</button>
                  <button data-tpl="stacking bin">Stacking bin</button>
                  <button data-tpl="bolt &amp; nut">Bolt &amp; nut</button>
                  <button data-tpl="washer">Washer</button>
                  <button data-tpl="L-bracket">L-bracket</button>
                  <button data-tpl="knob">Knob</button>
                </div>
              </section>
              <section class="cat">
                <h4>Import</h4>
                <div class="cat-grid">
                  <button id="modal-import">⬇ STL / OBJ file…</button>
                </div>
              </section>
            </div>
          </div>
        </div>

        <div class="hud" id="hud">
          <div class="hud-head">
            <span class="hud-title">readout</span>
            <button class="hud-x" id="hud-toggle" title="Collapse">⌄</button>
          </div>
          <div class="hud-body">
            <div class="hud-row"><span class="hud-key">size</span><span id="hud-dims">—</span></div>
            <div class="hud-row hidden" id="hud-sel-row"><span class="hud-key">select</span><span id="hud-sel">—</span></div>
            <div class="hud-row"><span class="hud-key">volume</span><span id="hud-vol">—</span></div>
            <div class="hud-row"><span class="hud-key">mesh</span><span id="hud-tris">—</span></div>
            <div class="hud-row"><span class="hud-key">state</span><span id="hud-watertight" class="hud-ok">—</span></div>
            <div class="hud-row"><span class="hud-key">fit</span><span id="hud-fit" class="hud-ok">—</span></div>
            <div class="hud-row"><span class="hud-key">filament</span><span id="hud-filament" title="Solid PLA at 1.24 g/cm³ on 1.75 mm filament — sparse infill prints use less">—</span></div>
          </div>
        </div>

        <div class="measure-label" id="measure-label"></div>

        <div class="status">
          <span id="status-dot" class="status-dot state-empty"></span>
          <span id="status-label">empty</span>
        </div>
      </div>`;
  }
}
