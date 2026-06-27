// The "build" pane's data model. A flat list of placed shapes, each marked
// solid or hole. We compile it to mini-language source so the kernel path is
// identical to the code pane — one source of truth, no second geometry engine.
//
// Emitted source is real, editable Forge code. Switching from build to code
// and pasting the output gives you exactly the same model, which is the whole
// point of keeping a single representation.

// Primitive catalogue (fields, on-plate base height, source call) lives in one
// kernel-free registry so this module and the kernel-side mesh path can't drift.
import { PRIMITIVES, fieldsFor, baseHalfHeight, primitiveSource } from './primitives.js';

const PALETTE = [0x4dd0e1, 0x66bb6a, 0xffb74d, 0xf778ba, 0xa371f7, 0x56d4dd, 0xff8a65];
let colorIx = 0;

// Build a fresh node sitting on the plate. Exported so the template importer
// can mint nodes the same way the Add buttons do.
export function createNode(kind) {
  if (!PRIMITIVES[kind]) return null;
  const fields = fieldsFor(kind);
  const get = (k) => fields.find((x) => x.key === k).value;
  return {
    kind,
    op: 'solid',
    pos: [0, 0, baseHalfHeight(kind, get)],
    rot: [0, 0, 0],
    scale: [1, 1, 1],
    color: PALETTE[colorIx++ % PALETTE.length],
    locked: false,
    hidden: false,
    clearance: 0, // fit clearance (mm): holes grow / solids shrink for press-fits
    hollow: 0, // wall thickness (mm): >0 turns the solid into a shell
    fillet: 0, // edge radius (mm): >0 rounds (or bevels) the part's convex edges
    bevel: false, // fillet style: false = round, true = chamfer
    name: '', // optional user label (shown in the parts roster)
    group: null, // group id; members combine (and scope their holes) together
    groupLabel: '', // optional friendly name for the group badge
    groupMode: 'union', // how a group combines: union | subtract | intersect | hull
    collapsed: false, // UI: part card folded to just its header
    fields,
  };
}

export class BuildTree {
  constructor() { this.nodes = []; }

  add(kind) {
    const node = createNode(kind);
    if (node) this.nodes.push(node);
    return node;
  }
}

// Switch a node's primitive type in place: reset its dimensions to the new
// shape's defaults and re-seat it on the plate (position/rotation/colour kept).
export function setNodeKind(node, kind) {
  if (!PRIMITIVES[kind]) return;
  node.kind = kind;
  node.fields = fieldsFor(kind);
  const get = (k) => node.fields.find((x) => x.key === k).value;
  node.pos[2] = baseHalfHeight(kind, get);
}

// Standard ISO metric coarse-thread fasteners: diameter, coarse pitch, hex
// across-flats (wrench size), bolt-head height, nut thickness. Picking a size
// fills these so printed bolts / nuts / threaded rods come out to spec.
export const METRIC_SIZES = [
  { key: 'M2',   d: 2,   pitch: 0.4,  af: 4,   headH: 1.4, thickness: 1.6 },
  { key: 'M2.5', d: 2.5, pitch: 0.45, af: 5,   headH: 1.7, thickness: 2.0 },
  { key: 'M3',   d: 3,   pitch: 0.5,  af: 5.5, headH: 2.0, thickness: 2.4 },
  { key: 'M4',   d: 4,   pitch: 0.7,  af: 7,   headH: 2.8, thickness: 3.2 },
  { key: 'M5',   d: 5,   pitch: 0.8,  af: 8,   headH: 3.5, thickness: 4.0 },
  { key: 'M6',   d: 6,   pitch: 1.0,  af: 10,  headH: 4.0, thickness: 5.0 },
  { key: 'M8',   d: 8,   pitch: 1.25, af: 13,  headH: 5.3, thickness: 6.5 },
  { key: 'M10',  d: 10,  pitch: 1.5,  af: 17,  headH: 6.4, thickness: 8.0 },
  { key: 'M12',  d: 12,  pitch: 1.75, af: 19,  headH: 7.5, thickness: 10  },
];

