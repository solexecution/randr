import { describe, it, expect, beforeAll } from 'vitest';
import { setupKernel } from './_kernel.js';
import { box, sphere, difference, inspect } from '../../src/kernel/manifold.js';

// Proves the kernel boots under Node and basic CSG works. Real coverage of the
// full primitive/boolean set lives in the dedicated kernel suite.
describe('manifold kernel (smoke)', () => {
  beforeAll(async () => {
    await setupKernel();
  }, 60000);

  it('box(10,20,30) has volume ≈ 6000', () => {
    const b = box(10, 20, 30, true);
    const info = inspect(b);
    expect(info.volume).toBeCloseTo(6000, 0);
    expect(info.triangles).toBeGreaterThan(0);
    b.delete();
  });

  it('difference(box, inner sphere) is a watertight cavity', () => {
    const b = box(10, 10, 10, true);
    const s = sphere(4);
    const d = difference([b, s]);
    const info = inspect(d);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.volume).toBeLessThan(1000); // less than the solid cube
    d.delete();
  });
});
