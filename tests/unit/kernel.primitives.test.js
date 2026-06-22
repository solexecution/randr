import { describe, it, expect, beforeAll } from 'vitest';
import { setupKernel } from './_kernel.js';
import {
  box,
  cylinder,
  cone,
  pyramid,
  prism,
  sphere,
  dome,
  torus,
  slot,
  star,
  gear,
  tube,
  roundedBox,
  roundedCylinder,
  chamferedBox,
  chamferedCylinder,
  counterbore,
  countersink,
  insertHole,
  nutTrap,
  keyhole,
  extrude,
  revolve,
  inspect,
} from '../../src/kernel/manifold.js';

// Coverage of the primitive constructors. For exact polyhedra we assert exact
// volume; for curved shapes we use toBeCloseTo against the analytic value with a
// tolerance that absorbs the faceting of a finite segment count. Every test also
// checks the bounding-box dimensions land in the expected ballpark, and that the
// solid is non-empty. Manifolds are freed with .delete() to release WASM memory.
describe('kernel primitives', () => {
  beforeAll(async () => {
    await setupKernel();
  }, 60000);

  it('box has exact volume and bbox', () => {
    const m = box(10, 20, 30);
    const info = inspect(m);
    expect(info.volume).toBeCloseTo(6000, 5);
    expect(info.bbox.size[0]).toBeCloseTo(10, 5);
    expect(info.bbox.size[1]).toBeCloseTo(20, 5);
    expect(info.bbox.size[2]).toBeCloseTo(30, 5);
    expect(info.triangles).toBeGreaterThan(0);
    m.delete();
  });

  it('cylinder volume ≈ π r² h', () => {
    const r = 5;
    const h = 20;
    const m = cylinder(h, r);
    const info = inspect(m);
    expect(info.volume).toBeCloseTo(Math.PI * r * r * h, -1);
    expect(info.bbox.size[0]).toBeCloseTo(2 * r, 0);
    expect(info.bbox.size[1]).toBeCloseTo(2 * r, 0);
    expect(info.bbox.size[2]).toBeCloseTo(h, 5);
    m.delete();
  });

  it('sphere volume ≈ 4/3 π r³', () => {
    const r = 8;
    const m = sphere(r);
    const info = inspect(m);
    expect(info.volume).toBeCloseTo((4 / 3) * Math.PI * r * r * r, -2);
    expect(info.bbox.size[0]).toBeCloseTo(2 * r, 0);
    expect(info.bbox.size[1]).toBeCloseTo(2 * r, 0);
    expect(info.bbox.size[2]).toBeCloseTo(2 * r, 0);
    m.delete();
  });

  it('cone volume ≈ ⅓ π h (r1² + r1·r2 + r2²)', () => {
    const h = 18;
    const r1 = 6;
    const r2 = 2;
    const m = cone(h, r1, r2);
    const info = inspect(m);
    const expected = (Math.PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
    expect(info.volume).toBeCloseTo(expected, -1);
    expect(info.bbox.size[0]).toBeCloseTo(2 * r1, 0);
    expect(info.bbox.size[2]).toBeCloseTo(h, 5);
    m.delete();
  });

  it('pyramid (square cone to a point) has positive volume and square base', () => {
    const h = 12;
    const r = 6;
    const m = pyramid(h, r);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    // 4-gon to apex: base footprint spans roughly the radius, height exact.
    expect(info.bbox.size[0]).toBeGreaterThan(r);
    expect(info.bbox.size[0]).toBeLessThanOrEqual(2 * r + 0.01);
    expect(info.bbox.size[2]).toBeCloseTo(h, 5);
    m.delete();
  });

  it('prism (hex) has positive volume in the expected ballpark', () => {
    const h = 10;
    const r = 6;
    const m = prism(h, r, 6);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    // A regular hexagon of circumradius r has area (3√3/2) r².
    expect(info.volume).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * r * r * h, -1);
    expect(info.bbox.size[0]).toBeCloseTo(2 * r, 0);
    expect(info.bbox.size[2]).toBeCloseTo(h, 5);
    m.delete();
  });

  it('gear has positive volume and pitch-ballpark footprint', () => {
    const teeth = 16;
    const mod = 2;
    const height = 6;
    const m = gear(teeth, mod, height);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    const outerD = mod * teeth + 2 * mod; // pitch dia + 2 addendum
    expect(info.bbox.size[0]).toBeCloseTo(outerD, 0);
    expect(info.bbox.size[1]).toBeCloseTo(outerD, 0);
    expect(info.bbox.size[2]).toBeCloseTo(height, 5);
    m.delete();
  });

  it('torus has positive volume ≈ 2π² R r²', () => {
    const R = 12;
    const r = 3;
    const m = torus(R, r);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.volume).toBeCloseTo(2 * Math.PI * Math.PI * R * r * r, -2);
    expect(info.bbox.size[0]).toBeCloseTo(2 * (R + r), 0);
    expect(info.bbox.size[2]).toBeCloseTo(2 * r, 0);
    m.delete();
  });

  it('dome (hemisphere) has positive volume ≈ ½ sphere', () => {
    const r = 8;
    const m = dome(r);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.volume).toBeCloseTo((2 / 3) * Math.PI * r * r * r, -2);
    expect(info.bbox.size[0]).toBeCloseTo(2 * r, 0);
    expect(info.bbox.size[2]).toBeCloseTo(r, 0);
    m.delete();
  });

  it('slot (stadium prism) has positive volume and rounded-end footprint', () => {
    const length = 20;
    const radius = 4;
    const height = 6;
    const m = slot(length, radius, height);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.bbox.size[0]).toBeCloseTo(length, 0);
    expect(info.bbox.size[1]).toBeCloseTo(2 * radius, 0);
    expect(info.bbox.size[2]).toBeCloseTo(height, 5);
    m.delete();
  });

  it('star prism has positive volume bounded by its outer radius', () => {
    const points = 5;
    const outer = 10;
    const inner = 4;
    const height = 5;
    const m = star(points, outer, inner, height);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    // A 5-point star has no tip on the X axis, so its footprint is bounded by
    // the outer diameter without exactly equalling it on every axis. Assert the
    // footprint fits inside the outer circle yet is driven by the outer radius.
    expect(info.bbox.size[0]).toBeLessThanOrEqual(2 * outer + 0.01);
    expect(info.bbox.size[0]).toBeGreaterThan(2 * inner);
    expect(info.bbox.size[1]).toBeLessThanOrEqual(2 * outer + 0.01);
    expect(info.bbox.size[1]).toBeGreaterThan(outer); // a tip reaches up the +Y axis
    expect(info.bbox.size[2]).toBeCloseTo(height, 5);
    m.delete();
  });

  it('tube (hollow) has volume well below its bbox volume', () => {
    const height = 12;
    const rOuter = 8;
    const rInner = 5;
    const m = tube(height, rOuter, rInner);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    // Analytic wall volume: π (rO² - rI²) h.
    expect(info.volume).toBeCloseTo(Math.PI * (rOuter * rOuter - rInner * rInner) * height, -1);
    const bboxVolume = info.bbox.size[0] * info.bbox.size[1] * info.bbox.size[2];
    expect(info.volume).toBeLessThan(bboxVolume);
    // Hollow ring is a single through-hole: genus 1.
    expect(info.genus).toBe(1);
    expect(info.bbox.size[0]).toBeCloseTo(2 * rOuter, 0);
    expect(info.bbox.size[2]).toBeCloseTo(height, 5);
    m.delete();
  });

  it('roundedBox has positive volume below the equivalent sharp box', () => {
    const x = 20;
    const y = 30;
    const z = 10;
    const r = 3;
    const m = roundedBox(x, y, z, r);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.volume).toBeLessThan(x * y * z); // corners shaved off
    expect(info.bbox.size[0]).toBeCloseTo(x, 0);
    expect(info.bbox.size[1]).toBeCloseTo(y, 0);
    expect(info.bbox.size[2]).toBeCloseTo(z, 0);
    m.delete();
  });

  it('roundedCylinder has positive volume below a sharp cylinder', () => {
    const height = 16;
    const radius = 6;
    const fillet = 2;
    const m = roundedCylinder(height, radius, fillet);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.volume).toBeLessThan(Math.PI * radius * radius * height);
    expect(info.bbox.size[0]).toBeCloseTo(2 * radius, 0);
    expect(info.bbox.size[2]).toBeCloseTo(height, 0);
    m.delete();
  });

  it('chamferedBox has positive volume below the equivalent sharp box', () => {
    const x = 20;
    const y = 20;
    const z = 12;
    const c = 3;
    const m = chamferedBox(x, y, z, c);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.volume).toBeLessThan(x * y * z);
    expect(info.bbox.size[0]).toBeCloseTo(x, 0);
    expect(info.bbox.size[1]).toBeCloseTo(y, 0);
    expect(info.bbox.size[2]).toBeCloseTo(z, 0);
    m.delete();
  });

  it('chamferedCylinder has positive volume below a sharp cylinder', () => {
    const height = 16;
    const radius = 6;
    const chamfer = 2;
    const m = chamferedCylinder(height, radius, chamfer);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.volume).toBeLessThan(Math.PI * radius * radius * height);
    expect(info.bbox.size[0]).toBeCloseTo(2 * radius, 0);
    expect(info.bbox.size[2]).toBeCloseTo(height, 0);
    m.delete();
  });

  // --- fasteners: each must at least produce a valid, non-empty manifold ----

  it('counterbore returns a valid manifold', () => {
    const m = counterbore();
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.triangles).toBeGreaterThan(0);
    expect(info.bbox.size[2]).toBeGreaterThan(0);
    m.delete();
  });

  it('countersink returns a valid manifold', () => {
    const m = countersink();
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.triangles).toBeGreaterThan(0);
    expect(info.bbox.size[2]).toBeGreaterThan(0);
    m.delete();
  });

  it('insertHole returns a valid manifold', () => {
    const m = insertHole();
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.triangles).toBeGreaterThan(0);
    expect(info.bbox.size[2]).toBeGreaterThan(0);
    m.delete();
  });

  it('nutTrap returns a valid manifold', () => {
    const m = nutTrap();
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.triangles).toBeGreaterThan(0);
    expect(info.bbox.size[2]).toBeGreaterThan(0);
    m.delete();
  });

  it('keyhole returns a valid manifold', () => {
    const m = keyhole();
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.triangles).toBeGreaterThan(0);
    expect(info.bbox.size[2]).toBeGreaterThan(0);
    m.delete();
  });

  // --- 2D -> 3D --------------------------------------------------------------

  it('extrude of a square gives volume = area × height', () => {
    const side = 10;
    const h = 7;
    const square = [
      [-side / 2, -side / 2],
      [side / 2, -side / 2],
      [side / 2, side / 2],
      [-side / 2, side / 2],
    ];
    const m = extrude(square, h);
    const info = inspect(m);
    expect(info.volume).toBeCloseTo(side * side * h, 3);
    expect(info.bbox.size[0]).toBeCloseTo(side, 5);
    expect(info.bbox.size[1]).toBeCloseTo(side, 5);
    expect(info.bbox.size[2]).toBeCloseTo(h, 5);
    m.delete();
  });

  it('revolve of a profile produces a positive-volume solid', () => {
    // A rectangle offset from the axis revolves into a tube/washer-like ring.
    const profile = [
      [4, 0],
      [8, 0],
      [8, 6],
      [4, 6],
    ];
    const m = revolve(profile, 360);
    const info = inspect(m);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.bbox.size[0]).toBeCloseTo(16, 0); // outer diameter 2 × 8
    expect(info.bbox.size[2]).toBeCloseTo(6, 0);
    m.delete();
  });
});
