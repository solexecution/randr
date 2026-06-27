// Application controller. Ties the three surfaces together:
//   1. Code pane  — the parametric mini-language (OpenSCAD-style)
//   2. Build pane — touch primitives you place/drag on the workplane (Tinkercad)
//   3. Viewport   — the shared result of whichever pane is active
//
// Both panes ultimately produce mini-language source, so the kernel only ever
// sees one input format. The build pane is a structured editor that emits
// source; a touch-built model can be opened in the code pane and vice versa.

import { loadKernel, inspect, meshSolid, importSTL, importOBJ, import3MF, registerSolid, solidMesh, setCurveQuality, splitHalf, splitAtPlane } from '../kernel/manifold.js';
import { compile } from '../lang/compile.js';
import { exportSTL, exportOBJ, export3MF, export3MFColored } from '../kernel/export.js';
import { Viewport, BUILD_VOLUME } from './viewport.js';
import { applyLevel, printReadyReport } from './placeOps.js';
import { buildTreeToSource, buildColoredParts, BuildTree, bakeNodeScale } from './buildtree.js';
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
import { featuresHelpHTML } from './featuresHelp.js';

// Top-bar workspace toggle: icon reflects what clicking will do next.
// Sidebar open (edit) → cube icon = "preview result, hide panel".
// Sidebar hidden (preview) → panel icon = "show panel, edit".
const WORKSPACE_ICON_TO_PREVIEW = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M12 12 20 8M12 12V20.5M12 12 4 8"/></svg>';
const WORKSPACE_ICON_TO_EDIT = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><rect x="13.5" y="6.5" width="6" height="11" rx="1" fill="currentColor" stroke="none"/><path d="M15.5 9.5 L12.5 12 L15.5 14.5"/></svg>';

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
    this._coloredParts = null; // cached per-part manifolds for result view + 3MF; freed each recompile
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
    this.cutPlaneMode = false; // movable laser-cut plane in the build viewport
    this._pendingSeamCheck = null; // { a, b } — run gap readout after next mesh rebuild
    this.viewMode = 'edit'; // build view: 'edit' (parts + ghost) | 'result' (combined solid)
    this.multiSelect = false; // sticky additive selection (touch-friendly — taps add to the selection)
    this._layerMode = false;  // layer-preview (slice) view active
    this.project = null;    // current saved project meta {id,name,created,modified,seconds} or null
    this._workSeconds = 0;  // accumulated active-edit time for the current project
    this._recompileTimer = null;
    this.history = [];
    this.histIdx = -1;
    this._restoring = false;
    this._editToolTab = 'move'; // move | place | multi — tabbed tools in the build edit column
  }

  async start() {
    this._render();
    await loadKernel();
    this.viewport = new Viewport(this.root.querySelector('#viewport-canvas'));
    this.viewport.onSelect = (i, additive) => {
      this._selectNode(i, additive);
      if (i >= 0 && !additive) this._setPanelTab('edit');
      else if (i < 0 && !additive && this._panelTab === 'edit') this._setPanelTab('parts');
    };
    this.viewport.onMultiArm = (on) => this._onMultiArm(on);
    // Tuck the parts panel on empty canvas tap (tablet); part picks keep it open.
    this.viewport.onCanvasEmptyTap = () => {
      if (this.mode === 'build' && this.viewMode === 'edit') this._setSidebarOpen(false);
    };
    this.viewport.onContext = (i, x, y) => this._showContextMenu(i, x, y);
    this.viewport.onShapeMove = (i, pos) => this._onShapeMove(i, pos);
    this.viewport.onShapeMoveEnd = (i, pos) => this._onShapeMoveEnd(i, pos);
    this.viewport.onTransform = (i, t) => this._onTransform(i, t);
    this.viewport.onGroupTransform = (updates) => this._onGroupTransform(updates);
    this.viewport.onTransformEnd = (i) => this._onTransformEnd(i);
    this.viewport.getTransformSet = () => this._transformSet();
    this.viewport.onCutPlaneChange = (plane) => this._onCutPlaneChange(plane);
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
    this._ensurePartFieldDelegates?.();
    this.viewport.homeView(); // open framed on the whole plate, from the front
    const boot = this.root.querySelector('#boot');
    boot.classList.add('gone');
    boot.setAttribute('aria-hidden', 'true');
    boot.inert = true;
  }

  // --- floating / dockable / customizable left toolbar ----------------------
  // The tool strip is its own module (see toolbar.js). App wires the behaviors
  // its buttons trigger and pushes state in for them to reflect; the module owns
  // the layout, persistence, drag/dock, and the ✎ customise modal.
  _initToolbar() {
    this.toolbar = new Toolbar(this.root);
    this.toolbar.onQualityChange = (lvl) => { this._setQuality(lvl.v); this._toast(`Curve quality: ${lvl.name}`); };
    this.toolbar.init({ mode: this.mode, curveQuality: this.curveQuality });
    this._syncWorkspaceUI();
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
    this._disposeColoredParts(); // the tree/source changed — invalidate the cached coloured parts
    const source = this._effectiveSource();

    const { result, params, error } = compile(source, this.overrides);

    if (error) {
      this._showCompileError?.(error);
      this._setStatus('error');
      if (this.mode === 'code') {
        if (this.currentModel) {
          try { this.currentModel.delete(); } catch { /* freed */ }
        }
        this.currentModel = null;
        this._disposeColoredParts();
        this.viewport.setEditMode(false);
        this.viewport.setModel(null);
        this.viewport.setGhost(null);
        this._updateHUD(null);
      }
      return;
    }
    this._showCompileError?.(null);

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
    this.selectedNodes = this.selectedNodes.filter((i) => i < this.buildTree.nodes.length);
    this.viewport.setSelection(this.selectedNodes, this._transformSet());
    this._syncPartsListSelection?.();
    this._renderAlignBar();
    this._updatePartsHeader();
    this._syncGroupTransformFields();
    this._runPendingSeamCheck();
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
      const parts = this._getColoredParts();
      if (parts.length) { this.viewport.setColoredModel(parts); return; }
    }
    this.viewport.setModel(this.currentModel || null);
  }

  // Compile + cache the per-part coloured manifolds (build mode) so result view
  // and 3MF export reuse them instead of recompiling N parts each time. Freed and
  // recomputed at the next recompile — the only thing that changes the tree.
  _getColoredParts() {
    if (this.mode !== 'build') return [];
    if (!this._coloredParts) {
      this._coloredParts = buildColoredParts(this.buildTree)
        .map((p) => {
          try { const m = compile(p.source, {}).result; return m ? { manifold: m, color: p.color } : null; }
          catch { return null; }
        })
        .filter(Boolean);
    }
    return this._coloredParts;
  }

  _disposeColoredParts() {
    if (this._coloredParts) {
      for (const p of this._coloredParts) { try { p.manifold.delete(); } catch { /* freed */ } }
      this._coloredParts = null;
    }
  }

  // Sidebar visible = edit; hidden = result preview. One control, both modes.
  _setSidebarOpen(open) {
    const card = this.root.querySelector('#part-card');
    this.viewMode = open ? 'edit' : 'result';
    this._cardCollapsed = !open;
    if (card) card.classList.toggle('collapsed', !open);
    document.body.classList.toggle('view-result', !open);

    if (this.mode === 'build') {
      if (open) {
        this.viewport.setEditMode(true);
        this._renderEditShapes();
        this.viewport.setGhost(this._wantGhost() ? this.currentModel : null);
      } else {
        this.viewport.setEditMode(false);
        this._renderResult();
        this.viewport.setGhost(null);
      }
    } else if (!open) {
      this.viewport.setEditMode(false);
      this._renderResult();
      this.viewport.setGhost(null);
    }

    this._applyCardLayout();
    this._syncWorkspaceUI();
    this._saveCardDock();
  }

  _setCardCollapsed(collapsed) {
    this._setSidebarOpen(!collapsed);
  }

  // Toggle the build view: 'edit' (parts + result ghost) vs 'result' (the
  // combined solid). Kept for print-prep and project restore — maps to sidebar.
  _setViewMode(mode) {
    this._setSidebarOpen(mode === 'edit');
  }

  // Code / Build switch inside the sidebar (never flips preview state).
  _setAuthoringMode(mode) {
    if (mode !== 'code' && mode !== 'build') return;
    if (this.viewMode === 'result') this._setSidebarOpen(true);
    this._switchMode(mode);
    this._syncCardModeSeg();
  }

  // Top-bar toggle + card « : preview ⟷ edit.
  _toggleSidebar() {
    this._setSidebarOpen(this.viewMode === 'result');
  }

  _syncCardModeSeg() {
    this.root.querySelectorAll('#card-mode-seg .card-mode-opt').forEach((b) => {
      const on = b.dataset.mode === this.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // Reflect sidebar open/closed on the top-bar workspace toggle.
  _syncWorkspaceUI() {
    const editing = this.viewMode === 'edit';
    const btn = this.root.querySelector('#workspace-toggle');
    if (btn) {
      btn.classList.toggle('on', editing);
      btn.innerHTML = editing ? WORKSPACE_ICON_TO_PREVIEW : WORKSPACE_ICON_TO_EDIT;
      btn.setAttribute('aria-pressed', editing ? 'true' : 'false');
      const label = editing ? 'Preview result (hide panel)' : 'Edit model (show panel)';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    this._syncCardModeSeg();
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

  // Place/move/transform targets: selection plus every member of any touched group.
  _placeSet() {
    const out = new Set();
    this.selectedNodes.forEach((i) => this._members(i).forEach((j) => out.add(j)));
    return [...out];
  }

  _transformSet() { return this._placeSet(); }

  // One linked group selected (all members share a group id).
  _isUnifiedGroupSelection() {
    if (this.selectedNodes.length < 2) return false;
    const nodes = this.buildTree.nodes;
    const g = nodes[this.selectedNodes[0]]?.group;
    return g != null && this.selectedNodes.every((i) => nodes[i]?.group === g);
  }

  _selectionBounds(indices) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    let any = false;
    indices.forEach((i) => {
      const b = this.viewport.shapeBounds(i);
      if (!b) return;
      any = true;
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); }
    });
    return any ? { min: mn, max: mx } : null;
  }

  _selectionCentre(indices) {
    const bb = this._selectionBounds(indices);
    if (!bb) return null;
    return [
      (bb.min[0] + bb.max[0]) / 2,
      (bb.min[1] + bb.max[1]) / 2,
      (bb.min[2] + bb.max[2]) / 2,
    ];
  }

  _moveGroupCentre(axis, target) {
    const ts = this._transformSet();
    const bb = this._selectionBounds(ts);
    if (!bb) return;
    const cur = (bb.min[axis] + bb.max[axis]) / 2;
    const delta = target - cur;
    if (Math.abs(delta) < 0.0005) return;
    const rnd = (v) => Math.round(v * 100) / 100 || 0;
    const nodes = this.buildTree.nodes;
    ts.forEach((i) => { const n = nodes[i]; if (n) n.pos[axis] = rnd(n.pos[axis] + delta); });
    this.viewport.setSelection(this.selectedNodes, ts);
    this._scheduleRecompile();
  }

  _rotateGroupAboutCentre(axis, deltaDeg) {
    if (!deltaDeg) return;
    const rad = (deltaDeg * Math.PI) / 180;
    const ts = this._transformSet();
    const c = this._selectionCentre(ts);
    if (!c) return;
    const [cx, cy, cz] = c;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    const rnd = (v) => Math.round(v * 100) / 100 || 0;
    const rotPt = (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      if (axis === 0) return [rnd(x), rnd(cy + dy * ca - dz * sa), rnd(cz + dy * sa + dz * ca)];
      if (axis === 1) return [rnd(cx + dx * ca + dz * sa), rnd(y), rnd(cz - dx * sa + dz * ca)];
      return [rnd(cx + dx * ca - dy * sa), rnd(cy + dx * sa + dy * ca), rnd(z)];
    };
    const nodes = this.buildTree.nodes;
    ts.forEach((i) => {
      const n = nodes[i];
      n.pos = rotPt(n.pos[0], n.pos[1], n.pos[2]);
      n.rot[axis] = rnd(n.rot[axis] + deltaDeg);
    });
    this.viewport.setSelection(this.selectedNodes, ts);
    this._scheduleRecompile();
  }

  // Single source of truth for the additive ("multi") selection mode, shared by
  // the card's ⊹ toggle and the scene long-press gesture.
  _setMultiSelect(on) {
    this.multiSelect = on;
    if (this.viewport) this.viewport.multiSelect = on;
    // reflect on every multi toggle (the parts-header one + the edit-tools one)
    this.root.querySelectorAll('.js-multi').forEach((b) => b.classList.toggle('on', on));
    this._updatePartsHeader?.(); // the hint follows the mode
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
    }
    let baked = false;
    if (i >= 0 && !additive) baked = bakeNodeScale(this.buildTree.nodes[i]);
    this.viewport.setSelection(this.selectedNodes, this._transformSet());
    this._highlightBuildRows();
    if (baked) this._scheduleRecompile();
    this._renderAlignBar();
    this._updatePartsHeader();
  }

  _highlightBuildRows() {
    this._renderBuildTree(); // re-render the roster + the modal detail for the new selection
  }

  // The unified card hosts both authoring surfaces (editor in code, parts
  // inspector in build), so it shows in either mode — result hides it via the
  // body.view-result CSS. _syncCardDomain swaps which content is visible.
  _syncBuildTools() {
    const card = this.root.querySelector('#part-card');
    if (card) card.classList.remove('hidden');
    this._syncCardDomain();
    this._syncCardModeSeg();
    this._applyCardLayout();
  }

  // Flip the card between its two surfaces by mode: code adds .dom-code (CSS shows
  // #pane-code, hides the build columns); build removes it (parts list / editor
  // columns show). The header title follows via _updatePartsHeader.
  _syncCardDomain() {
    const card = this.root.querySelector('#part-card');
    if (!card) return;
    card.classList.toggle('dom-code', this.mode === 'code');
    this._updatePartsHeader?.();
    this._syncCardModeSeg();
  }

  // Keep the HUD (top-left) and nav-cube (top-right) clear of a side-docked
  // card on desktop, by flagging the dock side on the stage (see styles.css).
  _applyCardLayout() {
    const stage = this.root.querySelector('.stage');
    if (!stage) return;
    const dock = this._cardDock || 'right';
    // the HUD / nav-cube dodge an expanded side dock, but not during result preview
    const sideDock = this._layout !== 'bottom';
    const visible = sideDock && this.viewMode === 'edit';
    stage.classList.toggle('cardleft', visible && dock === 'left');
    stage.classList.toggle('cardright', visible && dock === 'right');
    const minBtn = this.root.querySelector('#card-min');
    if (minBtn) {
      minBtn.textContent = dock === 'right' ? '»' : '«';
      minBtn.title = 'Preview result (hide panel)';
    }
    this._syncWorkspaceUI();
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

  // Tabbed build tools (Move / Place / Multi). Buttons disable until the
  // selection meets each tool's requirement; Multi tab appears once 2+ parts
  // exist and auto-opens when 2+ are selected.
  _setEditToolTab(tab) {
    this._editToolTab = tab;
    this.root.querySelectorAll('.edit-tool-tab').forEach((b) => {
      const on = b.dataset.ttab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    this.root.querySelectorAll('.edit-tool-pane').forEach((p) => {
      p.classList.toggle('on', p.dataset.ttab === tab);
    });
  }

  _renderAlignBar() {
    const sel = this.selectedNodes.length;
    const nodes = this.buildTree.nodes;
    const total = nodes.length;
    const multiTab = this.root.querySelector('.edit-tool-tab[data-ttab="multi"]');
    if (multiTab) multiTab.hidden = total < 2;
    if (sel >= 2 && this._editToolTab !== 'multi') this._setEditToolTab('multi');
    else if (sel < 2 && this._editToolTab === 'multi') this._setEditToolTab('move');

    const disableBar = (id, disabled) => {
      const bar = this.root.querySelector(id);
      if (!bar) return;
      bar.querySelectorAll('button, input').forEach((el) => { el.disabled = disabled; });
    };
    disableBar('#opsbar', sel < 1);
    const cutbar = this.root.querySelector('#cutbar');
    if (cutbar) {
      cutbar.querySelectorAll('[data-cut-plane="apply"], [data-cut-plane="reset"]').forEach((b) => { b.disabled = sel < 1; });
      const chk = cutbar.querySelector('[data-cut-plane="check"]');
      if (chk) chk.disabled = sel !== 2;
    }
    disableBar('#arraybar', sel < 1);
    disableBar('#alignbar', sel < 2);
    const grp = this.root.querySelector('#groupbar');
    if (grp) {
      const hasGroup = this.selectedNodes.some((i) => nodes[i] && nodes[i].group != null);
      const canGroup = sel >= 2;
      const gb = grp.querySelector('[data-group="group"]');
      const ub = grp.querySelector('[data-group="ungroup"]');
      if (gb) gb.disabled = !canGroup;
      if (ub) ub.disabled = !hasGroup;
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
    const label = `Group ${id}`;
    sel.forEach((i) => {
      if (nodes[i]) {
        nodes[i].group = id;
        if (!(nodes[i].groupLabel || '').trim()) nodes[i].groupLabel = label;
      }
    });
    this.selectedNodes = this._members(sel[sel.length - 1]);    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
    this._toast(`Grouped ${sel.length} parts as ${label}`);
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
    const sel = this._transformSet();
    let any = false;
    sel.forEach((i) => {
      const n = nodes[i]; if (!n || n.locked) return;
      n.pos = [n.pos[0] + d[0], n.pos[1] + d[1], n.pos[2] + d[2]]; any = true;
    });
    if (!any) return;
    this.viewport.shiftSelected(d[0], d[1], d[2]);
    const syncPosFields = (i, n) => {
      ['0', '1', '2'].forEach((a) => {
        const v = n.pos[+a];
        const pel = this.root.querySelector(`#part-modal-fields input[data-pos="${i}:${a}"]`);
        if (pel && document.activeElement !== pel) pel.value = v;
      });
    };
    sel.forEach((i) => { const n = nodes[i]; if (n) syncPosFields(i, n); });
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
    const sel = this._placeSet();
    if (!sel.length) return;
    const rnd = (v) => Math.round(v * 100) / 100 || 0;

    if (act === 'drop') {
      // Seat the whole selection (or group) on the plate — one shared Z shift.
      let groupMinZ = Infinity;
      sel.forEach((i) => {
        const n = nodes[i], ext = this.viewport.shapeExtent(i);
        if (!n || !ext) return;
        groupMinZ = Math.min(groupMinZ, n.pos[2] + ext.minZ);
      });
      if (groupMinZ === Infinity) return;
      const shift = -groupMinZ;
      sel.forEach((i) => { const n = nodes[i]; if (n) n.pos[2] = rnd(n.pos[2] + shift); });
    } else if (act === 'center') {
      // Centre the selection's bounding box on the plate origin (XY).
      const bb = this._selectionBounds(sel);
      if (!bb) return;
      const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
      sel.forEach((i) => {
        const n = nodes[i];
        if (!n) return;
        n.pos[0] = rnd(n.pos[0] - cx);
        n.pos[1] = rnd(n.pos[1] - cy);
      });
    } else {
      if (act === 'level') {
        const skipped = applyLevel(nodes, sel);
        if (skipped) this._toast(`Level skipped ${skipped} hole part(s) — pin orientation kept`);
      } else {
        sel.forEach((i) => {
          const n = nodes[i];
          if (!n) return;
          if (act === 'scale') n.scale = [1, 1, 1];
        });
      }
    }
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

  _cutSelectionSolid() {
    const nodes = this.buildTree.nodes;
    if (!this.selectedNodes.length) return { error: 'Select a part to cut' };
    if (!this._isUnifiedGroupSelection() && this.selectedNodes.length > 1) {
      return { error: 'Select one part or a linked group to cut' };
    }
    const ref = nodes[this.selectedNode];
    if (!ref) return { error: 'Nothing selected' };
    const compileNodes = this._isUnifiedGroupSelection()
      ? nodes.filter((n) => n.group === ref.group).map((n) => ({ ...n, op: 'solid', hidden: false }))
      : [{ ...ref, op: 'solid', group: null, groupMode: 'union', hidden: false }];
    let man = null;
    try { man = compile(buildTreeToSource({ nodes: compileNodes }), {}).result; }
    catch { return { error: 'Couldn’t cut this part' }; }
    if (!man) return { error: 'Nothing to cut' };
    const remove = this._isUnifiedGroupSelection()
      ? nodes.map((n, i) => (n.group === ref.group ? i : -1)).filter((i) => i >= 0)
      : [this.selectedNode];
    return { man, ref, remove };
  }

  _piecesFromManifolds(halves, ref, baseName) {
    return halves.map((c, k) => {
      const id = `cut-${Date.now()}-${k}`;
      try { registerSolid(id, c); } catch { c.delete(); return null; }
      return {
        kind: 'imported', op: ref.op, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
        color: ref.color, locked: false, hidden: false, group: null, groupMode: 'union',
        collapsed: false, meshId: id, meshName: `${baseName} ${k + 1}`, fields: [],
      };
    }).filter(Boolean);
  }

  _installCutPieces(ref, remove, pieces) {
    const nodes = this.buildTree.nodes;
    const insertAt = Math.min(...remove);
    remove.sort((a, b) => b - a).forEach((i) => nodes.splice(i, 1));
    nodes.splice(insertAt, 0, ...pieces);
    this.selectedNodes = pieces.map((_, k) => insertAt + k);
    if (pieces.length === 2) {
      this._pendingSeamCheck = { a: insertAt, b: insertAt + 1 };
    }
    this._renderBuildTree(); this.recompile(); this._pushHistory(); this._renderAlignBar();
  }

  _formatSeamGap(mm) {
    if (mm == null) return 'Couldn’t measure — pick two parts';
    if (mm < 0.02) return `Face to face (${mm.toFixed(3)} mm)`;
    if (mm < 0.1) return `Tight fit — ${mm.toFixed(2)} mm`;
    return `Gap — ${mm.toFixed(2)} mm`;
  }

  _showSeamGap(mm, toast = false) {
    const el = this.root.querySelector('#seam-readout');
    const text = this._formatSeamGap(mm);
    if (el) el.textContent = text;
    if (toast) this._toast(`Seam: ${text}`);
    return mm;
  }

  _checkSeamGap() {
    if (this.selectedNodes.length !== 2) {
      this._toast('Select exactly two parts to check the seam');
      return;
    }
    const [a, b] = this.selectedNodes;
    const mm = this.viewport.measureMeshGap(a, b);
    this._showSeamGap(mm, true);
  }

  _runPendingSeamCheck() {
    const p = this._pendingSeamCheck;
    if (!p) return;
    this._pendingSeamCheck = null;
    const mm = this.viewport.measureMeshGap(p.a, p.b);
    this._showSeamGap(mm, true);
  }

  _validCutHalves(halves) {
    return (halves || []).filter((h) => h && !h.isEmpty() && h.numVert() > 0);
  }

  // Cut the selection (or a linked group) in half along X, Y, or Z at its centre.
  _splitHalf(axis) {
    const prep = this._cutSelectionSolid();
    if (prep.error) { this._toast(prep.error); return; }
    let halves = [];
    try {
      halves = this._validCutHalves(splitHalf(prep.man, axis));
      prep.man.delete();
    } catch { prep.man?.delete(); this._toast('Couldn’t cut this part'); return; }
    if (halves.length < 2) { this._toast('Cut missed the part — move the plane'); return; }
    const baseName = prep.ref.meshName || prep.ref.kind || 'part';
    const pieces = this._piecesFromManifolds(halves, prep.ref, baseName);
    if (pieces.length < 2) { this._toast('Couldn’t cut this part'); return; }
    this._installCutPieces(prep.ref, prep.remove, pieces);
    const ax = axis === 'x' ? 'left/right' : axis === 'y' ? 'front/back' : 'top/bottom';
    this._toast(`Cut in half (${ax})`);
  }

  _cutPlaneSeedCenter() {
    const sel = this.selectedNode >= 0 ? [this.selectedNode] : this._transformSet();
    const bb = sel.length ? this._selectionBounds(sel) : null;
    if (bb) {
      return [
        (bb.min[0] + bb.max[0]) / 2,
        (bb.min[1] + bb.max[1]) / 2,
        (bb.min[2] + bb.max[2]) / 2,
      ];
    }
    return [0, 0, 30];
  }

  _syncCutPlaneUI() {
    const on = this.cutPlaneMode;
    this.root.querySelectorAll('[data-cut-plane="toggle"]').forEach((b) => b.classList.toggle('on', on));
    const hint = this.root.querySelector('#cut-plane-hint');
    if (hint) hint.hidden = !on;
    if (on) this._setEditToolTab('move');
  }

  _onCutPlaneChange(plane) {
    const el = this.root.querySelector('#cut-plane-readout');
    if (!el || !plane) return;
    const f = (v) => (Math.round(v * 10) / 10).toFixed(1);
    el.textContent = `${f(plane.origin[0])}, ${f(plane.origin[1])}, ${f(plane.origin[2])} mm`;
  }

  _toggleCutPlane() {
    this.cutPlaneMode = !this.cutPlaneMode;
    if (this.cutPlaneMode && this.measureMode) {
      this.measureMode = false;
      this.viewport.setMeasureMode(false);
      this.root.querySelector('#v-measure')?.classList.remove('on');
    }
    if (this.cutPlaneMode) {
      this.viewport.setCutPlaneMode(true, {
        origin: this._cutPlaneSeedCenter(),
        normal: [0, 0, 1],
      });
      this._setEditToolTab('move');
      this._setXform('translate');
      this._toast('Laser cut on — move/turn the red plane, then Cut here');
    } else {
      this.viewport.setCutPlaneMode(false);
      this._toast('Laser cut off');
    }
    this._syncCutPlaneUI();
  }

  _resetCutPlane() {
    if (!this.cutPlaneMode) { this._toggleCutPlane(); return; }
    this.viewport.setCutPlanePose(this._cutPlaneSeedCenter(), [0, 0, 1]);
    this._toast('Cut plane levelled through selection');
  }

  _applyCutPlane() {
    if (!this.cutPlaneMode) { this._toggleCutPlane(); return; }
    const plane = this.viewport.getCutPlane();
    if (!plane) { this._toast('Cut plane not ready'); return; }
    const prep = this._cutSelectionSolid();
    if (prep.error) { this._toast(prep.error); return; }
    let halves = [];
    try {
      halves = this._validCutHalves(splitAtPlane(prep.man, plane.normal, plane.origin));
      prep.man.delete();
    } catch { prep.man?.delete(); this._toast('Couldn’t cut along this plane'); return; }
    if (halves.length < 2) { this._toast('Plane misses the part — move or turn it'); return; }
    const baseName = prep.ref.meshName || prep.ref.kind || 'part';
    const pieces = this._piecesFromManifolds(halves, prep.ref, baseName);
    if (pieces.length < 2) { this._toast('Couldn’t cut this part'); return; }
    this._installCutPieces(prep.ref, prep.remove, pieces);
    this.viewport.setCutPlanePose(this._cutPlaneSeedCenter(), plane.normal);
  }

  _syncTransformMeshes(indices, nodes) {
    const D = Math.PI / 180;
    for (const j of indices) {
      const em = this.viewport.editMeshes?.find((e) => e.index === j);
      const m = nodes[j];
      if (!em || !m) continue;
      em.mesh.position.set(m.pos[0], m.pos[1], m.pos[2]);
      const r = m.rot || [0, 0, 0];
      em.mesh.rotation.set(r[0] * D, r[1] * D, r[2] * D);
      const s = m.scale || [1, 1, 1];
      em.mesh.scale.set(s[0], s[1], s[2]);
    }
  }

  // live during a drag: move the shape (whole group moves together) + reflect
  // in the panel, no recompile
  _onShapeMove(i, pos) {
    const nodes = this.buildTree.nodes;
    const n = nodes[i];
    if (!n) return;
    const dx = pos[0] - n.pos[0], dy = pos[1] - n.pos[1], dz = pos[2] - n.pos[2];
    const sel = this._transformSet().includes(i) ? this._transformSet() : [i];
    const host = this.root.querySelector('#part-modal-fields');
    sel.forEach((j) => {
      const m = nodes[j]; if (!m) return;
      m.pos = (j === i) ? pos : [m.pos[0] + dx, m.pos[1] + dy, m.pos[2] + dz];
      if (host) ['0', '1', '2'].forEach((a) => {
        const el = host.querySelector(`input[data-pos="${j}:${a}"]`);
        if (el && document.activeElement !== el) el.value = m.pos[+a];
      });
    });
    if (sel.length > 1) this._syncTransformMeshes(sel, nodes);
  }

  // drag finished: settle the merged solid + HUD (export needs it current)
  _onShapeMoveEnd(i, pos) {
    const nodes = this.buildTree.nodes;
    const n = nodes[i];
    if (!n) return;
    const sel = this._transformSet().includes(i) ? this._transformSet() : [i];
    if (sel.length > 1) {
      sel.forEach((j) => {
        const em = this.viewport.editMeshes?.find((e) => e.index === j);
        const m = nodes[j];
        if (!em || !m) return;
        m.pos = [em.mesh.position.x, em.mesh.position.y, em.mesh.position.z];
      });
    } else {
      n.pos = pos;
    }
    if (sel.length > 1) this.recompile();
    else this._recompileMergedHUD();
    this._pushHistory();
  }

  // Rigid multi-part gizmo drag — pivot at selection centre (see viewport._syncGroupGizmo).
  _onGroupTransform(updates) {
    const nodes = this.buildTree.nodes;
    const host = this.root.querySelector('#part-modal-fields');
    updates.forEach((u) => {
      const m = nodes[u.index];
      if (!m) return;
      m.pos = u.pos;
      m.rot = u.rot;
      m.scale = u.scale;
      if (!host) return;
      ['0', '1', '2'].forEach((a) => {
        const pel = host.querySelector(`input[data-pos="${u.index}:${a}"]`);
        const rel = host.querySelector(`input[data-rot="${u.index}:${a}"]`);
        if (pel && document.activeElement !== pel) pel.value = m.pos[+a];
        if (rel && document.activeElement !== rel) rel.value = m.rot[+a];
      });
    });
    this._syncGroupTransformFields();
  }

  _syncGroupTransformFields() {
    if (!this._isUnifiedGroupSelection()) return;
    const host = this.root.querySelector('#part-modal-fields');
    const c = this._selectionCentre(this._transformSet());
    const n = this.buildTree.nodes[this.selectedNode];
    if (!host || !c || !n) return;
    const r = (v) => (Math.round(v * 10) / 10).toFixed(1);
    ['0', '1', '2'].forEach((a) => {
      const pel = host.querySelector(`input[data-gpos="${a}"]`);
      const rel = host.querySelector(`input[data-grot="${a}"]`);
      if (pel && document.activeElement !== pel) pel.value = r(c[+a]);
      if (rel && document.activeElement !== rel) rel.value = n.rot[+a];
    });
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
    const sel = this._transformSet().includes(i) ? this._transformSet() : [i];
    // Move applies as a rigid delta to the whole group; rotate/scale apply the
    // same delta/factor to each member (predictable for v1).
    const dPos = [newPos[0] - n.pos[0], newPos[1] - n.pos[1], newPos[2] - n.pos[2]];
    const dRot = [newRot[0] - n.rot[0], newRot[1] - n.rot[1], newRot[2] - n.rot[2]];
    const s0 = n.scale || [1, 1, 1];
    const fS = [newScale[0] / (s0[0] || 1), newScale[1] / (s0[1] || 1), newScale[2] / (s0[2] || 1)];
    const scaleOnly = this.viewport.transformMode === 'scale';
    sel.forEach((j) => {
      const m = nodes[j]; if (!m) return;
      if (j === i) {
        m.pos = newPos;
        m.scale = newScale;
        if (!scaleOnly) m.rot = newRot;
        return;
      }
      m.pos = [m.pos[0] + dPos[0], m.pos[1] + dPos[1], m.pos[2] + dPos[2]];
      if (!scaleOnly) m.rot = [m.rot[0] + dRot[0], m.rot[1] + dRot[1], m.rot[2] + dRot[2]];
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
    if (sel.length > 1) this._syncTransformMeshes(sel, nodes);
    this._syncGroupTransformFields();
  }

  // Single shape: cheap merged-only refresh. Group: rebuild every edit mesh so
  // the non-primary members (which the gizmo doesn't move live) catch up.
  _onTransformEnd() {
    if (this._transformSet().length > 1) this.recompile();
    else this._recompileMergedHUD();
    this._pushHistory();
  }

  _setXform(mode) {
    if (this.cutPlaneMode) this.viewport.setCutPlaneXform(mode);
    else this.viewport.setTransformMode(mode);
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
    if (this.cutPlaneMode) {
      this.cutPlaneMode = false;
      this.viewport?.setCutPlaneMode(false);
      this._syncCutPlaneUI();
    }
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
    this._syncBuildTools();
    if (this.mode === 'build') this._renderBuildTree();
    this.recompile(); // keep the camera as-is — code/build show the same object, so don't reframe
    this._pushHistory();
    this._syncToolbar();
    this._syncCardModeSeg();
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
    this._cardCollapsed = this.viewMode === 'result';
    this.buildTree.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    this.overrides = {};
    this._codeMirror = null;
    this.selectedNodes = [];
    this.root.querySelector('#pane-code').classList.toggle('hidden', this.mode !== 'code');
    this.root.querySelector('#editor').value = this.source;
    const card = this.root.querySelector('#part-card');
    if (card) card.classList.toggle('collapsed', this._cardCollapsed);
    document.body.classList.toggle('view-result', this.viewMode === 'result');
    this._syncWorkspaceUI();
    this._applyCardLayout();
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
    this._updateEditorGutter?.();
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
    if (error) { this._showCompileError?.(error); this._setStatus('error'); return; }
    this._showCompileError?.(null);
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

  // Centre, drop on bed, and report print-readiness (on bed + A1 mini volume).
  _printReady() {
    const nodes = this.buildTree.nodes;
    if (!nodes.length) { this._toast('Nothing on the plate yet — tap + to add a part'); return; }
    const all = nodes.map((_, i) => i);
    this.selectedNodes = all;
    this._placeOp('level');
    this._placeOp('center');
    this._placeOp('drop');
    this.recompile();
    this._pushHistory();
    const bb = this._selectionBounds(all);
    const report = printReadyReport(bb, BUILD_VOLUME.x);
    this._toast(report.message);
    if (report.ok) this.viewport.homeView();
  }

  // Build the 3MF blob. In build mode with several distinctly-coloured parts we
  // emit a multi-object 3MF (one base material per part) so a slicer can assign
  // a filament each; otherwise a plain single-mesh 3MF of the merged model.
  _build3MF() {
    if (this.mode === 'build') {
      const parts = this._getColoredParts(); // cached; reused from result view, freed on recompile
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
    if (!host) return;
    // Don't rebuild param inputs mid-typing — same keyboard-dismiss issue as build dims.
    if (host.contains(document.activeElement) && document.activeElement?.matches('input')) return;
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



  _openAddModal() {
    if (this.viewMode === 'result') this._setSidebarOpen(true);
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
          // An imported part lives in the build tree; if the import was triggered
          // from the ☰ menu while in code mode it would land invisibly behind the
          // editor, so switch to build first.
          if (this.mode !== 'build') this._switchMode('build');
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
    this.root.innerHTML = appHTML({
      addGallery: addGalleryHTML(),
      featuresHtml: featuresHelpHTML(),
      gcodeHtml: mdToHtml(gcodeHelp),
    });
  }
}

installEvents(App);
installBuildPane(App);
