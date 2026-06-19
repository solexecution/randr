// Source -> build-tree importer. Turns a chunk of Forge code (a template, or
// whatever is in the code pane) into the flat list of placed primitives the
// build pane edits. It handles the subset the build tree can represent:
// param/assign declarations, a top-level union/difference (or bare shapes),
// and primitives wrapped in translate/rotate/scale. Anything outside that
// throws, so the caller can fall back to loading the code as-is.

import { tokenize, ForgeError } from '../lang/tokenizer.js';
import { parse } from '../lang/parser.js';
import { createNode } from './buildtree.js';

const TAU = Math.PI * 2;
const TRANSFORMS = new Set(['translate', 'rotate', 'scale', 'mirror']);
const BOOLEANS = new Set(['union', 'difference', 'intersection', 'hull']);
const PRIMS = new Set([
  'box', 'cube', 'cylinder', 'sphere', 'cone', 'pyramid', 'torus', 'wedge',
  'dome', 'slot', 'star', 'roundedBox', 'roundedCylinder', 'chamferedBox', 'chamferedCylinder',
  'tube', 'prism', 'gear', 'text', 'imported', 'thread', 'bolt', 'nut',
]);

const MATH = {
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: Math.round, min: Math.min, max: Math.max, pow: Math.pow,
};

// Evaluate a constant expression (numbers, params, arithmetic, math calls).
function constEval(node, env) {
  switch (node.type) {
    case 'Number': {
      let v = node.value;
      if (node.unit === 'cm') v *= 10;
      if (node.unit === 'rad') v = (v / TAU) * 360;
      return v;
    }
    case 'Str':
      return node.value;
    case 'Ident':
      if (node.name in env) return env[node.name];
      if (node.name === 'PI') return Math.PI;
      throw new ForgeError(`Template uses '${node.name}', which can't be resolved for build mode`);
    case 'List':
      return node.items.map((x) => constEval(x, env));
    case 'Unary': {
      const v = constEval(node.operand, env);
      return node.op === '-' ? -v : !v;
    }
    case 'Binary': {
      const l = constEval(node.left, env), r = constEval(node.right, env);
      switch (node.op) {
        case '+': return l + r; case '-': return l - r;
        case '*': return l * r; case '/': return l / r; case '%': return l % r;
        default: throw new ForgeError(`Unsupported operator ${node.op}`);
      }
    }
    case 'Call':
      if (MATH[node.name]) return MATH[node.name](...node.args.map((a) => constEval(a, env)));
      throw new ForgeError(`Can't evaluate ${node.name}() for build mode`);
    default:
      throw new ForgeError(`Can't import this expression into build mode`);
  }
}

const r2 = (v) => { const x = Math.round(v * 100) / 100; return x === 0 ? 0 : x; };
const r3 = (v) => { const x = Math.round(v * 1000) / 1000; return x === 0 ? 0 : x; };

