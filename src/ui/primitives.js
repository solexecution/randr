// The single catalogue of build-mode primitives. ONE row per kind — default
// fields, on-plate base height, the kernel/source call signature, and the
// Add-gallery presentation. Both geometry paths derive from the same `args`
// here: buildtree.js renders `kind(...args)` as source (baseShapeCall), and
// app.js calls the same-named kernel fn with the same args for the edit-view
// mesh (nodeToGeometry). Keeping one declaration is what stops those two
// switches from drifting apart.
//
// Kernel-free on purpose: buildtree.js (and its unit tests) import this without
// pulling in the WASM kernel. The manifold side lives in app.js, where the
// kernel is imported, and reads `args` from here.

const escStr = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const ptsLit = (node) => (node.points || []).map(([x, y]) => `[${x}, ${y}]`).join(', ');

// Per row:
//   fields   – default field defs: [key, value, type?]
//   base(g)  – on-plate half-height, g(key) → current value (omitted ⇒ 0)
//   args     – field keys passed, in order, to the same-named source/kernel fn
//   source   – override (node, f) → source string when it isn't `kind(...args)`
//   cat      – Add-gallery section (omitted ⇒ not a gallery tile)
//   label    – gallery label (omitted ⇒ the kind)
//   title    – gallery tooltip
//   addable  – false ⇒ not offered in the kind picker / command palette
//              (created only via the draw / import flows)
export const PRIMITIVES = {
  box:        { fields: [['x', 20], ['y', 20], ['z', 20]], base: (g) => g('z') / 2, args: ['x', 'y', 'z'], cat: 'basic' },
  cylinder:   { fields: [['h', 20], ['r', 10]], base: (g) => g('h') / 2, args: ['h', 'r'], cat: 'basic' },
  sphere:     { fields: [['r', 12]], base: (g) => g('r'), args: ['r'], cat: 'basic' },
  cone:       { fields: [['h', 24], ['r1', 12], ['r2', 0]], base: (g) => g('h') / 2, args: ['h', 'r1', 'r2'], cat: 'basic' },
  pyramid:    { fields: [['h', 26], ['r', 15]], base: (g) => g('h') / 2, args: ['h', 'r'], cat: 'basic' },
  prism:      { fields: [['h', 20], ['r', 12], ['sides', 6]], base: (g) => g('h') / 2, args: ['h', 'r', 'sides'], cat: 'basic' },
  gear:       { fields: [['teeth', 16], ['module', 2], ['h', 6], ['bore', 4]], base: (g) => g('h') / 2, args: ['teeth', 'module', 'h', 'bore'], cat: 'basic' },
  wedge:      { fields: [['w', 30], ['d', 30], ['h', 24]], args: ['w', 'd', 'h'], cat: 'basic' },
  torus:      { fields: [['radius', 18], ['tube', 6]], base: (g) => g('tube'), args: ['radius', 'tube'], cat: 'basic' },
  dome:       { fields: [['r', 14]], args: ['r'], cat: 'basic' },
  slot:       { fields: [['length', 40], ['r', 8], ['h', 10]], base: (g) => g('h') / 2, args: ['length', 'r', 'h'], cat: 'basic' },
  star:       { fields: [['points', 5], ['outer', 18], ['inner', 8], ['h', 8]], base: (g) => g('h') / 2, args: ['points', 'outer', 'inner', 'h'], cat: 'basic' },

  roundedBox: { fields: [['x', 24], ['y', 24], ['z', 24], ['r', 4]], base: (g) => g('z') / 2, args: ['x', 'y', 'z', 'r'], cat: 'rounded', label: 'round box' },
  roundedCylinder: { fields: [['h', 20], ['r', 12], ['fillet', 3]], args: ['h', 'r', 'fillet'], cat: 'rounded', label: 'round cyl' },
  chamferedBox: { fields: [['x', 24], ['y', 24], ['z', 24], ['c', 4]], base: (g) => g('z') / 2, args: ['x', 'y', 'z', 'c'], cat: 'rounded', label: 'cham box' },
  chamferedCylinder: { fields: [['h', 20], ['r', 12], ['chamfer', 3]], args: ['h', 'r', 'chamfer'], cat: 'rounded', label: 'cham cyl' },
  tube:       { fields: [['h', 20], ['router', 12], ['rinner', 7]], base: (g) => g('h') / 2, args: ['h', 'router', 'rinner'], cat: 'rounded' },

  text:       { fields: [['str', 'Text', 'text'], ['size', 12], ['height', 4]], args: ['str', 'size', 'height'], cat: 'text',
                source: (n, f) => `text("${escStr(f('str'))}", ${f('size')}, ${f('height')})` },

  bolt:       { fields: [['d', 16], ['pitch', 2.5], ['length', 20], ['headAF', 24], ['headH', 10]], args: ['d', 'pitch', 'length', 'headAF', 'headH'], cat: 'fasteners' },
  nut:        { fields: [['d', 16], ['pitch', 2.5], ['thickness', 12], ['af', 24]], args: ['d', 'pitch', 'thickness', 'af'], cat: 'fasteners' },
  thread:     { fields: [['d', 12], ['pitch', 2.5], ['length', 24]], args: ['length', 'pitch', 'd'], cat: 'fasteners', label: 'rod' },
  counterbore: { fields: [['shaftD', 3.4], ['depth', 12], ['headD', 6], ['headDepth', 3.5]], args: ['shaftD', 'depth', 'headD', 'headDepth'], cat: 'fasteners', label: "c'bore", title: 'Counterbore hole (cap screw sits below)' },
  countersink: { fields: [['shaftD', 3.4], ['depth', 12], ['headD', 6.5]], args: ['shaftD', 'depth', 'headD'], cat: 'fasteners', label: "c'sink", title: 'Countersink hole (flat-head sits flush)' },
  insertHole:  { fields: [['insertD', 4], ['depth', 6]], args: ['insertD', 'depth'], cat: 'fasteners', label: 'insert', title: 'Heat-set insert pocket' },
  nutTrap:     { fields: [['af', 5.5], ['nutThick', 2.6], ['boltD', 3.4], ['shaftDepth', 14]], args: ['af', 'nutThick', 'boltD', 'shaftDepth'], cat: 'fasteners', label: 'nut trap', title: 'Captive nut trap (hex pocket + bolt shaft)' },
  keyhole:     { fields: [['headD', 8], ['slotW', 4], ['length', 12], ['depth', 6]], args: ['headD', 'slotW', 'length', 'depth'], cat: 'fasteners', label: 'keyhole', title: 'Keyhole slot — hang the print on a screw' },

  // Built only through the draw / import flows — no gallery tile, not in the kind
  // picker. Their source/mesh come from node.points / node.meshId, not fields.
  imported:   { fields: [], addable: false, source: (n) => `imported("${n.meshId || ''}")` },
  extrusion:  { fields: [['height', 10]], base: (g) => g('height') / 2, addable: false, source: (n, f) => `extrude([${ptsLit(n)}], ${f('height')})` },
  revolution: { fields: [['degrees', 360]], addable: false, source: (n, f) => `revolve([${ptsLit(n)}], ${f('degrees')})` },
};

