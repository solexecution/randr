import { describe, it, expect } from 'vitest';
import {
  createNode,
  setNodeKind,
  buildTreeToSource,
  buildColoredParts,
  BuildTree,
  bakeNodeScale,
  resetScaleOnSizeEdit,
  isSizeField,
} from '../../src/ui/buildtree.js';

// buildtree is the build-pane data model: it builds plain node objects and emits
// mini-language source. It does NOT touch the kernel, so these stay pure.

describe('createNode', () => {
  it('builds a box node with the documented fields', () => {
    const n = createNode('box');
    expect(n).toBeTruthy();
    expect(n.kind).toBe('box');
    expect(n.op).toBe('solid');
    // transforms are length-3 arrays
    expect(Array.isArray(n.pos)).toBe(true);
    expect(n.pos).toHaveLength(3);
    expect(n.rot).toEqual([0, 0, 0]);
    expect(n.scale).toEqual([1, 1, 1]);
    // a colour is assigned from the palette
    expect(typeof n.color).toBe('number');
    // fields is a non-empty array of {key,label,value,type}
    expect(Array.isArray(n.fields)).toBe(true);
    expect(n.fields.length).toBeGreaterThan(0);
    for (const f of n.fields) {
      expect(f).toHaveProperty('key');
      expect(f).toHaveProperty('label');
      expect(f).toHaveProperty('value');
      expect(f).toHaveProperty('type');
    }
    // box defaults: x/y/z = 20, and it sits base-on-plate (z = z/2 = 10)
    expect(n.fields.map((f) => f.key)).toEqual(['x', 'y', 'z']);
    expect(n.pos[2]).toBe(10);
  });

  it('seats several kinds on the plate with the right half-height', () => {
    // cylinder: pos.z = h/2 = 10
    const cyl = createNode('cylinder');
    expect(cyl.kind).toBe('cylinder');
    expect(cyl.fields.map((f) => f.key)).toEqual(['h', 'r']);
    expect(cyl.pos[2]).toBe(10);

    // sphere: pos.z = r = 12
    const sph = createNode('sphere');
    expect(sph.fields.map((f) => f.key)).toEqual(['r']);
    expect(sph.pos[2]).toBe(12);

    // dome builds flat on the plate: pos.z = 0
    const dome = createNode('dome');
    expect(dome.pos[2]).toBe(0);

    // every primitive carries the common solid defaults
    for (const k of ['box', 'cylinder', 'sphere', 'cone', 'gear']) {
      const node = createNode(k);
      expect(node.op).toBe('solid');
      expect(node.locked).toBe(false);
      expect(node.hidden).toBe(false);
      expect(node.group).toBeNull();
      expect(node.groupMode).toBe('union');
    }
  });

  it('returns null for an unknown kind', () => {
    expect(createNode('not-a-real-shape')).toBeNull();
  });

  it('string-typed fields keep their declared type (text.str)', () => {
    const t = createNode('text');
    const strField = t.fields.find((f) => f.key === 'str');
    expect(strField.type).toBe('text');
    expect(strField.value).toBe('Text');
  });
});

describe('size fields vs resize scale', () => {
  it('bakeNodeScale folds positive scale into chamferedBox W/D/H', () => {
    const n = createNode('chamferedBox');
    n.scale = [2, 2, 1];
    expect(bakeNodeScale(n)).toBe(true);
    expect(n.scale).toEqual([1, 1, 1]);
    expect(n.fields.find((f) => f.key === 'x').value).toBe(48);
    expect(n.fields.find((f) => f.key === 'y').value).toBe(48);
    expect(n.fields.find((f) => f.key === 'z').value).toBe(24);
    expect(n.fields.find((f) => f.key === 'c').value).toBe(4);
  });

  it('bakeNodeScale skips mirrored (negative) scale', () => {
    const n = createNode('box');
    n.scale = [-1, 1, 1];
    expect(bakeNodeScale(n)).toBe(false);
    expect(n.scale).toEqual([-1, 1, 1]);
  });

  it('resetScaleOnSizeEdit clears resize but keeps mirror sign', () => {
    const n = createNode('box');
    n.scale = [2.5, 1, 1];
    expect(resetScaleOnSizeEdit(n)).toBe(true);
    expect(n.scale).toEqual([1, 1, 1]);
    n.scale = [-2, 1, 1];
    resetScaleOnSizeEdit(n);
    expect(n.scale).toEqual([-1, 1, 1]);
  });

  it('isSizeField treats chamfer c as edge-only, not overall size', () => {
    expect(isSizeField('chamferedBox', 'x')).toBe(true);
    expect(isSizeField('chamferedBox', 'c')).toBe(false);
  });
});

