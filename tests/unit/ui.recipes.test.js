import { describe, it, expect, beforeAll } from 'vitest';
import { setupKernel } from './_kernel.js';
import { RECIPES } from '../../src/ui/recipes.js';
import { compile } from '../../src/lang/compile.js';
import { inspect } from '../../src/kernel/manifold.js';

// recipes.js is pure (knob descriptors + a build(vals) -> source function per
// recipe). The structural checks need no kernel; the single volume check does,
// so the kernel is bootstrapped once for that case.

describe('RECIPES — catalogue shape', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(RECIPES)).toBe(true);
    expect(RECIPES.length).toBeGreaterThan(0);
  });

  it('every recipe has unique ids', () => {
    const ids = RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(RECIPES.map((r) => [r.id, r]))('recipe %s has the required fields', (_id, r) => {
    // identity / presentation
    expect(typeof r.id).toBe('string');
    expect(r.id.length).toBeGreaterThan(0);
    expect(typeof r.name).toBe('string');
    expect(r.name.length).toBeGreaterThan(0);
    expect(typeof r.icon).toBe('string');
    expect(typeof r.blurb).toBe('string');

    // knobs: an array of choice/value descriptors
    expect(Array.isArray(r.knobs)).toBe(true);
    for (const k of r.knobs) {
      expect(typeof k.key).toBe('string');
      expect(typeof k.label).toBe('string');
      expect(typeof k.type).toBe('string');
      expect(k).toHaveProperty('default');
      if (k.type === 'choice') {
        expect(Array.isArray(k.options)).toBe(true);
        expect(k.options.length).toBeGreaterThan(0);
        // the default must be one of the offered options
        expect(k.options).toContain(k.default);
      }
    }

    // the builder turns knob values into source
    expect(typeof r.build).toBe('function');
  });

  it('each build() returns a non-empty mini-language source string', () => {
    for (const r of RECIPES) {
      // call with no args (defaults), and with each knob at its default
      const vals = {};
      for (const k of r.knobs) vals[k.key] = k.default;
      const a = r.build();
      const b = r.build(vals);
      for (const src of [a, b]) {
        expect(typeof src).toBe('string');
        expect(src.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('a choice knob produces source for every option (flexi-dino sizes)', () => {
    const dino = RECIPES.find((r) => r.id === 'flexi-dino');
    expect(dino).toBeTruthy();
    const sizeKnob = dino.knobs.find((k) => k.key === 'size');
    expect(sizeKnob).toBeTruthy();
    for (const size of sizeKnob.options) {
      const src = dino.build({ size });
      expect(typeof src).toBe('string');
      expect(src).toContain('union()');
    }
  });
});

describe('RECIPES — compiles to a solid', () => {
  beforeAll(async () => {
    await setupKernel();
  }, 60000);

  it('the first recipe compiles to positive volume', () => {
    const r = RECIPES[0];
    const source = r.build();
    const { result, error } = compile(source);
    expect(error).toBeNull();
    expect(result).toBeTruthy();
    const info = inspect(result);
    expect(info.volume).toBeGreaterThan(0);
    expect(info.triangles).toBeGreaterThan(0);
    result.delete();
  });
});
