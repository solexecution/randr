import { describe, it, expect } from 'vitest';
import { compile } from '../../src/lang/compile.js';
import { loadKernel, inspect } from '../../src/kernel/manifold.js';
import { TEMPLATES } from '../../src/ui/templates.js';

const HINGED_BOX = TEMPLATES['hinged box'];

describe('Hinged rounded box (68×48×5)', () => {
  it('compiles to a watertight solid', async () => {
    await loadKernel();
    const { error, result } = compile(HINGED_BOX);
    expect(error).toBeNull();
    expect(result).not.toBeNull();
    const info = inspect(result);
    expect(info.volume).toBeGreaterThan(0);
    result?.delete();
  });
});