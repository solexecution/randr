// Manifold kernel wrapper.
// Loads the WASM solid-geometry kernel once and exposes a small, stable surface
// for the rest of the app. Everything that produces geometry goes through here,
// so Booleans stay watertight and exports stay print-safe.

import ManifoldModule from 'manifold-3d';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import fontJson from './font-helvetiker.json';

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

// Square pyramid: a 4-sided cone tapering to a point.
export function pyramid(height, radius, segments = 4, center = true) {
  return kernel().Manifold.cylinder(height, radius, 0, segments, center);
}

// Torus, built by revolving a circular tube. revolve() already yields a flat
// ring (hole along Z), which sits correctly on the plate.
export function torus(radius, tube, segments = 64, tubeSeg = 28) {
  const pts = [];
  for (let i = 0; i < tubeSeg; i++) {
    const a = (i / tubeSeg) * Math.PI * 2;
    pts.push([radius + tube * Math.cos(a), tube * Math.sin(a)]);
  }
  const cs = kernel().CrossSection([pts]);
  const ring = cs.revolve(segments, 360);
  cs.delete();
  return ring;
}

// Right-triangular prism (a ramp). Extrude a triangle and stand it up so the
// slope runs along the depth and the flat base sits on the plate.
export function wedge(w, d, h) {
  const cs = kernel().CrossSection([[[-w / 2, 0], [w / 2, 0], [-w / 2, h]]]);
  const prism = cs.extrude(d, 0, 0, [1, 1], true);
  cs.delete();
  const r = prism.rotate(90, 0, 0);
  prism.delete();
  return r;
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

// Hollow cylinder (pipe / ring / washer / spacer), centred on the origin.
export function tube(height, rOuter, rInner, segments = 64) {
  const M = kernel().Manifold;
  const ri = Math.max(0.1, Math.min(rInner, rOuter - 0.1));
  const outer = M.cylinder(height, rOuter, rOuter, segments, true);
  const inner = M.cylinder(height + 0.2, ri, ri, segments, true);
  const out = M.difference([outer, inner]);
  outer.delete();
  inner.delete();
  return out;
}

// Regular n-sided prism (polygon extruded), centred on the origin.
export function prism(height, radius, sides = 6) {
  return kernel().Manifold.cylinder(height, radius, radius, Math.max(3, Math.round(sides)), true);
}

// --- Text -------------------------------------------------------------------
// Parse the bundled typeface once (sync) so text() can run in the eval path.
let _font = null;
export function loadFont() {
  if (!_font) _font = new FontLoader().parse(fontJson);
  return _font;
}

// Extruded 3D text, lying flat (base on the plate), centred in X/Y. Glyph
// outlines come from the three.js font; the holes (letter counters) are cut by
// the even-odd fill rule. `size` is the cap height in mm, `height` the depth.
export function text(str, size = 12, height = 4, curveSegments = 6) {
  const font = loadFont();
  const shapes = font.generateShapes(String(str == null ? '' : str), size);
  const contours = [];
  for (const shape of shapes) {
    const outer = shape.getPoints(curveSegments).map((p) => [p.x, p.y]);
    if (outer.length >= 3) contours.push(outer);
    for (const hole of (shape.holes || [])) {
      const h = hole.getPoints(curveSegments).map((p) => [p.x, p.y]);
      if (h.length >= 3) contours.push(h);
    }
  }
  if (!contours.length) return kernel().Manifold.cube([size * 0.4, size * 0.7, height], true);
  const cs = kernel().CrossSection(contours, 'EvenOdd');
  const solid = cs.extrude(height, 0, 0, [1, 1], false);
  cs.delete();
  const bb = solid.boundingBox();
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  const out = solid.translate([-cx, -cy, 0]); // centre in X/Y, base stays on z=0
  solid.delete();
  return out;
}

// --- Fasteners --------------------------------------------------------------
// Coarse, FDM-printable threads. A real helical thread is made by twist-
// extruding a 2D cross-section (a core circle with one triangular tooth): as
// the section sweeps up it also rotates, so the tooth traces a single-start
// helix. The same profile drives the bolt (positive) and the nut's cutter
// (slightly oversized), so they always mate.

// Regular hexagonal prism, base on the plate (z in [0, h]).
// `acrossFlats` is the wrench size (distance between opposite faces).
export function hexPrism(acrossFlats, h) {
  const R = acrossFlats / Math.sqrt(3); // circumradius for a hex: AF = R*sqrt(3)
  return kernel().Manifold.cylinder(h, R, R, 6, false);
}

// One external thread, axis = Z, base on the plate (z in [0, length]).
// dMajor = outside (crest) diameter, depth = radial thread height (crest - root).
// handed: +1 right-hand, -1 left-hand. `groove` is the V-groove's angular
// fraction of the pitch (the rest is the crest land).
//
// Method: a full crest-radius cylinder with a single triangular notch cut
// inward to the root, twist-extruded so the notch traces a helical V-groove.
// Because every contour point is at radius >= rMin, the rod always has a solid
// core (no matter how wide the groove), unlike an outward-tooth profile.
export function thread(length, pitch, dMajor, depth, segments = 64, handed = 1, groove = 0.34) {
  const M = kernel();
  const rMaj = dMajor / 2;
  const rMin = Math.max(0.3, rMaj - depth);
  const turns = length / pitch;
  const twist = -handed * 360 * turns;
  // Groove half-width (radians). Its Z-height at the crest is (2*th)/omega with
  // omega = 360/pitch deg per mm, i.e. groove*pitch = th_deg*pitch/180.
  const th = Math.min(Math.PI * 0.7, groove * Math.PI);

  // CCW contour: crest circle (radius rMaj) over most of the turn, then a
  // V-notch dipping inward to rMin across the +X sector.
  const pts = [];
  const arc = 2 * Math.PI - 2 * th;
  for (let i = 0; i <= segments; i++) {
    const ang = th + (i / segments) * arc; // +th .. 2PI-th, CCW, at crest radius
    pts.push([rMaj * Math.cos(ang), rMaj * Math.sin(ang)]);
  }
  pts.push([rMin, 0]); // inward groove apex, bridges the gap across +X

  const cs = M.CrossSection([pts]);
  const nDiv = Math.max(12, Math.ceil(turns * 24)); // slices: smooth the twist
  const solid = cs.extrude(length, nDiv, twist, [1, 1], false);
  cs.delete();
  return solid;
}

// A hex-head bolt sitting on the plate: hex head (z in [0, headH]) then a
// threaded shank above it. dMajor/pitch/length describe the thread.
export function bolt(dMajor, pitch, length, headAF, headH) {
  const M = kernel();
  const depth = 0.61 * pitch; // ~ ISO thread height
  const head = hexPrism(headAF, headH);
  const th = thread(length, pitch, dMajor, depth);
  const shank = th.translate([0, 0, headH]);
  th.delete();
  const out = M.Manifold.union([head, shank]);
  head.delete();
  shank.delete();
  return out;
}

// A hex nut sitting on the plate with a mating threaded through-hole. The
// cutter is the same thread profile, oversized by `clearance` (diametral), so
// the printed nut runs onto a matching bolt().
export function nut(dMajor, pitch, thickness, acrossFlats, clearance = 0.4) {
  const M = kernel();
  const depth = 0.61 * pitch;
  const body = hexPrism(acrossFlats, thickness);
  // Cutter runs past both faces so the hole is open end to end.
  const cutter = thread(thickness + 2, pitch, dMajor + clearance, depth).translate([0, 0, -1]);
  const out = M.Manifold.difference([body, cutter]);
  body.delete();
  cutter.delete();
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
