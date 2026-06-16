// Manifold kernel wrapper.
// Loads the WASM solid-geometry kernel once and exposes a small, stable surface
// for the rest of the app. Everything that produces geometry goes through here,
// so Booleans stay watertight and exports stay print-safe.

import ManifoldModule from 'manifold-3d';

let _module = null;
let _loading = null;

// Load and initialise the kernel. Safe to call repeatedly; resolves to the
// same instance. We point locateFile at the bundled .wasm so it works offline.
export async function loadKernel() {
  if (_module) return _module;
  if (_loading) return _loading;

  _loading = (async () => {
    const { WASM_BASE64 } = await import('./_wasm-inline.js');
    const bin = Uint8Array.from(atob(WASM_BASE64), (c) => c.charCodeAt(0));
    const wasm = await ManifoldModule({ wasmBinary: bin });
    wasm.setup();
    _module = wasm;
    return wasm;
  })();

  return _loading;
}

export function kernel() {
  if (!_module) throw new Error('Kernel not loaded yet. Call loadKernel() first.');
  return _module;
}

// Test hook: seed an already-initialised module (used by Node smoke tests that
// can't go through the vite ?url wasm import). No effect in the browser path.
export function injectKernel(mod) {
  _module = mod;
}

// --- Primitive constructors -------------------------------------------------
// All dimensions are millimetres. center=true puts the centroid at the origin,
// which is what people expect when they drop a shape into the scene.

export function box(x, y, z, center = true) {
  return kernel().Manifold.cube([x, y, z], center);
}

export function cylinder(height, radius, segments = 64, center = true) {
  return kernel().Manifold.cylinder(height, radius, radius, segments, center);
}

export function cone(height, rLow, rHigh, segments = 64, center = true) {
  return kernel().Manifold.cylinder(height, rLow, rHigh, segments, center);
}

export function sphere(radius, segments = 64) {
  return kernel().Manifold.sphere(radius, segments);
}

// A rounded slab: useful enough to be a primitive. Built as a hull of spheres
// at the eight corners so the radius is a true fillet on every edge.
export function roundedBox(x, y, z, r, segments = 32) {
  const M = kernel().Manifold;
  const hx = x / 2 - r, hy = y / 2 - r, hz = z / 2 - r;
  if (hx <= 0 || hy <= 0 || hz <= 0) return box(x, y, z);
  const corner = M.sphere(r, segments);
  const corners = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        corners.push(corner.translate([sx * hx, sy * hy, sz * hz]));
  const out = M.hull(corners);
  corners.forEach((c) => c.delete());
  corner.delete();
  return out;
}

// --- Boolean operations -----------------------------------------------------
// Each takes an array of Manifolds and returns one. The inputs are NOT deleted
// here; the scene graph owns lifetimes.

export function union(parts) {
  return kernel().Manifold.union(parts);
}
export function difference(parts) {
  return kernel().Manifold.difference(parts);
}
export function intersection(parts) {
  return kernel().Manifold.intersection(parts);
}
export function hull(parts) {
  return kernel().Manifold.hull(parts);
}

// --- 2D -> 3D ---------------------------------------------------------------
// Extrude / revolve a polygon (array of [x,y] points, CCW) into a solid.

export function extrude(points, height, twist = 0, scaleTop = 1, center = true) {
  const cs = kernel().CrossSection([points]);
  const solid = cs.extrude(height, 0, twist, [scaleTop, scaleTop], center);
  cs.delete();
  return solid;
}

export function revolve(points, degrees = 360, segments = 64) {
  const cs = kernel().CrossSection([points]);
  const solid = cs.revolve(segments, degrees);
  cs.delete();
  return solid;
}

// --- Inspection -------------------------------------------------------------
// Cheap, print-relevant facts about a solid.

export function inspect(m) {
  const bb = m.boundingBox();
  return {
    volume: m.volume(),               // mm^3
    surfaceArea: m.surfaceArea(),     // mm^2
    genus: m.genus(),                 // topological holes; 0 for a simple part
    triangles: m.numTri(),
    bbox: {
      min: bb.min,
      max: bb.max,
      size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]],
    },
  };
}
