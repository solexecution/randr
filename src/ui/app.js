// Application controller. Ties the three surfaces together:
//   1. Code pane  — the parametric mini-language (OpenSCAD-style)
//   2. Build pane — touch primitives you place/drag on the workplane (Tinkercad)
//   3. Viewport   — the shared result of whichever pane is active
//
// Both panes ultimately produce mini-language source, so the kernel only ever
// sees one input format. The build pane is a structured editor that emits
// source; a touch-built model can be opened in the code pane and vice versa.

import { loadKernel, inspect, meshSolid, importSTL, importOBJ, import3MF, registerSolid, solidMesh, setCurveQuality } from '../kernel/manifold.js';
import { compile } from '../lang/compile.js';
import { exportSTL, exportOBJ, export3MF, export3MFColored } from '../kernel/export.js';
import { Viewport, BUILD_VOLUME } from './viewport.js';
import { buildTreeToSource, buildColoredParts, BuildTree } from './buildtree.js';
import { ADDABLE_KINDS } from './primitives.js';
import { nodeToGeometry } from './nodeGeometry.js';
import { scoreOrientations } from '../kernel/orient.js';
import { wrapPrintPrep } from './printPrep.js';
import { sourceToNodes } from './importBuild.js';
import { addGalleryHTML } from './addGallery.js';
import { highlightCode, mdToHtml } from './highlight.js';
import { CommandPalette } from './commandPalette.js';
import { ContextMenu } from './contextMenu.js';
import { Toolbar } from './toolbar.js';
import { esc } from './escape.js';
import { appHTML } from './template.js';
import { STARTER, TEMPLATES } from './templates.js';
import { installEvents } from './events.js';
import { installBuildPane } from './buildPane.js';
import { RECIPES } from './recipes.js';
import gcodeHelp from '../help/gcode.md?raw';
import { ProjectStore } from './projectStore.js';

