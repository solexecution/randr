// The "build" pane's data model. A flat list of placed shapes, each marked
// solid or hole. We compile it to mini-language source so the kernel path is
// identical to the code pane — one source of truth, no second geometry engine.
//
// Emitted source is real, editable Forge code. Switching from build to code
// and pasting the output gives you exactly the same model, which is the whole
// point of keeping a single representation.

const DEFS = {
  box:        { fields: [['x', 20], ['y', 20], ['z', 20]] },
  cylinder:   { fields: [['h', 20], ['r', 10]] },
  sphere:     { fields: [['r', 12]] },
  cone:       { fields: [['h', 24], ['r1', 12], ['r2', 0]] },
  pyramid:    { fields: [['h', 26], ['r', 15]] },
  torus:      { fields: [['radius', 18], ['tube', 6]] },
  wedge:      { fields: [['w', 30], ['d', 30], ['h', 24]] },
  roundedBox: { fields: [['x', 24], ['y', 24], ['z', 24], ['r', 4]] },
  bolt:       { fields: [['d', 16], ['pitch', 2.5], ['length', 20], ['headAF', 24], ['headH', 10]] },
  nut:        { fields: [['d', 16], ['pitch', 2.5], ['thickness', 12], ['af', 24]] },
};

// Half-height along the up (z) axis, so a freshly added shape sits ON the
// workplane (its base at z = 0) the way it does in Tinkercad.
function baseHalfHeight(kind, get) {
  switch (kind) {
    case 'box':        return get('z') / 2;
    case 'cylinder':   return get('h') / 2;
    case 'cone':       return get('h') / 2;
    case 'pyramid':    return get('h') / 2;
    case 'torus':      return get('tube');
    case 'wedge':      return 0; // already sits on the plate
    case 'roundedBox': return get('z') / 2;
    case 'sphere':     return get('r');
    case 'bolt':       return 0; // built base-on-plate
    case 'nut':        return 0; // built base-on-plate
    default:           return 0;
  }
}

const PALETTE = [0x4dd0e1, 0x66bb6a, 0xffb74d, 0xf778ba, 0xa371f7, 0x56d4dd, 0xff8a65];
let colorIx = 0;

function fieldsFor(kind) {
  return DEFS[kind].fields.map(([key, value]) => ({ key, label: key, value }));
}

// Build a fresh node sitting on the plate. Exported so the template importer
// can mint nodes the same way the Add buttons do.
export function createNode(kind) {
  if (!DEFS[kind]) return null;
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
    group: null, // group id; members combine (and scope their holes) together
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
  if (!DEFS[kind]) return;
  node.kind = kind;
  node.fields = fieldsFor(kind);
  const get = (k) => node.fields.find((x) => x.key === k).value;
  node.pos[2] = baseHalfHeight(kind, get);
}

function shapeCall(node) {
  const f = (k) => node.fields.find((x) => x.key === k).value;
  switch (node.kind) {
    case 'box':        return `box(${f('x')}, ${f('y')}, ${f('z')})`;
    case 'cylinder':   return `cylinder(${f('h')}, ${f('r')})`;
    case 'sphere':     return `sphere(${f('r')})`;
    case 'cone':       return `cone(${f('h')}, ${f('r1')}, ${f('r2')})`;
    case 'pyramid':    return `pyramid(${f('h')}, ${f('r')})`;
    case 'torus':      return `torus(${f('radius')}, ${f('tube')})`;
    case 'wedge':      return `wedge(${f('w')}, ${f('d')}, ${f('h')})`;
    case 'roundedBox': return `roundedBox(${f('x')}, ${f('y')}, ${f('z')}, ${f('r')})`;
    case 'bolt':       return `bolt(${f('d')}, ${f('pitch')}, ${f('length')}, ${f('headAF')}, ${f('headH')})`;
    case 'nut':        return `nut(${f('d')}, ${f('pitch')}, ${f('thickness')}, ${f('af')})`;
    default:           return null;
  }
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
  const body = (solids.length === 1 && holes.length === 0)
    ? solids[0]
    : `union() { ${solids.join(' ')} }`;
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
