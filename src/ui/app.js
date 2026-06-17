// Application controller. Ties the three surfaces together:
//   1. Code pane  — the parametric mini-language (OpenSCAD-style)
//   2. Build pane — touch primitives you place/drag on the workplane (Tinkercad)
//   3. Viewport   — the shared result of whichever pane is active
//
// Both panes ultimately produce mini-language source, so the kernel only ever
// sees one input format. The build pane is a structured editor that emits
// source; a touch-built model can be opened in the code pane and vice versa.

import { loadKernel, inspect, box, cylinder, sphere, cone, pyramid, torus, wedge, roundedBox, tube, prism, text, bolt, nut } from '../kernel/manifold.js';
import { manifoldToGeometry } from '../kernel/mesh.js';
import { compile } from '../lang/compile.js';
import { exportSTL, exportOBJ, export3MF, triggerDownload } from '../kernel/export.js';
import { Viewport } from './viewport.js';
import { buildTreeToSource, BuildTree, setNodeKind } from './buildtree.js';
import { sourceToNodes } from './importBuild.js';

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
      case 'pyramid':    m = pyramid(f('h'), f('r')); break;
      case 'torus':      m = torus(f('radius'), f('tube')); break;
      case 'wedge':      m = wedge(f('w'), f('d'), f('h')); break;
      case 'roundedBox': m = roundedBox(f('x'), f('y'), f('z'), f('r')); break;
      case 'tube':       m = tube(f('h'), f('router'), f('rinner')); break;
      case 'prism':      m = prism(f('h'), f('r'), f('sides')); break;
      case 'text':       m = text(f('str'), f('size'), f('height')); break;
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
};

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
    this.selectedNodes = [];
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
    this.viewport.onShapeMove = (i, pos) => this._onShapeMove(i, pos);
    this.viewport.onShapeMoveEnd = (i, pos) => this._onShapeMoveEnd(i, pos);
    this.viewport.onTransform = (i, t) => this._onTransform(i, t);
    this.viewport.onTransformEnd = (i) => this._onTransformEnd(i);
    window.__forgeExport = { exportSTL, export3MF, exportOBJ }; // scripting/test hook
    window.__dbg = { src: () => buildTreeToSource(this.buildTree), compile }; // debug
    this._bindEvents();
    this.recompile(true);
    this._pushHistory();
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

  _renderAlignBar() {
    const align = this.root.querySelector('#alignbar');
    if (align) align.classList.toggle('hidden', this.selectedNodes.length < 2);
    const ops = this.root.querySelector('#opsbar');
    if (ops) ops.classList.toggle('hidden', this.selectedNodes.length < 1);
    const arr = this.root.querySelector('#arraybar');
    if (arr) arr.classList.toggle('hidden', this.selectedNodes.length < 1);
    const grp = this.root.querySelector('#groupbar');
    if (grp) {
      const nodes = this.buildTree.nodes;
      const hasGroup = this.selectedNodes.some((i) => nodes[i] && nodes[i].group != null);
      const canGroup = this.selectedNodes.length >= 2;
      grp.classList.toggle('hidden', !(canGroup || hasGroup));
      const gb = grp.querySelector('[data-group="group"]');
      const ub = grp.querySelector('[data-group="ungroup"]');
      if (gb) gb.disabled = !canGroup;
      if (ub) ub.disabled = !hasGroup;
      // boolean-mode buttons: only meaningful for a group; highlight the active one
      const modes = new Set(this.selectedNodes.map((i) => nodes[i]).filter((n) => n && n.group != null).map((n) => n.groupMode || 'union'));
      const active = modes.size === 1 ? [...modes][0] : null;
      grp.querySelectorAll('[data-gmode]').forEach((b) => {
        b.classList.toggle('hidden', !hasGroup);
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

  // place ops on the selection: drop to plate, center, level (reset rot), reset scale
  _placeOp(act) {
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
        color: s.color, locked: s.locked, hidden: s.hidden, group: g, fields: s.fields.map((f) => ({ ...f })),
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
    return JSON.stringify({ mode: this.mode, source: this.source, nodes: this.buildTree.nodes });
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
  }

  _restore(snap) {
    const d = JSON.parse(snap);
    this._restoring = true;
    this.mode = d.mode;
    this.source = d.source;
    this.buildTree.nodes = d.nodes;
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
          this._toast('This design uses features build mode can’t edit yet — staying in code');
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
      this._codeMirror = null; // code edited by hand — no longer a clean mirror of the build tree
      this._scheduleRecompile();
    });

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
    $('#btn-3mf').addEventListener('click', () => out(export3MF, 'part.3mf'));
    $('#btn-obj').addEventListener('click', () => out(exportOBJ, 'part.obj'));
    document.addEventListener('click', () => menu.classList.remove('open'));

    // templates dropdown
    const tpl = $('#tpl-menu');
    $('#tpl-btn').addEventListener('click', (e) => { e.stopPropagation(); tpl.classList.toggle('open'); });
    this.root.querySelectorAll('[data-tpl]').forEach((b) =>
      b.addEventListener('click', () => { this._loadTemplate(b.dataset.tpl); tpl.classList.remove('open'); }));
    document.addEventListener('click', () => tpl.classList.remove('open'));

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

    // mirror / flip + array toolbars
    this.root.querySelectorAll('[data-flip]').forEach((b) =>
      b.addEventListener('click', () => this._flip(b.dataset.flip)));
    this.root.querySelectorAll('[data-arr]').forEach((b) =>
      b.addEventListener('click', () => this._arrayOp(b.dataset.arr)));

    // build pane
    this._bindBuildPane();

    // keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (typing) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); this._undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this._redo(); return; }
      if (k === 'f') { this.viewport.fitView(); return; }
      if (k === 'g') { $('#v-grid').classList.toggle('on', this.viewport.toggleGrid()); return; }
      if (this.mode === 'build' && 'wer'.includes(k) && !e.ctrlKey && !e.metaKey) {
        this._setXform({ w: 'translate', e: 'rotate', r: 'scale' }[k]); return;
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
    this.root.querySelectorAll('[data-add]').forEach((b) =>
      b.addEventListener('click', () => this._addShape(b.dataset.add)));
    this._renderBuildTree();
  }

  _addShape(kind) {
    this.buildTree.add(kind);
    this.selectedNode = this.buildTree.nodes.length - 1;
    this._renderBuildTree();
    this.recompile();
    this._pushHistory();
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
    const KINDS = ['box', 'cylinder', 'sphere', 'cone', 'pyramid', 'torus', 'wedge', 'roundedBox', 'tube', 'prism', 'text', 'bolt', 'nut'];
    const COUNT_KEYS = new Set(['sides', 'segments', 'n', 'count', 'teeth']);
    const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    this.buildTree.nodes.forEach((node, idx) => {
      const row = document.createElement('div');
      row.className = 'build-node'
        + (node.op === 'hole' ? ' is-hole' : '')
        + (idx === this.selectedNode ? ' sel' : '')
        + (node.hidden ? ' is-hidden' : '');
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
          ${node.group != null ? `<span class="bn-grp" title="Group ${node.group}">G${node.group}</span>` : ''}
          <select class="bn-type" data-type="${idx}" title="Shape type">
            ${KINDS.map((k) => `<option value="${k}" ${k === node.kind ? 'selected' : ''}>${k === 'roundedBox' ? 'rounded' : k}</option>`).join('')}
          </select>
          <span class="bn-color-wrap">
            <input type="color" class="bn-swatch" data-color="${idx}" value="${hex(node.color)}" title="Pick colour" ${node.op === 'hole' ? 'disabled' : ''}>
            <input type="text" class="bn-hex" data-hex="${idx}" value="${hex(node.color)}" maxlength="7" spellcheck="false" title="Hex colour" ${node.op === 'hole' ? 'disabled' : ''}>
          </span>
          <div class="bn-ops">
            <button class="bn-op ${node.op}" data-op="${idx}" title="Toggle solid / hole">${node.op}</button>
            <button class="bn-ic ${node.locked ? 'on' : ''}" data-lock="${idx}" title="Lock position">${node.locked ? '🔒' : '🔓'}</button>
            <button class="bn-ic" data-hide="${idx}" title="${node.hidden ? 'Show' : 'Hide'}">${node.hidden ? '🚫' : '👁'}</button>
            <button class="bn-ic bn-del" data-del="${idx}" title="Delete">✕</button>
          </div>
        </div>
        <div class="bn-fields">${dims}</div>
        <div class="bn-fields bn-xyz">
          <label data-unit="mm">x<input type="number" step="0.5" value="${node.pos[0]}" data-pos="${idx}:0"></label>
          <label data-unit="mm">y<input type="number" step="0.5" value="${node.pos[1]}" data-pos="${idx}:1"></label>
          <label data-unit="mm">z<input type="number" step="0.5" value="${node.pos[2]}" data-pos="${idx}:2"></label>
          <label data-unit="°">rx<input type="number" step="15" value="${node.rot[0]}" data-rot="${idx}:0"></label>
          <label data-unit="°">ry<input type="number" step="15" value="${node.rot[1]}" data-rot="${idx}:1"></label>
          <label data-unit="°">rz<input type="number" step="15" value="${node.rot[2]}" data-rot="${idx}:2"></label>
        </div>`;
      row.addEventListener('mousedown', (e) => {
        if (e.target.closest('input, button, select')) return;
        this._selectNode(idx, e.shiftKey);
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
    host.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => this._deleteNode(+el.dataset.del)));
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
            <button class="icon-btn" id="v-undo" title="Undo (Ctrl+Z)">↶</button>
            <button class="icon-btn" id="v-redo" title="Redo (Ctrl+Y)">↷</button>
            <span class="tb-sep"></span>
            <button class="icon-btn" id="v-fit" title="Fit to view (F)">⤢</button>
            <button class="icon-btn" id="v-top" title="Top view">⊟</button>
            <button class="icon-btn" id="v-front" title="Front view">⊡</button>
            <button class="icon-btn on" id="v-grid" title="Toggle grid (G)">▦</button>
            <button class="icon-btn" id="v-wire" title="Toggle wireframe">◇</button>
            <button class="icon-btn on" id="v-snap" title="Snap to 1 mm / 15°">⌗</button>
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
            <div class="xform hidden" id="opsbar">
              <span class="xform-label">place</span>
              <button data-op-act="drop" title="Drop onto the plate">⤓ base</button>
              <button data-op-act="center" title="Center on the plate">⊹ center</button>
              <button data-op-act="level" title="Reset rotation">⟲ level</button>
              <button data-op-act="scale" title="Reset scale to 1:1">1:1</button>
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
            </div>
            <p class="hint">Shift-click shapes to multi-select · align lines them up with the last one.</p>
            <div class="pane-title">add shape</div>
            <div class="add-row">
              <button data-add="box">box</button>
              <button data-add="cylinder">cylinder</button>
              <button data-add="sphere">sphere</button>
              <button data-add="cone">cone</button>
              <button data-add="pyramid">pyramid</button>
              <button data-add="torus">torus</button>
              <button data-add="wedge">wedge</button>
              <button data-add="roundedBox">rounded</button>
              <button data-add="tube">tube</button>
              <button data-add="prism">prism</button>
              <button data-add="text">text</button>
              <button data-add="bolt">bolt</button>
              <button data-add="nut">nut</button>
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
            <div class="hud-row hidden" id="hud-sel-row"><span class="hud-key">select</span><span id="hud-sel">—</span></div>
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
