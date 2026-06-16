// Bridge between the kernel's mesh format and three.js.
// Manifold gives us a flat vertProperties array (xyz + extras) and a triVerts
// index array. three.js wants a BufferGeometry. We also compute flat normals
// here so faceted parts read correctly without smoothing across hard edges.

import * as THREE from 'three';

export function manifoldToGeometry(manifold) {
  const mesh = manifold.getMesh();
  const { numProp, vertProperties, triVerts } = mesh;

  const geom = new THREE.BufferGeometry();

  // Pull just the xyz out of each vertex (props 0..2). vertProperties is
  // interleaved with numProp stride.
  const vertCount = vertProperties.length / numProp;
  const positions = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    positions[i * 3] = vertProperties[i * numProp];
    positions[i * 3 + 1] = vertProperties[i * numProp + 1];
    positions[i * 3 + 2] = vertProperties[i * numProp + 2];
  }

  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(triVerts), 1));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

// Wireframe helper for showing edges over the shaded mesh.
export function edgesGeometry(geom, threshold = 25) {
  return new THREE.EdgesGeometry(geom, threshold);
}
