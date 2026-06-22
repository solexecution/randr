import { describe, it, expect, beforeAll } from 'vitest';
import { setupKernel } from './_kernel.js';
import { box, sphere } from '../../src/kernel/manifold.js';
import {
  exportSTL,
  exportOBJ,
  export3MF,
  export3MFColored,
} from '../../src/kernel/export.js';

// Exercises the exporters against real manifolds produced by the WASM kernel.
// Each exporter returns a Blob; we inspect the raw bytes/text and the MIME type.
// triggerDownload is intentionally NOT tested here — it needs a real DOM with a
// clickable <a> anchor and URL.createObjectURL, which the Node test env lacks.
describe('kernel exporters', () => {
  beforeAll(async () => {
    await setupKernel();
  }, 60000);

  describe('exportSTL', () => {
    it('writes a binary STL whose triangle count and byte length match the mesh', async () => {
      const m = box(10, 20, 30, true);
      const triCount = m.numTri();

      const blob = exportSTL(m);
      expect(blob.type).toBe('model/stl');

      const buf = await blob.arrayBuffer();
      const dv = new DataView(buf);
      const headerTriCount = dv.getUint32(80, true);

      // Header count must equal the manifold's triangle count...
      expect(headerTriCount).toBe(triCount);
      // ...and the buffer must be exactly 80-byte header + uint32 count + 50/tri.
      expect(buf.byteLength).toBe(84 + 50 * headerTriCount);

      m.delete();
    });

    it('produces the same triangle count for a curved solid (sphere)', async () => {
      const m = sphere(8);
      const triCount = m.numTri();
      expect(triCount).toBeGreaterThan(0);

      const blob = exportSTL(m);
      const buf = await blob.arrayBuffer();
      const dv = new DataView(buf);

      expect(dv.getUint32(80, true)).toBe(triCount);
      expect(buf.byteLength).toBe(84 + 50 * triCount);

      m.delete();
    });
  });

  describe('exportOBJ', () => {
    it('writes an OBJ with a header, an object line, and matching v/f counts', async () => {
      const m = box(10, 20, 30, true);
      const mesh = m.getMesh();
      const vertCount = mesh.vertProperties.length / mesh.numProp;
      const triCount = mesh.triVerts.length / 3;

      const blob = exportOBJ(m);
      expect(blob.type).toBe('model/obj');

      const txt = await blob.text();
      const lines = txt.split('\n');

      // Header comment + object declaration.
      expect(lines[0]).toBe('# Forge CAD export');
      expect(lines.some((l) => l.startsWith('o '))).toBe(true);

      const vLines = lines.filter((l) => l.startsWith('v '));
      const fLines = lines.filter((l) => l.startsWith('f '));
      expect(vLines.length).toBe(vertCount);
      expect(fLines.length).toBe(triCount);

      m.delete();
    });

    it('emits 1-indexed face indices within the vertex range', async () => {
      const m = box(4, 4, 4, true);
      const mesh = m.getMesh();
      const vertCount = mesh.vertProperties.length / mesh.numProp;

      const txt = await exportOBJ(m).text();
      const fLines = txt.split('\n').filter((l) => l.startsWith('f '));
      expect(fLines.length).toBeGreaterThan(0);

      for (const f of fLines) {
        const idx = f
          .slice(2)
          .trim()
          .split(/\s+/)
          .map((tok) => parseInt(tok.split('/')[0], 10));
        expect(idx.length).toBe(3);
        for (const i of idx) {
          // 1-indexed: lowest valid index is 1, highest is vertCount.
          expect(i).toBeGreaterThanOrEqual(1);
          expect(i).toBeLessThanOrEqual(vertCount);
        }
      }

      m.delete();
    });
  });

  describe('export3MF', () => {
    it('returns a non-empty zip (PK magic) with the 3MF mime', async () => {
      const m = box(10, 20, 30, true);

      const blob = export3MF(m);
      expect(blob.type).toBe('model/3mf');

      const buf = await blob.arrayBuffer();
      expect(buf.byteLength).toBeGreaterThan(0);

      const bytes = new Uint8Array(buf);
      // Local file header / zip magic: 'P' 'K' 0x03 0x04.
      expect(bytes[0]).toBe(0x50); // 'P'
      expect(bytes[1]).toBe(0x4b); // 'K'

      m.delete();
    });
  });

  describe('export3MFColored', () => {
    it('packs two coloured parts into a valid PK-prefixed zip', async () => {
      const a = box(10, 10, 10, true);
      const b = sphere(6);

      const blob = export3MFColored([
        { manifold: a, color: 0xff0000 },
        { manifold: b, color: 0x00ff00 },
      ]);
      expect(blob.type).toBe('model/3mf');

      const buf = await blob.arrayBuffer();
      expect(buf.byteLength).toBeGreaterThan(0);

      const bytes = new Uint8Array(buf);
      expect(bytes[0]).toBe(0x50); // 'P'
      expect(bytes[1]).toBe(0x4b); // 'K'

      a.delete();
      b.delete();
    });
  });
});