// Round the corners of a closed polygon by radius r (tessellated arcs), so a
// drawn sketch can have curved/organic edges. Clamps r per-corner to the
// shorter adjoining edge; collinear corners pass through unchanged.
function roundCorners(pts, r, seg = 6) {
  if (!(r > 0) || pts.length < 3) return pts;
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const cur = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const v1 = [prev[0] - cur[0], prev[1] - cur[1]];
    const v2 = [next[0] - cur[0], next[1] - cur[1]];
    const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
    if (l1 < 1e-6 || l2 < 1e-6) { out.push(cur); continue; }
    const u1 = [v1[0] / l1, v1[1] / l1], u2 = [v2[0] / l2, v2[1] / l2];
    const ang = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (ang < 1e-3 || Math.PI - ang < 1e-3) { out.push(cur); continue; } // straight
    const t = Math.min(r / Math.tan(ang / 2), Math.min(l1, l2) / 2);
    const rr = t * Math.tan(ang / 2);
    const bis = [u1[0] + u2[0], u1[1] + u2[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    if (bl < 1e-6) { out.push(cur); continue; }
    const c = [cur[0] + (bis[0] / bl) * (rr / Math.sin(ang / 2)), cur[1] + (bis[1] / bl) * (rr / Math.sin(ang / 2))];
    const p1 = [cur[0] + u1[0] * t, cur[1] + u1[1] * t];
    const p2 = [cur[0] + u2[0] * t, cur[1] + u2[1] * t];
    let a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
    const a2 = Math.atan2(p2[1] - c[1], p2[0] - c[0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    for (let k = 0; k <= seg; k++) { const a = a1 + d * (k / seg); out.push([Math.round((c[0] + rr * Math.cos(a)) * 100) / 100, Math.round((c[1] + rr * Math.sin(a)) * 100) / 100]); }
  }
  return out;
}

export class App {
  constructor(root) {
    this.root = root;
    this.mode = 'code';            // 'code' | 'build'
    this._sketchMode = 'extrude';  // sketch tool: 'extrude' | 'revolve'
    this.source = STARTER;
    this.overrides = {};
    this.params = [];
    this.currentModel = null;
    this.printRot = [0, 0, 0]; // print orientation (deg) wrapped around the model at compile
    this.printScale = 1; // uniform scale-to-fit wrapped around the model at compile (1 = none)
    this.printCut = 0; // >0 bisects the model (gap mm) into two repacked halves at compile
    this.curveQuality = 64; // segment count for round primitives (Smooth) — see QUALITY_LEVELS
    this.buildTree = new BuildTree();
    this.cmd = new CommandPalette(this); // Ctrl+K command palette (owns its own modal state)
    this.ctx = new ContextMenu(this); // right-click action hub
    this.projects = new ProjectStore(this); // project lifecycle (save/open/delete/recent)
    this.selectedNodes = []; // the selection set; selectedNode (primary) derives from it
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
    this.viewport.onSelect = (i, additive) => { this._selectNode(i, additive); if (i >= 0 && !additive) this._setPanelTab('edit'); else if (i < 0 && this._panelTab === 'edit') this._setPanelTab('parts'); };
    this.viewport.onMultiArm = (on) => this._onMultiArm(on);
    this.viewport.onContext = (i, x, y) => this._showContextMenu(i, x, y);
    this.viewport.onShapeMove = (i, pos) => this._onShapeMove(i, pos);
    this.viewport.onShapeMoveEnd = (i, pos) => this._onShapeMoveEnd(i, pos);
    this.viewport.onTransform = (i, t) => this._onTransform(i, t);
    this.viewport.onTransformEnd = (i) => this._onTransformEnd(i);
    this.viewport.onSketchComplete = (pts) => this._onSketchComplete(pts);
    window.__forgeExport = { exportSTL, export3MF, export3MFColored, exportOBJ, build3MF: () => this._build3MF() }; // scripting/test hook
    window.__dbg = { src: () => buildTreeToSource(this.buildTree), compile, meshSolid, importSTL, importOBJ, import3MF, registerSolid, coloredParts: () => buildColoredParts(this.buildTree) }; // debug
    window.__recipes = RECIPES; // simple-mode makes (test hook)
    this._bindEvents();
    this._initToolbar();  // make the left tool strip draggable + dockable (restore saved spot)
    this._initTheme();    // apply saved light/dark before the first compile tints the meshes
    this._initLayout();   // apply saved layout (side inspector vs bottom bar)
    this.recompile(true);
    this._pushHistory();
    this._initProjects(); // restore last project (or adopt the starter as the first)
    this.viewport.homeView(); // open framed on the whole plate, from the front
    this.root.querySelector('#boot').classList.add('gone');
  }

  // --- floating / dockable / customizable left toolbar ----------------------
  // The tool strip is its own module (see toolbar.js). App wires the behaviors
  // its buttons trigger and pushes state in for them to reflect; the module owns
  // the layout, persistence, drag/dock, and the ✎ customise modal.
  _initToolbar() {
    this.toolbar = new Toolbar(this.root);
    this.toolbar.onQualityChange = (lvl) => { this._setQuality(lvl.v); this._toast(`Curve quality: ${lvl.name}`); };
    this.toolbar.init({ mode: this.mode, curveQuality: this.curveQuality });
    this._syncModeSeg(); // reflect the initial workspace on the top-bar control
  }

  // Reflect the live mode + curve-quality on the toolbar's shell buttons.
  _syncToolbar() { this.toolbar?.syncState({ mode: this.mode, curveQuality: this.curveQuality }); }

  // Set curve smoothness, sync the button, and recompile (user-initiated). Also
  // reachable from the command palette, so it lives on App rather than Toolbar.
  _setQuality(v) {
    this.curveQuality = v;
    setCurveQuality(v);
    this._syncToolbar();
    this.recompile();
  }

  // --- theme (light / dark) -------------------------------------------------

  _initTheme() {
    let saved = 'dark';
    try { saved = localStorage.getItem('randr.theme') || 'dark'; } catch { /* private mode */ }
    this._applyTheme(saved === 'light', false); // start()'s first recompile tints the meshes
  }

  _setTheme(light) { this._applyTheme(light, true); }

  // Flip the whole app between dark and light: the <html> class drives the CSS,
  // the viewport themes the WebGL scene, and a recompile re-tints part meshes.
  _applyTheme(light, recompile = true) {
    this._lightTheme = !!light;
    document.documentElement.classList.toggle('theme-light', this._lightTheme);
    if (this.viewport) this.viewport.setTheme(this._lightTheme ? 'light' : 'dark');
    const b = document.querySelector('#v-theme');
    if (b) {
      b.classList.toggle('on', this._lightTheme);
      b.textContent = this._lightTheme ? '◑' : '◐';
      b.title = this._lightTheme ? 'Light mode — tap for dark' : 'Dark mode — tap for light';
    }
    try { localStorage.setItem('randr.theme', this._lightTheme ? 'light' : 'dark'); } catch { /* ignore */ }
    if (recompile && this.viewport) this.recompile();
  }

  // --- compile + render loop ------------------------------------------------

  // The exact source the kernel should compile: the active model (build tree or
  // code source) wrapped with the print-prep transforms — orientation,
  // scale-to-fit, bisect. One definition so every compile path that must agree
  // (recompile + the single-shape HUD refresh, hence currentModel and export)
  // sees identical geometry. No-op at defaults. (Auto-orient / scale-to-fit build
  // their own measuring source — they compute a *replacement* rotation/scale.)
  _effectiveSource() {
    const base = this.mode === 'build' ? buildTreeToSource(this.buildTree) : this.source;
    return wrapPrintPrep(base, { rot: this.printRot, scale: this.printScale, cut: this.printCut });
  }

  recompile(frame = false) {
    if (this._layerMode) this._exitLayers(); // any model change leaves the slice preview
    this._syncBuildTools(); // keep the floating tools button in sync with the mode
    const source = this._effectiveSource();

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
      this._renderResult();
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
    this.selectedNodes = this.selectedNodes.filter((i) => i < this.buildTree.nodes.length);    this.viewport.setSelection(this.selectedNodes);
    this._highlightBuildRows();
    this._renderAlignBar();
    this._updatePartsHeader();
  }

  // The ghost preview only helps when the combined result differs from the
  // parts — i.e. a subtract/intersect group is present.
  _wantGhost() {
    return this.buildTree.nodes.some((n) => !n.hidden && n.group != null && n.groupMode && n.groupMode !== 'union');
  }

  // Render the merged result solid. In build mode each top-level part keeps its
  // own colour (compiled the same way coloured 3MF export does) so edit->result
  // only cuts holes + locks parts rather than flipping everything to flat teal.
  // Code mode (and any compile failure) falls back to the single teal solid.
  _renderResult() {
    if (this.mode === 'build' && this.currentModel) {
      const parts = buildColoredParts(this.buildTree)
        .map((p) => {
          try { const m = compile(p.source, {}).result; return m ? { manifold: m, color: p.color } : null; }
          catch { return null; }
        })
        .filter(Boolean);
      if (parts.length) {
        this.viewport.setColoredModel(parts);
        for (const p of parts) { try { p.manifold.delete(); } catch { /* freed */ } }
        return;
      }
    }
    this.viewport.setModel(this.currentModel || null);
  }

  // Toggle the build view: 'edit' (parts + result ghost) vs 'result' (the
  // combined solid). The toggle is how you get back to editing — no separate
  // enter-group step needed.
  _setViewMode(mode) {
    this.viewMode = mode;
    this._syncModeSeg();
    if (mode === 'result') this._setPanel(false); // clean preview — tuck the source panel away
    if (this.mode !== 'build') return;
    if (mode === 'result') {
      this.viewport.setEditMode(false);
      this._renderResult();
      this.viewport.setGhost(null);
    } else {
      this.viewport.setEditMode(true);
      this._renderEditShapes();
      this.viewport.setGhost(this._wantGhost() ? this.currentModel : null);
    }
  }

  // The top-bar code / build / result control. code & build are the two
  // authoring modes; result is a *preview* of the merged solid that preserves
  // the mode you're in — tapping code or build returns to that editor — so it
  // never triggers the lossy code<->build conversion _switchMode does. (In code
  // mode the viewport already shows the merged solid; result just hides the
  // source panel for a clean look, via the body.view-result class.)
  _setWorkspace(view) {
    if (view === 'result') {
      if (this.viewMode !== 'result') this._setViewMode('result');
    } else {
      if (this.viewMode === 'result') this._setViewMode('edit'); // leave the preview first
      this._switchMode(view); // no-op if already in this mode; may refuse (and stay) if code can't lift
    }
    this._syncModeSeg();
  }

  // Reflect the live workspace on the top-bar segmented control + the
  // result-preview body class. The selected segment is derived: result wins when
  // the view is the merged-solid preview, else it's the authoring mode.
  _syncModeSeg() {
    const view = this.viewMode === 'result' ? 'result' : this.mode; // 'code' | 'build' | 'result'
    document.body.classList.toggle('view-result', view === 'result');
    this.root.querySelectorAll('#mode-seg .modeseg-opt[data-view]').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // the 4th control is an independent toggle (not a mode): lit while the current
    // mode's sidebar is open — the code panel in code, the parts inspector elsewhere
    const panelBtn = this.root.querySelector('#seg-panel');
    if (panelBtn) {
      let open;
      if (this.mode === 'code') {
        const panel = this.root.querySelector('#panel');
        open = !!panel && !panel.classList.contains('collapsed');
      } else {
        const card = this.root.querySelector('#part-card');
        open = !!card && !card.classList.contains('hidden') && !this._cardCollapsed;
      }
      panelBtn.classList.toggle('on', open);
      panelBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    }
  }

  // Print-prep overlays (cut-in-half, overhang) render on the merged RESULT
  // view, where individual parts aren't selectable. Keep the view in sync so
  // turning one ON shows the result and turning the LAST one OFF returns to the
  // editable parts — otherwise selection gets stuck after a cut.
  _syncPrepView() {
    if (this.mode !== 'build') return;
    const needsResult = this.printCut > 0 || this.overhangMode;
    if (needsResult && this.viewMode !== 'result') this._setViewMode('result');
    else if (!needsResult && this.viewMode !== 'edit') this._setViewMode('edit');
  }

  // All node indices that share a node's group (or just itself if ungrouped).
  _members(i) {
    const nodes = this.buildTree.nodes;
    const g = nodes[i] ? nodes[i].group : null;
    if (g == null) return [i];
    return nodes.map((n, k) => (n.group === g ? k : -1)).filter((k) => k >= 0);
  }

  // Single source of truth for the additive ("multi") selection mode, shared by
  // the card's ⊹ toggle and the scene long-press gesture.
  _setMultiSelect(on) {
    this.multiSelect = on;
    if (this.viewport) this.viewport.multiSelect = on;
    const b = this.root.querySelector('#multi-toggle');
    if (b) b.classList.toggle('on', on);
  }

  // Called by the viewport when a long-press arms (or an empty tap finishes)
  // multi-select.
  _onMultiArm(on) {
    this._setMultiSelect(on);
    this._toast(on
      ? 'Multi-select on — tap parts to add · tap empty space to finish'
      : 'Multi-select off');
  }

  // Primary selection = the last node in the set, -1 when empty. selectedNodes is
  // the single source of truth; this derives from it (no hand-kept dual state).
  get selectedNode() {
    return this.selectedNodes.length ? this.selectedNodes[this.selectedNodes.length - 1] : -1;
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
    }    this.viewport.setSelection(this.selectedNodes);
    this._highlightBuildRows();
    this._renderAlignBar();
    this._updatePartsHeader();
  }

  _highlightBuildRows() {
    this._renderBuildTree(); // re-render the roster + the modal detail for the new selection
  }

  // The build tools live in a floating dock (bottom-right). Show its button only
  // in build mode, and collapse the dock when leaving build so it never lingers
  // over the code view.
  _syncBuildTools() {
    const build = this.mode === 'build';
    const show = build; // the inspector panel is build-mode only (settings is its own modal now)
    const card = this.root.querySelector('#part-card');
    if (card) card.classList.toggle('hidden', !show);
    this._setPanel(!build); // the code editor panel shows only in code mode
    this._applyCardLayout();
  }

  // Keep the HUD (top-left) and nav-cube (top-right) clear of a side-docked
  // card on desktop, by flagging the dock side on the stage (see styles.css).
  _applyCardLayout() {
    const stage = this.root.querySelector('.stage');
    if (!stage) return;
    const build = this.mode === 'build';
    const dock = this._cardDock || 'right';
    const collapsed = !!this._cardCollapsed;
    // the HUD / nav-cube only need to dodge an *expanded* side dock
    const sideDock = this._layout !== 'bottom'; // the bottom sheet doesn't push the HUD/cube
    stage.classList.toggle('cardleft', sideDock && build && dock === 'left' && !collapsed);
    stage.classList.toggle('cardright', sideDock && build && dock === 'right' && !collapsed);
    const toggleBtn = this.root.querySelector('#parts-toggle');
    if (toggleBtn) {
      toggleBtn.classList.toggle('hidden', !build);          // only relevant in build mode
      toggleBtn.classList.toggle('on', build && !collapsed); // lit while the panel is open
    }
    const minBtn = this.root.querySelector('#card-min');
    if (minBtn) { minBtn.textContent = dock === 'right' ? '»' : '«'; minBtn.title = 'Hide the parts panel'; }
    this._syncModeSeg(); // the ◨ side-panel toggle reflects the parts inspector in build/result
  }

  _saveCardDock() {
    try { localStorage.setItem('randr.cardDock', JSON.stringify({ mode: this._cardDock || 'right', collapsed: !!this._cardCollapsed })); } catch { /* quota */ }
  }

  _initLayout() {
    let saved = null;
    try { saved = localStorage.getItem('randr.layout'); } catch { /* private mode */ }
    if (!saved) {
      // smart default: touch / narrow screens (tablet) → bottom bar; PC → side panel
      const tablet = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || window.innerWidth < 1100;
      saved = tablet ? 'bottom' : 'inspector';
    }
    this._applyLayout(saved === 'bottom' ? 'bottom' : 'inspector');
  }

  _toggleLayout() { this._applyLayout(this._layout === 'bottom' ? 'inspector' : 'bottom'); }

  // Switch between the side inspector (mode 1) and the bottom bar (mode 4).
  _applyLayout(layout) {
    this._layout = layout === 'bottom' ? 'bottom' : 'inspector';
    document.body.classList.toggle('layout-bottom', this._layout === 'bottom');
    document.body.classList.toggle('layout-inspector', this._layout === 'inspector');
    const b = this.root.querySelector('#card-layout');
    if (b) {
      b.classList.toggle('on', this._layout === 'bottom');
      b.title = this._layout === 'bottom' ? 'Tablet layout (bottom) — tap for PC (side panel)' : 'PC layout (side) — tap for tablet (bottom bar)';
    }
    try { localStorage.setItem('randr.layout', this._layout); } catch { /* ignore */ }
    this._applyCardLayout();
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
    this.selectedNodes = this._members(sel[sel.length - 1]);    this._renderBuildTree();
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
    this.selectedNodes = nodes.map((x, i) => (x.group === gid ? i : -1)).filter((i) => i >= 0);    this._renderBuildTree();
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
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._renderAlignBar();
  }

  // Remove every part — a fresh, empty plate (undoable via history).
  _clearCanvas() {
    if (!this.buildTree.nodes || !this.buildTree.nodes.length) return;
    this.buildTree.nodes = [];
    this.selectedNodes = [];
    if (this._panelTab === 'edit') this._setPanelTab('parts');
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._renderAlignBar();
    this._toast('Canvas cleared');
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
    this.selectedNodes = copies.map((_, k) => start + k);    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._renderAlignBar();
  }

  // The right-click context menu lives in ContextMenu (contextMenu.js); App owns
  // the instance (this.ctx) and forwards the viewport's onContext callback to it.
  _showContextMenu(i, x, y) { this.ctx.show(i, x, y); }

  // Build-tree edits shared by the keyboard shortcuts and the context menu, so
  // the per-node mutation + the reflow live in one place (not copied in both).
  _reflowBuild() { this._renderBuildTree(); this.recompile(); this._pushHistory(); this._renderAlignBar(); }
  _mutateNodes(indices, fn) { indices.forEach((j) => { const n = this.buildTree.nodes[j]; if (n) fn(n); }); this._reflowBuild(); }
  _toggleHole(indices) { this._mutateNodes(indices, (n) => { n.op = n.op === 'hole' ? 'solid' : 'hole'; }); }
  _toggleLock(indices) { this._mutateNodes(indices, (n) => { n.locked = !n.locked; }); }
  _toggleHide(indices) { this._mutateNodes(indices, (n) => { n.hidden = !n.hidden; }); }

  _ctxAction(act, i) { this.ctx.act(act, i); }

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
    this.selectedNodes = [];
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
    return JSON.stringify({ mode: this.mode, source: this.source, nodes: this.buildTree.nodes, printRot: this.printRot, printScale: this.printScale, printCut: this.printCut });
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
    this.printCut = d.printCut || 0;
    this.selectedNodes = [];
    this.overrides = {};
    this.root.querySelector('#pane-code').classList.toggle('hidden', this.mode !== 'code');
    this.root.querySelector('#pane-build').classList.toggle('hidden', this.mode !== 'build');
    this.root.querySelector('#editor').value = this.source;
    this._renderBuildTree();
    this._syncBuildTools();
    this.recompile(); // keep the current camera — undo/redo shouldn't reframe the view
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
    if (this.viewport && this.viewport._sketch?.on) { this.viewport.cancelSketch(); this.root.querySelector('#sketch-bar')?.classList.add('hidden'); }
    if (mode === this.mode) { this._syncBuildTools(); return; }
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
          this.selectedNodes = [];
        } catch (e) {
          const why = (e && e.name === 'ForgeError' && e.message) ? e.message
            : 'This design uses features build mode can’t edit yet';
          this._toast(`${why} — staying in code`);
          this._syncBuildTools();
          return; // stay in code rather than show a different object
        }
      }
      this.mode = 'build';
    }
    $('#pane-code').classList.toggle('hidden', this.mode !== 'code');
    $('#pane-build').classList.toggle('hidden', this.mode !== 'build');
    this._syncBuildTools();
    if (this.mode === 'build') this._renderBuildTree();
    this.recompile(); // keep the camera as-is — code/build show the same object, so don't reframe
    this._pushHistory();
    this._syncToolbar();
    this._syncModeSeg(); // code/build switch changes the highlighted segment
  }

  // --- command palette (Ctrl+K) ---------------------------------------------
  // The Ctrl+K command palette lives in CommandPalette (commandPalette.js); App
  // owns the instance (this.cmd) and forwards the wired handlers to it.
  _openCmd() { this.cmd.open(); }
  _renderCmd(query) { this.cmd.render(query); }
  _cmdMove(d) { this.cmd.move(d); }
  _runCmd(i) { this.cmd.run(i); }

  // --- sketch → extrude -----------------------------------------------------
  _startSketch() {
    if (this.mode !== 'build') this._switchMode('build');
    if (this.viewMode !== 'edit') this._setViewMode('edit');
    this._closeAddModal();
    this._setSketchMode('extrude');
    this.viewport.setSketchMode(true);
    this.root.querySelector('#sketch-bar')?.classList.remove('hidden');
    this._toast('Draw a shape — tap points on the plate, tap the first dot (or Finish) to close');
  }

  _setSketchMode(mode) {
    this._sketchMode = mode;
    this.viewport.setSketchKind?.(mode);
    this.root.querySelectorAll('#sketch-modes [data-smode]').forEach((b) => b.classList.toggle('on', b.dataset.smode === mode));
    const hint = this.root.querySelector('#sketch-hint');
    if (hint) hint.textContent = mode === 'revolve'
      ? 'draw a profile beside the axis — it spins into a solid'
      : 'tap points · tap the first dot to close';
    this.root.querySelector('#sketch-h-lab')?.classList.toggle('hidden', mode === 'revolve');
  }

  _finishSketchUI() {
    const ok = this.viewport.finishSketch();
    this.root.querySelector('#sketch-bar')?.classList.add('hidden');
    if (!ok) this._toast('A shape needs at least 3 points — cancelled');
  }

  _cancelSketchUI() {
    this.viewport.cancelSketch();
    this.root.querySelector('#sketch-bar')?.classList.add('hidden');
  }

  // The viewport finished a closed polygon: turn it into an editable part —
  // extruded, or revolved into a lathe solid. Optional corner rounding curves
  // the profile (baked into the points).
  _onSketchComplete(rawPts) {
    const round = Math.max(0, +this.root.querySelector('#sketch-round')?.value || 0);
    const pts = roundCorners(rawPts, round);
    if (this._sketchMode === 'revolve') {
      const node = this.buildTree.add('revolution');
      if (!node) return;
      node.points = pts;
      node.pos = [0, 0, 0]; // revolve yields a Z-axis solid already on the plate
      this._afterSketchNode('Revolved into a lathe solid ✓ — edit °, scale, or drag it');
    } else {
      const node = this.buildTree.add('extrusion');
      if (!node) return;
      node.points = pts;
      const h = Math.max(0.4, +this.root.querySelector('#sketch-h')?.value || 10);
      const hf = node.fields.find((f) => f.key === 'height'); if (hf) hf.value = h;
      node.pos = [0, 0, h / 2]; // extrude is centred — seat the base on the plate
      this._afterSketchNode('Sketch extruded ✓ — set the height, or drag it like any part');
    }
  }

  _afterSketchNode(msg) {
    this.root.querySelector('#sketch-bar')?.classList.add('hidden');
    this._renderBuildTree();
    this._selectNode(this.buildTree.nodes.length - 1, false);
    this.recompile();
    this._pushHistory();
    this._toast(msg);
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
    this.root.querySelector('#pane-code').classList.remove('hidden');
    this.root.querySelector('#pane-build').classList.add('hidden');
    this.root.querySelector('#editor').value = src;
    this._syncBuildTools();
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
      t.title = 'Tap to dismiss';
      t.addEventListener('click', () => { t.classList.remove('show'); clearTimeout(this._toastTimer); }); // easy dismiss
      this.root.querySelector('.stage').appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    // linger longer, scaled to reading time (≈ message length), tap dismisses sooner
    const dur = Math.min(6500, 2800 + msg.length * 50);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), dur);
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
    this.selectedNodes = [];
    this.root.querySelector('#pane-code').classList.toggle('hidden', this.mode !== 'code');
    this.root.querySelector('#pane-build').classList.toggle('hidden', this.mode !== 'build');
    this.root.querySelector('#editor').value = this.source;
    this._syncModeSeg();
    this._renderBuildTree();
    this._syncBuildTools();
    this.recompile(true);
    this.history = []; this.histIdx = -1; this._pushHistory();
    this._updateHistoryButtons();
  }

  // Project lifecycle lives in ProjectStore (projectStore.js); App owns the state
  // (this.project, _workSeconds, _prevProjectId, _autosaveTimer) and forwards these.
  _saveCurrent() { return this.projects.saveCurrent(); }
  _scheduleAutosave() { this.projects.scheduleAutosave(); }
  _newProject() { this.projects.newProject(); }
  _saveProject() { this.projects.saveProject(); }
  _doSaveAs(name) { this.projects.doSaveAs(name); }
  _openProject(id) { this.projects.openProject(id); }
  _deleteProject(id) { this.projects.deleteProject(id); }
  _renameCurrentProject(name) { this.projects.renameCurrentProject(name); }
  _uniqueName(base, exceptId) { return this.projects.uniqueName(base, exceptId); }
  _updateProjectName() { this.projects.updateProjectName(); }
  _updateProjBackBtn() { this.projects.updateProjBackBtn(); }
  _goToPrevious() { this.projects.goToPrevious(); }
  _renderRecentMenu() { this.projects.renderRecentMenu(); }
  _setupWorkTimer() { this.projects.setupWorkTimer(); }
  _initProjects() { this.projects.initProjects(); }
  _fmtSize(bytes) { return this.projects.fmtSize(bytes); }
  _fmtWork(sec) { return this.projects.fmtWork(sec); }
  _fmtDate(ts) { return this.projects.fmtDate(ts); }
  _renderProjectList() { this.projects.renderProjectList(); }

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

  // recompute the merged solid for HUD/export without rebuilding edit meshes —
  // through _effectiveSource so a single-shape drag after auto-orient / scale-to-fit
  // / cut keeps currentModel + the HUD consistent with recompile (was a divergent fork)
  _recompileMergedHUD() {
    const { result, error } = compile(this._effectiveSource(), this.overrides);
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

    const best = scoreOrientations(mesh); // pure mesh math lives in kernel/orient.js
    if (!best) return;

    this.printRot = best.rotation;
    this.recompile();
    this._pushHistory();
    if (this.mode === 'build' && this.viewMode !== 'result') this._setViewMode('result');
    const flat = !best.rotation[0] && !best.rotation[1] && !best.rotation[2];
    if (flat) this._toast('Already well-oriented for printing');
    else {
      const cut = best.baseOverhang > 0 ? Math.max(0, Math.round((1 - best.overhang / best.baseOverhang) * 100)) : 0;
      this._toast(`Auto-oriented · overhang ↓ ${cut}%`);
    }
  }

  // Scale the whole model down uniformly so it fits the build plate (2% margin),
  // applied as a print scale wrapped at compile (undoable). Accounts for the
  // current print orientation. No-op (resets to 100%) if it already fits.
  _scaleToFit() {
    // measure the model at its print orientation (rotation only) — scale is what
    // we're about to compute, so it must not already be wrapped in.
    const src = wrapPrintPrep(this.mode === 'build' ? buildTreeToSource(this.buildTree) : this.source, { rot: this.printRot });
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

  // Open/close the code panel (right-docked). _setPanel() toggles; _setPanel(true|false) forces.
  _setPanel(open) {
    const panel = this.root.querySelector('#panel');
    const collapse = open === undefined ? !panel.classList.contains('collapsed') : !open;
    panel.classList.toggle('collapsed', collapse);
    this._syncModeSeg(); // reflect the panel open-state on the top-bar control
  }

  // The ◨ top-bar button hides/shows the side panel for the CURRENT mode, so one
  // control collapses the sidebar whatever you're doing: the code panel in code
  // mode, the parts inspector (#part-card) in build/result.
  _toggleSidebar() {
    if (this.mode === 'code') this._setPanel();
    else this._setCardCollapsed?.(!this._cardCollapsed);
  }

  _openAddModal() {
    // Adding parts is a build-mode action; if in code, switch first (carrying
    // the design over via the importer). If that can't happen, don't open.
    if (this.mode !== 'build') {
      this._switchMode('build');
      if (this.mode !== 'build') return;
    }
    const s = this.root.querySelector('#add-search'); if (s) { s.value = ''; this._filterAdd(''); } // fresh each open
    this._openModal('#add-modal');
    this._positionAddModal();
  }

  // Filter the Add-modal items by a search query; hide non-matching buttons and
  // any category left with no matches (and show the grids even if collapsed).
  _filterAdd(query) {
    const q = (query || '').trim().toLowerCase();
    const modal = this.root.querySelector('#add-modal');
    if (!modal) return;
    modal.classList.toggle('searching', !!q);
    let matched = 0;
    modal.querySelectorAll('.cat').forEach((cat) => {
      let any = false;
      cat.querySelectorAll('button').forEach((b) => {
        const hit = !q || b.textContent.toLowerCase().includes(q);
        b.classList.toggle('add-hide', !hit);
        if (hit) { any = true; matched += 1; }
      });
      cat.classList.toggle('cat-nomatch', !!q && !any);
    });
    const empty = modal.querySelector('#add-empty');
    if (empty) empty.classList.toggle('hidden', !(q && matched === 0));
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

  // Read a user-chosen STL / OBJ / 3MF, build a watertight solid, add it as a
  // part. import3MF is async (zip inflate); STL/OBJ are sync — unified via a
  // promise so all three share one success/failure path.
  _importSTLFile(file) {
    const isObj = /\.obj$/i.test(file.name);
    const is3mf = /\.3mf$/i.test(file.name);
    const fmt = is3mf ? '3MF' : isObj ? 'OBJ' : 'STL';
    const reader = new FileReader();
    reader.onerror = () => this._toast('Could not read the file');
    reader.onload = () => {
      Promise.resolve()
        .then(() => (is3mf ? import3MF(reader.result) : isObj ? importOBJ(reader.result) : importSTL(reader.result)))
        .then((man) => {
          if (!man || man.numTri() === 0) { this._toast(`Import failed — ${fmt} mesh is not watertight`); try { man && man.delete(); } catch { /* freed */ } return; }
          const id = (is3mf ? '3mf-' : isObj ? 'obj-' : 'stl-') + (this._meshSeq = (this._meshSeq || 0) + 1);
          registerSolid(id, man);
          const node = this.buildTree.add('imported');
          node.meshId = id;
          node.meshName = file.name.replace(/\.(stl|obj|3mf)$/i, '');
          const idx = this.buildTree.nodes.length - 1;
          this.selectedNodes = [idx];
          this._renderBuildTree();
          this.recompile(true);
          this._pushHistory();
          this._renderAlignBar();
          this._toast(`Imported ${file.name}`);
        })
        .catch(() => this._toast(`Import failed — not a valid ${fmt}`));
    };
    if (isObj) reader.readAsText(file); else reader.readAsArrayBuffer(file);
  }

  _addShape(kind) {
    const node = this.buildTree.add(kind);
    // screw / insert pockets are made to be subtracted — spawn them as holes
    if (node && (kind === 'counterbore' || kind === 'countersink' || kind === 'insertHole' || kind === 'nutTrap' || kind === 'keyhole')) node.op = 'hole';
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

  // Engrave text onto a clicked face: prompt for the text, then pick a face and
  // drop a recessed (hole) text solid oriented to it — the global difference cuts
  // it into the part. Edit the resulting text card to tweak size/depth/emboss.
  _engraveText() {
    this._closeAddModal();
    if (this.mode !== 'build') { this._toast('Switch to build mode to engrave on a face'); return; }
    this._promptName('Engrave text on a face', '', (txt) => {
      const s = (txt || '').trim();
      if (!s) return;
      this._toast('Now click the face to engrave onto');
      this.viewport.armWorkplanePick((info) => {
        if (!info) { this._toast('Engrave — cancelled'); return; }
        const node = this.buildTree.add('text');
        if (!node) return;
        const setF = (k, v) => { const f = node.fields.find((x) => x.key === k); if (f) f.value = v; };
        setF('str', s); setF('size', 8); setF('height', 2);
        node.op = 'hole'; // recessed engraving (mark it solid for a raised emboss)
        const { origin: o, normal: n, rot } = info;
        const r2 = (v) => Math.round(v * 100) / 100 || 0;
        node.rot = [...rot];
        node.pos = [r2(o[0] - n[0]), r2(o[1] - n[1]), r2(o[2] - n[2])]; // straddle the face (~1 mm in)
        const idx = this.buildTree.nodes.length - 1;
        this.selectedNodes = [idx];
        this._renderBuildTree();
        this.recompile();
        this._pushHistory();
        this._renderAlignBar();
        this._toast('Engraved — tweak size/depth on the text card (set it solid to emboss)');
      });
    });
  }

  _deleteNode(i) {
    this.buildTree.nodes.splice(i, 1);
    this.selectedNodes = [];
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
  }

  _duplicateNode(i) {
    const src = this.buildTree.nodes[i];
    if (!src) return;
    // Clone everything (colour, clearance/hollow/fillet, meshId, sketch points…),
    // deep-copying the arrays; a duplicate starts ungrouped and expanded.
    const copy = {
      ...src,
      pos: [src.pos[0] + 6, src.pos[1] + 6, src.pos[2]],
      rot: [...(src.rot || [0, 0, 0])],
      scale: [...(src.scale || [1, 1, 1])],
      fields: src.fields.map((f) => ({ ...f })),
      group: null,
      collapsed: false,
    };
    if (src.points) copy.points = src.points.map((p) => [...p]);
    this.buildTree.nodes.splice(i + 1, 0, copy);
    this.selectedNodes = [i + 1];
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
  }

  // Show the per-part editor — the Edit tab (2nd column) of the unified panel.
  _openPartModal() {
    this._setPanelTab('edit');
  }

  // Switch the unified panel to a tab. 'edit' slides out the editor as a 2nd
  // column (the panel widens) while the parts list stays in the main column.
  _setPanelTab(tab) {
    this._panelTab = tab;
    if (tab !== 'settings' && this.mode !== 'build') this._switchMode('build'); // Parts/Shapes/Edit are build concepts
    if (this._cardCollapsed) this._setCardCollapsed(false);
    this.root.querySelectorAll('.ptab').forEach((b) => b.classList.toggle('on', b.dataset.ptab === tab));
    const mainTab = tab === 'edit' ? 'parts' : tab;
    this.root.querySelectorAll('.ppane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== mainTab));
    const editCol = this.root.querySelector('#pcol-edit');
    if (editCol) editCol.classList.toggle('hidden', tab !== 'edit');
    const card = this.root.querySelector('#part-card');
    if (card) card.classList.toggle('editing', tab === 'edit');
    this._syncBuildTools();
    if (tab === 'edit') this._renderBuildTree();
    this._renderAlignBar();
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
    this.root.innerHTML = appHTML({ addGallery: addGalleryHTML(), gcodeHtml: mdToHtml(gcodeHelp) });
  }
}

installEvents(App);
installBuildPane(App);