// The user-addable kinds (kind picker + command palette), in catalogue order.
export const ADDABLE_KINDS = Object.keys(PRIMITIVES).filter((k) => PRIMITIVES[k].addable !== false);

// Mini-language function names for syntax highlighting: the primitive call names
// (extrusion/revolution compile to extrude/revolve) plus the non-primitive
// builtins (transforms, booleans, math).
export const PRIMITIVE_FNS = Object.keys(PRIMITIVES).filter((k) => k !== 'extrusion' && k !== 'revolution');

// On-plate half-height for a fresh node; 0 when the kind builds base-on-plate.
export function baseHalfHeight(kind, get) {
  const p = PRIMITIVES[kind];
  return p && p.base ? p.base(get) : 0;
}

// Default field list for a kind (fresh, editable copies).
export function fieldsFor(kind) {
  return PRIMITIVES[kind].fields.map(([key, value, type]) => ({ key, label: key, value, type: type || 'number' }));
}

// The base shape call as source: `kind(...args)`, or the row's custom override.
// `f(key)` resolves the (clearance-adjusted) field value — passed in so this
// module stays free of buildtree's effField (and of any import cycle).
export function primitiveSource(node, f) {
  const p = PRIMITIVES[node.kind];
  if (!p) return null;
  if (p.source) return p.source(node, f);
  return `${node.kind}(${p.args.map(f).join(', ')})`;
}
