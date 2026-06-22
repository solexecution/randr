import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { setupKernel } from './_kernel.js';
import { box, sphere } from '../../src/kernel/manifold.js';
import { manifoldToGeometry, edgesGeometry } from '../../src/kernel/mesh.js';

// Covers the bridge from the kernel's mesh format into three.js BufferGeometry,
// plus the wireframe edge helper.
describe('manifoldToGeometry', () => {
  beforeAll(async () => {
    await setupKernel();
  }, 60000);

  it('returns a BufferGeometry with position, index, and computed normals', () => {
    const m = box(10, 20, 30, true);
    const mesh = m.getMesh();
    const expectedVerts = mesh.vertProperties.length / mesh.numProp;
    const expectedTris = mesh.triVerts.length / 3;

    const geom = manifoldToGeometry(m);
    expect(geom).toBeInstanceOf(THREE.BufferGeometry);

    // Position attribute: present, xyz (itemSize 3), array length a multiple of 3.
    const pos = geom.getAttribute('position');
    expect(pos).toBeTruthy();
    expect(pos.itemSize).toBe(3);
    expect(pos.array.length % 3).toBe(0);
    expect(pos.count).toBeGreaterThan(0);
    expect(pos.count).toBe(expectedVerts);

    // Index: present and consistent with the manifold's triangle count.
    const index = geom.getIndex();
    expect(index).toBeTruthy();
    expect(index.count).toBe(expectedTris * 3);
    expect(index.count % 3).toBe(0);

    // computeVertexNormals() runs inside the bridge, so normals must exist and
    // match the vertex count.
    const normal = geom.getAttribute('normal');
    expect(normal).toBeTruthy();
    expect(normal.itemSize).toBe(3);
    expect(normal.count).toBe(pos.count);

    m.delete();
  });

  it('works for a curved solid and produces a finite bounding box', () => {
    const m = sphere(8);
    const expectedTris = m.numTri();

    const geom = manifoldToGeometry(m);
    expect(geom.getAttribute('position').count).toBeGreaterThan(0);
    expect(geom.getIndex().count).toBe(expectedTris * 3);

    // The bridge computes bounds; they should be present and finite.
    expect(geom.boundingBox).toBeTruthy();
    expect(Number.isFinite(geom.boundingBox.min.x)).toBe(true);
    expect(Number.isFinite(geom.boundingBox.max.x)).toBe(true);
    expect(geom.boundingSphere).toBeTruthy();
    expect(geom.boundingSphere.radius).toBeGreaterThan(0);

    m.delete();
  });
});

describe('edgesGeometry', () => {
  beforeAll(async () => {
    await setupKernel();
  }, 60000);

  it('returns an EdgesGeometry with a position attribute', () => {
    const m = box(10, 20, 30, true);
    const geom = manifoldToGeometry(m);

    const edges = edgesGeometry(geom);
    expect(edges).toBeInstanceOf(THREE.EdgesGeometry);

    const pos = edges.getAttribute('position');
    expect(pos).toBeTruthy();
    expect(pos.itemSize).toBe(3);
    expect(pos.array.length % 3).toBe(0);
    // A box has hard edges, so the wireframe must contain some segments.
    expect(pos.count).toBeGreaterThan(0);

    m.delete();
  });
});