export function isFastener(kind) { return kind === 'thread' || kind === 'bolt' || kind === 'nut'; }

// Set a fastener node's fields to a standard metric size — only the fields the
// shape actually has (length is left alone).
export function applyMetricSize(node, key) {
  const m = METRIC_SIZES.find((s) => s.key === key);
  if (!m) return;
  const set = (k, v) => { const f = node.fields.find((x) => x.key === k); if (f) f.value = v; };
  set('d', m.d); set('pitch', m.pitch);
  set('headAF', m.af); set('af', m.af);                 // bolt head / nut across-flats
  set('headH', m.headH); set('thickness', m.thickness); // bolt head height / nut thickness
}

// The standard size matching a node's current diameter + pitch, or '' (custom).
export function currentMetricSize(node) {
  const d = (node.fields.find((x) => x.key === 'd') || {}).value;
  const p = (node.fields.find((x) => x.key === 'pitch') || {}).value;
  const m = METRIC_SIZES.find((s) => s.d === d && s.pitch === p);
  return m ? m.key : '';
}

// Radial / cross-section dimension keys a fit clearance adjusts, per shape.
const CLEARANCE_KEYS = {
  cylinder: ['r'], cone: ['r1', 'r2'], sphere: ['r'], prism: ['r'], pyramid: ['r'],
  tube: ['router'], torus: ['tube'], roundedCylinder: ['r'], chamferedCylinder: ['r'],
  dome: ['r'], slot: ['r'], box: ['x', 'y', 'z'], roundedBox: ['x', 'y', 'z'],
  chamferedBox: ['x', 'y', 'z'],
};
// Box-like dims span the whole part (offset applies to both sides → ×2); radial
// dims are a radius (offset once).
const CLEARANCE_X2 = new Set(['box', 'roundedBox', 'chamferedBox']);

export function supportsClearance(kind) { return !!CLEARANCE_KEYS[kind]; }

const SIZE_EDGE_KEYS = new Set(['c', 'r', 'fillet', 'chamfer']);
const SIZE_COUNT_KEYS = new Set(['sides', 'segments', 'n', 'count', 'teeth', 'points']);

// True for a numeric field that sets overall part size (not edge radius / counts).
export function isSizeField(kind, key) {
  if (SIZE_EDGE_KEYS.has(key) || SIZE_COUNT_KEYS.has(key)) return false;
  const p = PRIMITIVES[kind];
  if (!p) return false;
  return p.fields.some(([k, , type]) => k === key && type !== 'text');
}

const r2 = (v) => Math.round(v * 100) / 100;

// Fold a positive resize-scale into field values so W/D/H inputs match the mesh.
// Skips mirrored (negative) scale — those stay on node.scale.
export function bakeNodeScale(node) {
  const s = node.scale || [1, 1, 1];
  if (s[0] === 1 && s[1] === 1 && s[2] === 1) return false;
  if (s[0] < 0 || s[1] < 0 || s[2] < 0) return false;
  const xy = Math.max(Math.abs(s[0]), Math.abs(s[1]));
  for (const f of node.fields) {
    if (f.type === 'text') continue;
    const k = f.key;
    if (CLEARANCE_X2.has(node.kind) && (k === 'x' || k === 'y' || k === 'z')) {
      const ax = { x: 0, y: 1, z: 2 }[k];
      f.value = r2(f.value * Math.abs(s[ax]));
    } else if (k === 'h') {
      f.value = r2(f.value * Math.abs(s[2]));
    } else if (['r', 'r1', 'r2', 'router', 'rinner', 'radius', 'tube', 'outer', 'inner'].includes(k)) {
      f.value = r2(f.value * xy);
    }
  }
  node.scale = [1, 1, 1];
  return true;
}

// Typing a size field makes those mm the source of truth — drop resize scale.
export function resetScaleOnSizeEdit(node) {
  const s = node.scale || [1, 1, 1];
  if (s[0] === 1 && s[1] === 1 && s[2] === 1) return false;
  node.scale = [s[0] < 0 ? -1 : 1, s[1] < 0 ? -1 : 1, s[2] < 0 ? -1 : 1];
  return true;
}

