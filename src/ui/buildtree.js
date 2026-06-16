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
  roundedBox: { fields: [['x', 24], ['y', 24], ['z', 24], ['r', 4]] },
};

// Half-height along the up (z) axis, so a freshly added shape sits ON the
// workplane (its base at z = 0) the way it does in Tinkercad.
function baseHalfHeight(kind, get) {
  switch (kind) {
    case 'box':        return get('z') / 2;
    case 'cylinder':   return get('h') / 2;
    case 'cone':       return get('h') / 2;
    case 'roundedBox': return get('z') / 2;
    case 'sphere':     return get('r');
    default:           return 0;
  }
}

export class BuildTree {
  constructor() { this.nodes = []; }

  add(kind) {
    const def = DEFS[kind];
    if (!def) return null;
    const fields = def.fields.map(([key, value]) => ({ key, label: key, value }));
    const get = (k) => fields.find((x) => x.key === k).value;
    const node = {
      kind,
      op: 'solid',
      pos: [0, 0, baseHalfHeight(kind, get)],
      rot: [0, 0, 0],
      fields,
    };
    this.nodes.push(node);
    return node;
  }
}

function shapeCall(node) {
  const f = (k) => node.fields.find((x) => x.key === k).value;
  switch (node.kind) {
    case 'box':        return `box(${f('x')}, ${f('y')}, ${f('z')})`;
    case 'cylinder':   return `cylinder(${f('h')}, ${f('r')})`;
    case 'sphere':     return `sphere(${f('r')})`;
    case 'cone':       return `cone(${f('h')}, ${f('r1')}, ${f('r2')})`;
    case 'roundedBox': return `roundedBox(${f('x')}, ${f('y')}, ${f('z')}, ${f('r')})`;
    default:           return null;
  }
}

// Wrap a shape call in the transforms it needs (rotate inside translate).
function placedCall(node) {
  let call = shapeCall(node);
  if (!call) return null;
  const [rx, ry, rz] = node.rot || [0, 0, 0];
  if (rx || ry || rz) call = `rotate([${rx}, ${ry}, ${rz}]) { ${call}; }`;
  else call = `${call};`;
  const [x, y, z] = node.pos;
  return (x || y || z) ? `translate([${x}, ${y}, ${z}]) { ${call} }` : call;
}

export function buildTreeToSource(tree) {
  const solids = [];
  const holes = [];
  for (const node of tree.nodes) {
    const placed = placedCall(node);
    if (!placed) continue;
    (node.op === 'hole' ? holes : solids).push(placed);
  }

  if (solids.length === 0) return '';

  // solids unioned, then holes subtracted — the mental model of the build pane.
  const solidBlock = solids.map((s) => '    ' + s).join('\n');
  if (holes.length === 0) {
    return `union() {\n${solidBlock}\n}\n`;
  }
  const holeBlock = holes.map((h) => '    ' + h).join('\n');
  return `difference() {\n  union() {\n${solidBlock.replace(/^/gm, '  ')}\n  }\n${holeBlock}\n}\n`;
}
