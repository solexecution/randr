import { describe, it, expect } from 'vitest';
import { createNode, buildTreeToSource } from '../../src/ui/buildtree.js';

// Characterization snapshot: locks the *emitted source*, default fields, and
// on-plate base height for every primitive. Captured against the pre-registry
// code, so the primitive-registry refactor must reproduce it byte-for-byte —
// this is the safety net that proves toSource() didn't drift.
//
// (toManifold parity — that the edit-view mesh path calls the same kernel fn
// with the same args — is exercised live by the e2e suite + manual checks; it
// can't run here because the WASM kernel isn't loaded in jsdom.)

const KINDS = [
  'box', 'cylinder', 'sphere', 'cone', 'pyramid', 'torus', 'wedge', 'dome',
  'slot', 'star', 'roundedBox', 'roundedCylinder', 'chamferedBox',
  'chamferedCylinder', 'tube', 'prism', 'gear', 'counterbore', 'countersink',
  'insertHole', 'nutTrap', 'keyhole', 'text', 'imported', 'extrusion',
  'revolution', 'thread', 'bolt', 'nut',
];

describe('primitive catalog (characterization)', () => {
  for (const kind of KINDS) {
    it(`${kind} → stable source, fields, and base height`, () => {
      const node = createNode(kind);
      expect({
        source: buildTreeToSource({ nodes: [node] }),
        fields: node.fields.map(({ key, value, type }) => ({ key, value, type })),
        baseZ: node.pos[2],
      }).toMatchSnapshot();
    });
  }

  it('createNode rejects an unknown kind', () => {
    expect(createNode('nope')).toBe(null);
  });
});
