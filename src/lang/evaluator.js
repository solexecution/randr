// Evaluator. Walks the AST, resolves values, and calls the kernel to build
// solids. Returns the final assembled Manifold plus the list of `param`
// declarations so the UI can render live sliders.
//
// Design notes:
// - A statement that evaluates to a solid contributes it to its enclosing
//   block's implicit union. The top level is itself a block, so a script that
//   just lists shapes produces their union — the least surprising default.
// - Transform/Boolean calls consume their child block. cube()/sphere() etc.
//   ignore children.
// - Param overrides come from the UI: when present they replace the declared
//   default, which is what drives interactive editing.

import { ForgeError } from './tokenizer.js';
import * as K from '../kernel/manifold.js';

const TAU = Math.PI * 2;

export function evaluate(ast, overrides = {}) {
  const params = [];        // declared params, in source order
  const env = new Map();    // name -> value
  const solids = [];        // every solid created, for cleanup

  const track = (m) => { solids.push(m); return m; };

  function toNumber(node) {
    const v = evalExpr(node);
    if (typeof v !== 'number') throw new ForgeError(`Expected a number, got ${typeof v}`);
    return v;
  }

  function numWithUnit(numberNode) {
    let v = numberNode.value;
    if (numberNode.unit === 'cm') v *= 10;       // normalise to mm
    if (numberNode.unit === 'rad') v = (v / TAU) * 360; // normalise to deg
    return v;
  }

  function evalExpr(node) {
    switch (node.type) {
      case 'Number':
        return numWithUnit(node);

      case 'Str':
        return node.value;

      case 'Ident': {
        if (env.has(node.name)) return env.get(node.name);
        if (node.name === 'PI') return Math.PI;
        if (node.name === 'true') return true;
        if (node.name === 'false') return false;
        throw new ForgeError(`Unknown name '${node.name}'`);
      }

      case 'List':
        return node.items.map(evalExpr);

      case 'Unary': {
        const v = evalExpr(node.operand);
        if (node.op === '-') return -v;
        if (node.op === '!') return !v;
        return v;
      }

      case 'Binary': {
        const l = evalExpr(node.left);
        const r = evalExpr(node.right);
        switch (node.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
          case '%': return l % r;
          case '<': return l < r;
          case '>': return l > r;
          case '<=': return l <= r;
          case '>=': return l >= r;
          case '==': return l === r;
          case '!=': return l !== r;
          default: throw new ForgeError(`Unknown operator ${node.op}`);
        }
      }

      case 'Member': {
        const obj = evalExpr(node.object);
        if (obj && typeof obj === 'object' && node.property in obj) return obj[node.property];
        throw new ForgeError(`No property '${node.property}'`);
      }

      case 'Call':
        return evalCall(node);

      default:
        throw new ForgeError(`Cannot evaluate ${node.type}`);
    }
  }

  // Math helpers exposed as calls. Anything not a shape builder lands here.
  const MATH = {
    sin: (d) => Math.sin((d * Math.PI) / 180),
    cos: (d) => Math.cos((d * Math.PI) / 180),
    tan: (d) => Math.tan((d * Math.PI) / 180),
    sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
    round: Math.round, min: Math.min, max: Math.max, pow: Math.pow,
  };

  function evalChildren(block) {
    // Evaluate a block and return the solids it produced (not yet unioned).
    if (!block) return [];
    const produced = [];
    for (const stmt of block.body) {
      const r = evalStatement(stmt);
      if (r && r._isManifold) produced.push(r);
    }
    return produced;
  }

  function unionOf(list) {
    if (list.length === 0) return null;
    if (list.length === 1) return list[0];
    return track(K.union(list));
  }

  function evalCall(node) {
    const a = node.args.map(evalExpr);
    const named = {};
    for (const k in node.named) named[k] = evalExpr(node.named[k]);
    const arg = (i, key, dflt) =>
      named[key] !== undefined ? named[key] : a[i] !== undefined ? a[i] : dflt;

    switch (node.name) {
      // --- math passthrough ---
      case 'sin': case 'cos': case 'tan': case 'sqrt': case 'abs':
      case 'floor': case 'ceil': case 'round': case 'min': case 'max':
      case 'pow':
        return MATH[node.name](...a);

      // --- primitives ---
      case 'cube':
      case 'box': {
        // Accept all documented forms:
        //   box(x, y, z)   three explicit dimensions
        //   box([x, y, z]) a size vector
        //   box(size)      a cube
        const s = arg(0, 'size');
        let x, y, z;
        if (Array.isArray(s)) {
          [x, y, z] = s;
        } else if (a[2] !== undefined || named.x !== undefined || named.y !== undefined || named.z !== undefined) {
          x = arg(0, 'x'); y = arg(1, 'y'); z = arg(2, 'z');
        } else {
          x = y = z = s; // single value -> cube
        }
        const center = named.center !== undefined ? named.center : true;
        return mark(track(K.box(x, y, z, center)));
      }
      case 'sphere':
        return mark(track(K.sphere(arg(0, 'r'), arg(1, 'segments', K.getCurveQuality()))));
      case 'cylinder':
        return mark(track(K.cylinder(
          arg(0, 'h'), arg(1, 'r'), arg(2, 'segments', K.getCurveQuality()), arg(3, 'center', true))));
      case 'cone':
        return mark(track(K.cone(
          arg(0, 'h'), arg(1, 'r1'), arg(2, 'r2'), arg(3, 'segments', K.getCurveQuality()),
          arg(4, 'center', true))));
      case 'pyramid':
        return mark(track(K.pyramid(arg(0, 'h'), arg(1, 'r'), arg(2, 'segments', 4))));
      case 'torus':
        return mark(track(K.torus(arg(0, 'radius'), arg(1, 'tube'), arg(2, 'segments', K.getCurveQuality()))));
      case 'wedge':
        return mark(track(K.wedge(arg(0, 'w'), arg(1, 'd'), arg(2, 'h'))));
      case 'roundedBox':
        return mark(track(K.roundedBox(
          arg(0, 'x'), arg(1, 'y'), arg(2, 'z'), arg(3, 'r'), arg(4, 'segments', 32))));
      case 'tube':
        return mark(track(K.tube(arg(0, 'h'), arg(1, 'router'), arg(2, 'rinner'), arg(3, 'segments', K.getCurveQuality()))));
      case 'prism':
        return mark(track(K.prism(arg(0, 'h'), arg(1, 'r'), arg(2, 'sides', 6))));
      case 'roundedCylinder':
        return mark(track(K.roundedCylinder(arg(0, 'h'), arg(1, 'r'), arg(2, 'fillet', 2))));
      case 'chamferedBox':
        return mark(track(K.chamferedBox(arg(0, 'x'), arg(1, 'y'), arg(2, 'z'), arg(3, 'c', 3))));
      case 'chamferedCylinder':
        return mark(track(K.chamferedCylinder(arg(0, 'h'), arg(1, 'r'), arg(2, 'chamfer', 2))));
      case 'dome':
        return mark(track(K.dome(arg(0, 'r'))));
      case 'slot':
        return mark(track(K.slot(arg(0, 'length'), arg(1, 'r'), arg(2, 'h'))));
      case 'star':
        return mark(track(K.star(arg(0, 'points'), arg(1, 'outer'), arg(2, 'inner'), arg(3, 'h'))));
      case 'text':
        return mark(track(K.text(arg(0, 'str', ''), arg(1, 'size', 12), arg(2, 'height', 4))));
      case 'imported':
        return mark(track(K.imported(arg(0, 'id', ''))));

      // --- fasteners ---
      case 'thread':
        return mark(track(K.thread(
          arg(0, 'length'), arg(1, 'pitch'), arg(2, 'd'), arg(3, 'depth', 0.61 * arg(1, 'pitch')),
          arg(4, 'segments', 96), arg(5, 'handed', 1), arg(6, 'groove', 0.34))));
      case 'bolt':
        return mark(track(K.bolt(
          arg(0, 'd', 16), arg(1, 'pitch', 3), arg(2, 'length', 24),
          arg(3, 'headAF', 24), arg(4, 'headH', 11))));
      case 'nut':
        return mark(track(K.nut(
          arg(0, 'd', 16), arg(1, 'pitch', 3), arg(2, 'thickness', 13),
          arg(3, 'acrossFlats', 24))));

      // --- 2D -> 3D ---
      case 'extrude':
        return mark(track(K.extrude(
          arg(0, 'points'), arg(1, 'height'),
          arg(2, 'twist', 0), arg(3, 'scaleTop', 1), arg(4, 'center', true))));
      case 'revolve':
        return mark(track(K.revolve(
          arg(0, 'points'), arg(1, 'degrees', 360), arg(2, 'segments', K.getCurveQuality()))));

      // --- transforms (consume children) ---
      case 'translate': {
        const v = arg(0, 'v');
        const child = unionOf(evalChildren(node.children));
        return child ? mark(track(child.translate(v))) : null;
      }
      case 'rotate': {
        const v = arg(0, 'v');
        const child = unionOf(evalChildren(node.children));
        return child ? mark(track(child.rotate(Array.isArray(v) ? v : [0, 0, v]))) : null;
      }
      case 'scale': {
        const v = arg(0, 'v');
        const child = unionOf(evalChildren(node.children));
        return child ? mark(track(child.scale(v))) : null;
      }
      case 'mirror': {
        const v = arg(0, 'v');
        const child = unionOf(evalChildren(node.children));
        return child ? mark(track(child.mirror(v))) : null;
      }
      case 'fillet': {
        const r = arg(0, 'r');
        const child = unionOf(evalChildren(node.children));
        return child ? mark(track(K.roundEdges(child, r))) : null;
      }
      case 'chamfer': {
        const r = arg(0, 'r');
        const child = unionOf(evalChildren(node.children));
        return child ? mark(track(K.bevelEdges(child, r))) : null;
      }

      // --- Booleans (consume children) ---
      case 'union':
        return mark(unionOf(evalChildren(node.children)));
      case 'difference': {
        const kids = evalChildren(node.children);
        return kids.length ? mark(track(K.difference(kids))) : null;
      }
      case 'intersection': {
        const kids = evalChildren(node.children);
        return kids.length ? mark(track(K.intersection(kids))) : null;
      }
      case 'hull': {
        const kids = evalChildren(node.children);
        return kids.length ? mark(track(K.hull(kids))) : null;
      }

      default:
        throw new ForgeError(`Unknown function '${node.name}'`);
    }
  }

  // Tag a Manifold so blocks can tell shapes from plain values.
  function mark(m) {
    if (m && typeof m === 'object') m._isManifold = true;
    return m;
  }

  function evalStatement(stmt) {
    switch (stmt.type) {
      case 'Param': {
        const dflt = evalExpr(stmt.value);
        const value = stmt.name in overrides ? overrides[stmt.name] : dflt;
        params.push({ name: stmt.name, default: dflt, value });
        env.set(stmt.name, value);
        return null;
      }
      case 'Assign': {
        env.set(stmt.name, evalExpr(stmt.value));
        return null;
      }
      case 'ExprStmt':
        return evalExpr(stmt.expr);
      case 'Block':
        return unionOf(evalChildren(stmt));
      default:
        throw new ForgeError(`Cannot run ${stmt.type}`);
    }
  }

  // Run the program: top level is an implicit union of everything produced.
  const produced = [];
  for (const stmt of ast.body) {
    const r = evalStatement(stmt);
    if (r && r._isManifold) produced.push(r);
  }
  const result = unionOf(produced);

  // Free every intermediate that isn't the final result.
  for (const m of solids) {
    if (m !== result) { try { m.delete(); } catch { /* already freed */ } }
  }

  return { result, params };
}
