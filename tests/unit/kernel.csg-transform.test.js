import { describe, it, expect, beforeAll } from 'vitest';
import { setupKernel } from './_kernel.js';
import {
  box,
  cylinder,
  sphere,
  union,
  difference,
  intersection,
  hull,
  inspect,
} from '../../src/kernel/manifold.js';

// Coverage of the Boolean operators and the Manifold transform methods. We lean
// on volume / bbox / genus relations that hold regardless of faceting, so the
// assertions stay robust to segment counts. Manifolds are freed with .delete().
describe('kernel CSG + transforms', () => {
  beforeAll(async () => {
    await setupKernel();
  }, 60000);

  // --- Booleans --------------------------------------------------------------

  it('union of two overlapping boxes: volume < sum, > each', () => {
    const a = box(10, 10, 10); // 1000, centred at origin
    const b = box(10, 10, 10).translate([5, 0, 0]); // overlaps half
    const u = union([a, b]);
    const va = inspect(a).volume;
    const vb = inspect(b).volume;
    const vu = inspect(u).volume;
    expect(vu).toBeGreaterThan(va);
    expect(vu).toBeGreaterThan(vb);
    expect(vu).toBeLessThan(va + vb); // the overlap is not double-counted
    expect(vu).toBeCloseTo(1500, 0); // 1000 + half of 1000
    a.delete();
    b.delete();
    u.delete();
  });

  it('difference (A minus B) reduces volume', () => {
    const a = box(10, 10, 10); // 1000
    const b = box(6, 6, 6); // sits inside a, centred
    const d = difference([a, b]);
    const va = inspect(a).volume;
    const vd = inspect(d).volume;
    expect(vd).toBeGreaterThan(0);
    expect(vd).toBeLessThan(va);
    a.delete();
    b.delete();
    d.delete();
  });

  it('difference with an interior through-hole raises genus', () => {
    const a = box(20, 20, 10); // solid slab, genus 0
    // A cylinder taller than the slab, drilled straight through it.
    const drill = cylinder(20, 4);
    const d = difference([a, drill]);
    const before = inspect(a);
    const after = inspect(d);
    expect(before.genus).toBe(0);
    expect(after.genus).toBe(1); // one tunnel through the part
    expect(after.volume).toBeLessThan(before.volume);
    a.delete();
    drill.delete();
    d.delete();
  });

  it('intersection ≈ the overlap region of two boxes', () => {
    const a = box(10, 10, 10); // spans x in [-5, 5]
    const b = box(10, 10, 10).translate([6, 0, 0]); // spans x in [1, 11]
    const x = intersection([a, b]);
    const info = inspect(x);
    // Overlap is x in [1, 5] -> 4 × 10 × 10 = 400.
    expect(info.volume).toBeCloseTo(400, 0);
    expect(info.bbox.size[0]).toBeCloseTo(4, 0);
    expect(info.bbox.size[1]).toBeCloseTo(10, 0);
    expect(info.bbox.size[2]).toBeCloseTo(10, 0);
    a.delete();
    b.delete();
    x.delete();
  });

  it('hull of two separated spheres exceeds the sum of their volumes', () => {
    const r = 5;
    const s1 = sphere(r);
    const s2 = sphere(r).translate([20, 0, 0]);
    const h = hull([s1, s2]);
    const v1 = inspect(s1).volume;
    const v2 = inspect(s2).volume;
    const vh = inspect(h).volume;
    // The convex hull fills the capsule-shaped gap between them.
    expect(vh).toBeGreaterThan(v1 + v2);
    expect(inspect(h).bbox.size[0]).toBeCloseTo(20 + 2 * r, 0);
    s1.delete();
    s2.delete();
    h.delete();
  });

  // --- Transforms ------------------------------------------------------------

  it('translate moves the bbox by the vector, volume unchanged', () => {
    const a = box(10, 20, 30);
    const before = inspect(a);
    const t = a.translate([5, -10, 15]);
    const after = inspect(t);
    expect(after.volume).toBeCloseTo(before.volume, 5);
    for (let i = 0; i < 3; i++) {
      const delta = [5, -10, 15][i];
      expect(after.bbox.min[i]).toBeCloseTo(before.bbox.min[i] + delta, 4);
      expect(after.bbox.max[i]).toBeCloseTo(before.bbox.max[i] + delta, 4);
    }
    a.delete();
    t.delete();
  });

  it('rotate 90° about Z swaps the X and Y extents', () => {
    const a = box(10, 20, 30);
    const before = inspect(a);
    const r = a.rotate([0, 0, 90]);
    const after = inspect(r);
    expect(after.volume).toBeCloseTo(before.volume, 4);
    expect(after.bbox.size[0]).toBeCloseTo(before.bbox.size[1], 3); // x <- old y
    expect(after.bbox.size[1]).toBeCloseTo(before.bbox.size[0], 3); // y <- old x
    expect(after.bbox.size[2]).toBeCloseTo(before.bbox.size[2], 3); // z unchanged
    a.delete();
    r.delete();
  });

  it('scale([2,1,1]) doubles the volume and the X extent', () => {
    const a = box(10, 10, 10);
    const before = inspect(a);
    const s = a.scale([2, 1, 1]);
    const after = inspect(s);
    expect(after.volume).toBeCloseTo(before.volume * 2, 3);
    expect(after.bbox.size[0]).toBeCloseTo(before.bbox.size[0] * 2, 4);
    expect(after.bbox.size[1]).toBeCloseTo(before.bbox.size[1], 4);
    expect(after.bbox.size[2]).toBeCloseTo(before.bbox.size[2], 4);
    a.delete();
    s.delete();
  });

  it('mirror preserves volume and reflects position across the plane', () => {
    const a = box(10, 10, 10).translate([12, 0, 0]); // wholly in +x
    const before = inspect(a);
    const m = a.mirror([1, 0, 0]); // reflect across the YZ plane
    const after = inspect(m);
    expect(after.volume).toBeCloseTo(before.volume, 4);
    // What was in +x is now in -x.
    expect(after.bbox.max[0]).toBeCloseTo(-before.bbox.min[0], 3);
    expect(after.bbox.min[0]).toBeCloseTo(-before.bbox.max[0], 3);
    a.delete();
    m.delete();
  });
});