// A field value with the part's fit clearance folded in: a hole grows, a solid
// shrinks, so a positive clearance always means a looser printed fit. Applied
// only to the shape's mating (radial / cross-section) dimensions.
export function effField(node, key) {
  const x = node.fields.find((y) => y.key === key);
  const raw = x ? x.value : 0;
  const c = node.clearance || 0;
  const keys = CLEARANCE_KEYS[node.kind];
  if (!c || !keys || !keys.includes(key)) return raw;
  const signed = (node.op === 'hole' ? c : -c) * (CLEARANCE_X2.has(node.kind) ? 2 : 1);
  return Math.max(0.05, raw + signed);
}

// Shell config: which dims shrink to form the inner void. byT = radius-like
// (one wall thickness in); by2T = full-extent (a wall on each side). Only shapes
// that build centred at the origin, so the inset solid stays concentric for a
// uniform-wall closed shell.
const SHELL = {
  box:          { by2T: ['x', 'y', 'z'] },
  roundedBox:   { by2T: ['x', 'y', 'z'] },
  chamferedBox: { by2T: ['x', 'y', 'z'] },
  cylinder:     { byT: ['r'], by2T: ['h'] },
  cone:         { byT: ['r1', 'r2'], by2T: ['h'] },
  prism:        { byT: ['r'], by2T: ['h'] },
  pyramid:      { byT: ['r'], by2T: ['h'] },
  sphere:       { byT: ['r'] },
};

export function isShellable(kind) { return !!SHELL[kind]; }

// Edge rounding (fillet/chamfer via minkowski opening) is general but expensive
// on dense / non-convex meshes, so it's offered only on the simpler solids —
// not text, threads, fasteners, imported meshes, or spiky/holed shapes.
const FILLET_KINDS = new Set([
  'box', 'cylinder', 'sphere', 'cone', 'pyramid', 'prism', 'wedge',
  'roundedBox', 'chamferedBox', 'roundedCylinder', 'chamferedCylinder', 'dome', 'slot',
]);
export function supportsFillet(kind) { return FILLET_KINDS.has(kind); }

// Emit a part's geometry call: the base shape, optionally hollowed into a shell,
// then optionally rounded/bevelled on its convex edges (fillet/chamfer).
export function shapeCall(node) {
  let s = baseShapeCall(node);
  if (!s) return s;

  // hollow → closed shell (fine for FDM, no drain hole); bail if wall too thick.
  const t = node.hollow || 0;
  const cfg = SHELL[node.kind];
  if (t > 0 && cfg) {
    const inner = { ...node, hollow: 0, clearance: 0, fields: node.fields.map((x) => ({ ...x })) };
    let bail = false;
    const reduce = (keys, amt) => {
      for (const k of keys || []) {
        const f = inner.fields.find((x) => x.key === k);
        if (f) { f.value -= amt; if (f.value < 0.4) bail = true; }
      }
    };
    reduce(cfg.byT, t);
    reduce(cfg.by2T, 2 * t);
    if (!bail) { const innerCall = baseShapeCall(inner); if (innerCall) s = `difference() { ${s}; ${innerCall}; }`; }
  }

  // fillet / chamfer the convex edges
  const fr = node.fillet || 0;
  if (fr > 0 && FILLET_KINDS.has(node.kind)) {
    s = `${node.bevel ? 'chamfer' : 'fillet'}(${fr}) { ${s}; }`;
  }
  return s;
}

// The base shape call as source — `kind(...args)` (or the registry's override),
// with the same clearance-adjusted field values the kernel-side mesh path uses.
function baseShapeCall(node) {
  return primitiveSource(node, (k) => effField(node, k));
}

// Wrap a shape call in the transforms it needs (rotate inside translate).
function placedCall(node) {
  const shape = shapeCall(node);
  if (!shape) return null;
  // Build TRS from the inside out: scale -> rotate -> translate.
  let call = `${shape};`;
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  if (sx !== 1 || sy !== 1 || sz !== 1) call = `scale([${sx}, ${sy}, ${sz}]) { ${call} }`;
  const [rx, ry, rz] = node.rot || [0, 0, 0];
  if (rx || ry || rz) call = `rotate([${rx}, ${ry}, ${rz}]) { ${call} }`;
  const [x, y, z] = node.pos;
  if (x || y || z) call = `translate([${x}, ${y}, ${z}]) { ${call} }`;
  return call;
}

