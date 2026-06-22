import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shapeArt } from '../../src/ui/shapeart.js';

// shapeArt is a pure SVG-string generator (no kernel). Rather than hard-code the
// ~38 art keys, read them straight out of the source so the suite tracks the ART
// map as it grows — every real key must produce a usable inline <svg>.
const src = readFileSync(fileURLToPath(new URL('../../src/ui/shapeart.js', import.meta.url)), 'utf8');

// Pull the `const ART = { ... };` block, then grab each top-level `key:` name.
function artKeys() {
  const open = src.indexOf('const ART = {');
  expect(open).toBeGreaterThan(-1);
  const body = src.slice(open + 'const ART = {'.length);
  const keys = [];
  const re = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
  let m;
  while ((m = re.exec(body))) keys.push(m[1]);
  return keys;
}

const KEYS = artKeys();

const isValidSvg = (s) => {
  expect(typeof s).toBe('string');
  expect(s.startsWith('<svg')).toBe(true);
  expect(s.endsWith('</svg>')).toBe(true);
  expect(s.length).toBeGreaterThan(50);
};

describe('shapeArt — ART map coverage', () => {
  it('found a non-trivial key list in the source', () => {
    // Sanity-check the scraper itself: the gallery has well over a dozen arts.
    expect(KEYS.length).toBeGreaterThan(30);
    expect(KEYS).toContain('box');
    expect(KEYS).toContain('cylinder');
    // keys are unique
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  it.each(KEYS)('shapeArt(%s) returns a valid, non-trivial inline svg', (key) => {
    isValidSvg(shapeArt(key));
  });
});

describe('shapeArt — fallback', () => {
  it('falls back to the box art for an unknown key (no throw, valid svg)', () => {
    let out;
    expect(() => { out = shapeArt('totally-unknown-key'); }).not.toThrow();
    isValidSvg(out);
    // The fallback IS the box art, so it must match the box rendering exactly.
    expect(out).toBe(shapeArt('box'));
  });

  it('handles undefined/empty keys by falling back rather than throwing', () => {
    expect(() => shapeArt(undefined)).not.toThrow();
    expect(shapeArt(undefined)).toBe(shapeArt('box'));
    expect(shapeArt('')).toBe(shapeArt('box'));
  });
});