describe('setNodeKind', () => {
  it('switches kind in place, re-seats fields and base height', () => {
    const n = createNode('box');
    const beforeColor = n.color;
    setNodeKind(n, 'cylinder');
    expect(n.kind).toBe('cylinder');
    // fields are reset to the new shape's defaults
    expect(n.fields.map((f) => f.key)).toEqual(['h', 'r']);
    // re-seated on the plate: h/2 = 10
    expect(n.pos[2]).toBe(10);
    // colour is preserved (only dimensions/position change)
    expect(n.color).toBe(beforeColor);
  });

  it('re-seats z to 0 for a flat-base shape (dome)', () => {
    const n = createNode('box');
    setNodeKind(n, 'dome');
    expect(n.kind).toBe('dome');
    expect(n.pos[2]).toBe(0);
  });

  it('is a no-op for an unknown kind', () => {
    const n = createNode('box');
    const before = JSON.parse(JSON.stringify(n));
    setNodeKind(n, 'nope');
    expect(n.kind).toBe(before.kind);
    expect(n.fields).toEqual(before.fields);
  });
});

describe('BuildTree.add', () => {
  it('appends created nodes to the tree', () => {
    const tree = new BuildTree();
    expect(tree.nodes).toEqual([]);
    const a = tree.add('box');
    const b = tree.add('cylinder');
    expect(tree.nodes).toEqual([a, b]);
    // an unknown kind adds nothing
    expect(tree.add('bogus')).toBeNull();
    expect(tree.nodes).toHaveLength(2);
  });
});

describe('buildTreeToSource', () => {
  it('emits a union containing a box() call for a single solid box', () => {
    const tree = { nodes: [createNode('box')] };
    const src = buildTreeToSource(tree);
    expect(typeof src).toBe('string');
    expect(src).toContain('box');
    expect(src).toContain('box(20, 20, 20)');
    expect(src).toContain('union()');
    // a lone solid that sits at z != 0 is wrapped in a translate
    expect(src).toContain('translate(');
  });

  it('emits a difference() when a hole op is present', () => {
    const solid = createNode('box');
    const hole = createNode('cylinder');
    hole.op = 'hole';
    const tree = { nodes: [solid, hole] };
    const src = buildTreeToSource(tree);
    // solid kept inside the union, hole subtracted via difference
    expect(src).toContain('difference()');
    expect(src).toContain('union()');
    expect(src).toContain('box(20, 20, 20)');
    expect(src).toContain('cylinder(20, 10)');
    // the difference block opens before the union (subtraction wraps the solids)
    expect(src.indexOf('difference()')).toBeLessThan(src.indexOf('union()'));
  });

  it('returns an empty string when there are no solids', () => {
    expect(buildTreeToSource({ nodes: [] })).toBe('');
    const onlyHole = createNode('box');
    onlyHole.op = 'hole';
    // a hole with nothing to cut yields no geometry
    expect(buildTreeToSource({ nodes: [onlyHole] })).toBe('');
  });

  it('skips hidden nodes', () => {
    const a = createNode('box');
    const b = createNode('sphere');
    b.hidden = true;
    const src = buildTreeToSource({ nodes: [a, b] });
    expect(src).toContain('box(');
    expect(src).not.toContain('sphere(');
  });
});

describe('buildColoredParts', () => {
  it('returns one {source,color} entry per top-level solid', () => {
    const a = createNode('box');
    const b = createNode('cylinder');
    const parts = buildColoredParts({ nodes: [a, b] });
    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(p).toHaveProperty('source');
      expect(p).toHaveProperty('color');
      expect(typeof p.source).toBe('string');
      expect(p.source.length).toBeGreaterThan(0);
      expect(typeof p.color).toBe('number');
    }
    expect(parts[0].color).toBe(a.color);
    expect(parts[1].color).toBe(b.color);
    expect(parts[0].pickIndex).toBe(0);
    expect(parts[1].pickIndex).toBe(1);
    expect(parts[0].source).toContain('box(');
    expect(parts[1].source).toContain('cylinder(');
  });

  it('folds top-level holes into every part as a difference()', () => {
    const a = createNode('box');
    const hole = createNode('cylinder');
    hole.op = 'hole';
    const parts = buildColoredParts({ nodes: [a, hole] });
    // the hole is not its own part — only the one solid is
    expect(parts).toHaveLength(1);
    expect(parts[0].color).toBe(a.color);
    expect(parts[0].source).toContain('difference()');
    expect(parts[0].source).toContain('box(');
    expect(parts[0].source).toContain('cylinder(');
  });

  it('returns an empty array for a tree with no solids', () => {
    expect(buildColoredParts({ nodes: [] })).toEqual([]);
  });
});
