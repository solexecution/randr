import { describe, it, expect, beforeAll } from 'vitest';
import { setupKernel } from './_kernel.js';
import { compile } from '../../src/lang/compile.js';
import { inspect } from '../../src/kernel/manifold.js';

// Coverage of the full source -> manifold pipeline (tokenize -> parse ->
// evaluate). compile() never throws: it returns { result, params, error }.
// On success error is null and result is a Manifold; on failure result is null
// and error is a non-null message string. Results are freed with .delete().
describe('lang compile pipeline', () => {
  beforeAll(async () => {
    await setupKernel();
  }, 60000);

  it('compiles a box program to the expected solid', () => {
    const out = compile('box(10,20,30);');
    expect(out.error).toBeNull();
    expect(out.result).not.toBeNull();
    expect(Array.isArray(out.params)).toBe(true);
    const info = inspect(out.result);
    expect(info.volume).toBeCloseTo(6000, 0);
    expect(info.bbox.size[0]).toBeCloseTo(10, 0);
    expect(info.bbox.size[1]).toBeCloseTo(20, 0);
    expect(info.bbox.size[2]).toBeCloseTo(30, 0);
    out.result.delete();
  });

  it('compiles a difference program with reduced volume', () => {
    const src = `
      difference() {
        box(20, 20, 10);
        cylinder(20, 4);
      }
    `;
    const out = compile(src);
    expect(out.error).toBeNull();
    expect(out.result).not.toBeNull();
    const info = inspect(out.result);
    // A 20x20x10 slab is 4000 mm^3; drilling a hole must reduce that.
    expect(info.volume).toBeGreaterThan(0);
    expect(info.volume).toBeLessThan(4000);
    out.result.delete();
  });

  it('surfaces a param with its default, and overrides change the result', () => {
    const src = `
      param size = 10;
      box(size, size, size);
    `;
    const base = compile(src);
    expect(base.error).toBeNull();
    const sizeParam = base.params.find((p) => p.name === 'size');
    expect(sizeParam).toBeDefined();
    expect(sizeParam.default).toBe(10);
    expect(sizeParam.value).toBe(10);
    const baseVolume = inspect(base.result).volume;
    expect(baseVolume).toBeCloseTo(1000, 0); // 10^3
    base.result.delete();

    const overridden = compile(src, { size: 20 });
    expect(overridden.error).toBeNull();
    const overParam = overridden.params.find((p) => p.name === 'size');
    expect(overParam.default).toBe(10); // declared default unchanged
    expect(overParam.value).toBe(20); // override applied
    const overVolume = inspect(overridden.result).volume;
    expect(overVolume).toBeCloseTo(8000, 0); // 20^3
    expect(overVolume).toBeGreaterThan(baseVolume);
    overridden.result.delete();
  });

  it('returns an error (does not throw) on a syntax error', () => {
    let out;
    expect(() => {
      out = compile('box(10,,);');
    }).not.toThrow();
    expect(out.result).toBeNull();
    expect(out.error).not.toBeNull();
    expect(typeof out.error).toBe('string');
    expect(out.error.length).toBeGreaterThan(0);
    expect(Array.isArray(out.params)).toBe(true);
  });
});