// Peel translate/rotate/scale off a shape, accumulating TRS, until we reach a
// primitive. Returns a build node (op still 'solid'; caller sets it).
function unwrap(expr, env) {
  // Source span of the whole placed statement (outermost transform down to the
  // primitive) so the editor can map a caret position back to this shape.
  const srcStart = expr.start, srcEnd = expr.end;
  let pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], guard = 0;
  while (expr.type === 'Call' && TRANSFORMS.has(expr.name)) {
    if (++guard > 16) throw new ForgeError('Too many nested transforms to import');
    const raw = constEval(expr.args[0], env);
    let vec = Array.isArray(raw) ? raw : (expr.name === 'rotate' ? [0, 0, raw] : [raw, raw, raw]);
    vec = [vec[0] || 0, vec[1] || 0, vec[2] || 0];
    if (expr.name === 'translate') pos = [pos[0] + vec[0], pos[1] + vec[1], pos[2] + vec[2]];
    else if (expr.name === 'rotate') rot = [rot[0] + vec[0], rot[1] + vec[1], rot[2] + vec[2]];
    else if (expr.name === 'mirror') {
      // An axis-aligned mirror is a negative scale on that axis (the same way
      // build's flip stores it). A mirror across an oblique plane has no flat form.
      const axes = [0, 1, 2].filter((i) => vec[i]);
      if (axes.length !== 1) throw new ForgeError("Build mode can't represent a mirror across an oblique plane");
      const m = [1, 1, 1]; m[axes[0]] = -1;
      scale = [scale[0] * m[0], scale[1] * m[1], scale[2] * m[2]];
    } else scale = [scale[0] * vec[0], scale[1] * vec[1], scale[2] * vec[2]];
    const kids = expr.children ? expr.children.body : [];
    if (kids.length !== 1 || kids[0].type !== 'ExprStmt') {
      throw new ForgeError('A transform wrapping more than one shape can\'t be imported');
    }
    expr = kids[0].expr;
  }
  if (expr.type !== 'Call' || !PRIMS.has(expr.name)) {
    const what = expr.type === 'Call' ? `${expr.name}()` : 'this shape';
    throw new ForgeError(`Build mode can't represent ${what} yet`);
  }
  const kind = expr.name === 'cube' ? 'box' : expr.name;
  const node = createNode(kind);
  if (srcStart != null) { node.srcStart = srcStart; node.srcEnd = srcEnd; }
  const args = expr.args;

  if (kind === 'imported') {
    node.meshId = args[0] !== undefined ? String(constEval(args[0], env)) : '';
    node.meshName = node.meshId;
    node.pos = [r2(pos[0]), r2(pos[1]), r2(pos[2])];
    node.rot = [r2(rot[0]), r2(rot[1]), r2(rot[2])];
    node.scale = [r3(scale[0]), r3(scale[1]), r3(scale[2])];
    return node;
  }

  if (kind === 'box' && args.length === 1) {
    const v = constEval(args[0], env);
    const s = Array.isArray(v) ? v : [v, v, v];
    node.fields[0].value = s[0]; node.fields[1].value = s[1]; node.fields[2].value = s[2];
  } else {
    node.fields.forEach((f, i) => {
      if (expr.named && f.key in expr.named) f.value = constEval(expr.named[f.key], env);
      else if (args[i] !== undefined) f.value = constEval(args[i], env);
    });
  }

  node.pos = [r2(pos[0]), r2(pos[1]), r2(pos[2])];
  node.rot = [r2(rot[0]), r2(rot[1]), r2(rot[2])];
  node.scale = [r3(scale[0]), r3(scale[1]), r3(scale[2])];
  return node;
}

const kidsOf = (expr) => (expr.children ? expr.children.body : []).filter((s) => s.type === 'ExprStmt');

// Flatten a shape expression into build nodes, tagging solids vs holes. `grp`
// ({id,mode}) marks the group the current shapes belong to (null = top level);
// `state.gid` mints fresh group ids.
function collect(expr, env, op, out, grp, state) {
  if (expr.type === 'Call' && expr.name === 'difference') {
    const kids = kidsOf(expr);
    if (kids[0]) collect(kids[0].expr, env, 'solid', out, grp, state);
    for (let i = 1; i < kids.length; i++) collect(kids[i].expr, env, 'hole', out, grp, state);
    return;
  }
  if (expr.type === 'Call' && (expr.name === 'union' || expr.name === 'hull')) {
    kidsOf(expr).forEach((k) => collect(k.expr, env, op, out, grp, state));
    return;
  }
  // intersection has no flat solid/hole form, so bring its parts in as an
  // intersect group — the inverse of what buildTreeToSource emits for one. A
  // boolean nested directly inside can't be flattened this way (it would change
  // the geometry), so bail to keep the design in code rather than corrupt it.
  if (expr.type === 'Call' && expr.name === 'intersection') {
    const sub = { id: (state.gid += 1), mode: 'intersect' };
    kidsOf(expr).forEach((k) => {
      if (k.expr.type === 'Call' && BOOLEANS.has(k.expr.name)) {
        throw new ForgeError("Build mode can't represent a boolean inside an intersection yet");
      }
      collect(k.expr, env, 'solid', out, sub, state);
    });
    return;
  }
  const node = unwrap(expr, env);
  node.op = op;
  if (grp) { node.group = grp.id; node.groupMode = grp.mode; }
  out.push(node);
}

// Parse `source` and return an array of build-tree nodes. Throws (ForgeError)
// if the source uses anything the build tree can't hold.
export function sourceToNodes(source) {
  const ast = parse(tokenize(source));
  const env = {};
  for (const s of ast.body) {
    if (s.type === 'Param' || s.type === 'Assign') env[s.name] = constEval(s.value, env);
  }
  const out = [];
  const state = { gid: 0 };
  for (const s of ast.body) {
    if (s.type === 'ExprStmt') collect(s.expr, env, 'solid', out, null, state);
  }
  if (out.length === 0) throw new ForgeError('Nothing to import from this template');
  return out;
}