// A group compiles to its own scoped solid: difference(union(its solids), its
// holes). Returns a single source expression, or null if it has no solids.
function groupBlock(nodes) {
  const solids = nodes.filter((n) => n.op !== 'hole').map(placedCall).filter(Boolean);
  const holes = nodes.filter((n) => n.op === 'hole').map(placedCall).filter(Boolean);
  if (solids.length === 0) return null;
  const mode = (nodes.find((n) => n.groupMode) || {}).groupMode || 'union';
  let body;
  if (mode === 'hull' && solids.length > 1) {
    body = `hull() { ${solids.join(' ')} }`; // smooth convex blend across the parts
  } else if (mode === 'intersect' && solids.length > 1) {
    body = `intersection() { ${solids.join(' ')} }`;
  } else if (mode === 'subtract' && solids.length > 1) {
    body = `difference() { ${solids[0]} ${solids.slice(1).join(' ')} }`; // first minus the rest
  } else {
    body = (solids.length === 1 && holes.length === 0) ? solids[0] : `union() { ${solids.join(' ')} }`;
  }
  if (holes.length === 0) return body;
  return `difference() { ${body} ${holes.join(' ')} }`;
}

export function buildTreeToSource(tree) {
  const visible = tree.nodes.filter((n) => !n.hidden);

  // Partition into ungrouped nodes and groups. A group's holes only cut that
  // group; ungrouped (top-level) holes cut everything.
  const groups = new Map();
  const loose = [];
  for (const n of visible) {
    if (n.group == null) loose.push(n);
    else { if (!groups.has(n.group)) groups.set(n.group, []); groups.get(n.group).push(n); }
  }

  const topSolids = loose.filter((n) => n.op !== 'hole').map(placedCall).filter(Boolean);
  for (const nodes of groups.values()) { const b = groupBlock(nodes); if (b) topSolids.push(b); }
  const topHoles = loose.filter((n) => n.op === 'hole').map(placedCall).filter(Boolean);

  if (topSolids.length === 0) return '';

  const solidBlock = topSolids.map((s) => '    ' + s).join('\n');
  if (topHoles.length === 0) {
    return `union() {\n${solidBlock}\n}\n`;
  }
  const holeBlock = topHoles.map((h) => '    ' + h).join('\n');
  return `difference() {\n  union() {\n${solidBlock.replace(/^/gm, '  ')}\n  }\n${holeBlock}\n}\n`;
}

// For multi-colour export: each top-level coloured unit (a loose solid, or a
// group) as its own compile source with the top-level holes subtracted, paired
// with its colour. Mirrors buildTreeToSource's boolean semantics so each part
// is the same geometry it contributes to the merged model. Groups export as one
// object using their first solid's colour. Returns [{ source, color }].
export function buildColoredParts(tree) {
  const visible = tree.nodes.filter((n) => !n.hidden);
  const loose = visible.filter((n) => n.group == null);
  const groups = new Map();
  for (const n of visible) {
    if (n.group == null) continue;
    if (!groups.has(n.group)) groups.set(n.group, []);
    groups.get(n.group).push(n);
  }
  const topHoles = loose.filter((n) => n.op === 'hole').map(placedCall).filter(Boolean);
  const cut = (body) => (topHoles.length ? `difference() { ${body} ${topHoles.join(' ')} }` : body);

  const parts = [];
  for (const n of loose.filter((n) => n.op !== 'hole')) {
    const s = placedCall(n);
    if (s) parts.push({ source: cut(s), color: n.color });
  }
  for (const nodes of groups.values()) {
    const body = groupBlock(nodes);
    if (!body) continue;
    const firstSolid = nodes.find((n) => n.op !== 'hole');
    parts.push({ source: cut(body), color: firstSolid ? firstSolid.color : 0xcccccc });
  }
  return parts;
}
