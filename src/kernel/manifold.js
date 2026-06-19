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

// Global curve quality — the default segment count for round primitives
// (cylinder/sphere/cone/torus/…). Higher = smoother but heavier. The UI
// "smoothness" control sets this; primitives read it through their default
// argument, so a change applies on the next recompile. `thread` keeps a fixed
// count (its twist-extrude gets expensive fast).
let CURVE_SEGMENTS = 64;
export function setCurveQuality(n) { CURVE_SEGMENTS = Math.max(8, Math.min(256, Math.round(n) || 64)); }
export function getCurveQuality() { return CURVE_SEGMENTS; }

// --- Primitive constructors -------------------------------------------------
// All dimensions are millimetres. center=true puts the centroid at the origin,
// which is what people expect when they drop a shape into the scene.

export function box(x, y, z, center = true) {
  return kernel().Manifold.cube([x, y, z], center);
}

export function cylinder(height, radius, segments = CURVE_SEGMENTS, center = true) {
  return kernel().Manifold.cylinder(height, radius, radius, segments, center);
}

export function cone(height, rLow, rHigh, segments = CURVE_SEGMENTS, center = true) {
  return kernel().Manifold.cylinder(height, rLow, rHigh, segments, center);
}

// Square pyramid: a 4-sided cone tapering to a point.
export function pyramid(height, radius, segments = 4, center = true) {
  return kernel().Manifold.cylinder(height, radius, 0, segments, center);
}

// Torus, built by revolving a circular tube. revolve() already yields a flat
// ring (hole along Z), which sits correctly on the plate.
export function torus(radius, tube, segments = CURVE_SEGMENTS, tubeSeg = 28) {
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

export function sphere(radius, segments = CURVE_SEGMENTS) {
  return kernel().Manifold.sphere(radius, segments);
}

// Dome / hemisphere: the top half of a sphere, flat base on the plate.
export function dome(radius, segments = CURVE_SEGMENTS) {
  const M = kernel().Manifold;
  const s = M.sphere(radius, segments);
  const cap = M.cube([radius * 2 + 2, radius * 2 + 2, radius], true).translate([0, 0, radius / 2]);
  const out = M.intersection([s, cap]);
  s.delete();
  cap.delete();
  return out;
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

// A unit octahedron scaled to `c` (verts on the axes), used as the chamfer
// building block — its flat faces become 45 degree bevels when hulled.
function octahedron(c) {
  return meshSolid(
    [c, 0, 0, -c, 0, 0, 0, c, 0, 0, -c, 0, 0, 0, c, 0, 0, -c],
    [4, 0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 5, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3],
  );
}

// Round every convex edge of an existing solid by radius `r`, keeping the
// overall size — a morphological OPENING (erode then dilate) with a sphere.
// This is the general fillet that works on any geometry, not just primitives.
export function roundEdges(m, r, seg = 14) {
  if (!(r > 0)) return m;
  const ball = kernel().Manifold.sphere(r, seg);
  const eroded = m.minkowskiDifference(ball);
  const out = eroded.minkowskiSum(ball);
  eroded.delete();
  ball.delete();
  return out;
}

// Chamfer: same opening but with an octahedron, so edges get 45 degree bevels.
export function bevelEdges(m, r) {
  if (!(r > 0)) return m;
  const oct = octahedron(r);
  const eroded = m.minkowskiDifference(oct);
  const out = eroded.minkowskiSum(oct);
  eroded.delete();
  oct.delete();
  return out;
}

// Cut the solid in half along its longer horizontal axis and repack the two
// halves side by side (separated by `gap`) along the perpendicular axis — so an
// over-long model fits the plate and prints as two glue-able pieces. Z (height)
// is untouched, so both halves stay base-on-plate.
export function bisect(m, gap = 4) {
  const bb = m.boundingBox();
  const sx = bb.max[0] - bb.min[0], sy = bb.max[1] - bb.min[1];
  const axis = sx >= sy ? 0 : 1;          // cut along the longer footprint axis
  const perp = axis === 0 ? 1 : 0;
  const center = (bb.min[axis] + bb.max[axis]) / 2;
  const L = bb.max[axis] - bb.min[axis], W = bb.max[perp] - bb.min[perp];
  const normal = axis === 0 ? [1, 0, 0] : [0, 1, 0];
  const halves = m.splitByPlane(normal, center);          // [ +side, -side ]
  const tPos = [0, 0, 0], tNeg = [0, 0, 0];
  tPos[axis] = -(center + L / 4); tPos[perp] = W / 2 + gap / 2;   // recentre + spread
  tNeg[axis] = -(center - L / 4); tNeg[perp] = -(W / 2 + gap / 2);
  const a = halves[0].translate(tPos), b = halves[1].translate(tNeg);
  const out = a.add(b);
  halves[0].delete(); halves[1].delete(); a.delete(); b.delete();
  return out;
}

// Chamfered box: like roundedBox but hulling 8 octahedra, so every edge gets a
// flat 45 degree bevel of size `c` instead of a round fillet.
export function chamferedBox(x, y, z, c) {
  const M = kernel().Manifold;
  const hx = x / 2 - c, hy = y / 2 - c, hz = z / 2 - c;
  if (hx <= 0 || hy <= 0 || hz <= 0) return box(x, y, z);
  const corner = octahedron(c);
  const corners = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        corners.push(corner.translate([sx * hx, sy * hy, sz * hz]));
  const out = M.hull(corners);
  corners.forEach((cc) => cc.delete());
  corner.delete();
  return out;
}

// Hollow cylinder (pipe / ring / washer / spacer), centred on the origin.
export function tube(height, rOuter, rInner, segments = CURVE_SEGMENTS) {
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

// Spur gear: trapezoidal teeth (thinned for backlash, so printed gears mesh and
// stay separate) extruded to `height`, with an optional centre bore. `module`
// sets tooth size (pitch diameter = module x teeth). Centred on the origin.
export function gear(teeth, module = 2, height = 6, bore = 0) {
  const N = Math.max(4, Math.round(teeth)), m = Math.max(0.2, module);
  const rp = (m * N) / 2, ro = rp + m, rr = Math.max(0.4, rp - 1.25 * m), pa = (2 * Math.PI) / N;
  const pts = [];
  const at = (rad, ang) => pts.push([rad * Math.cos(ang), rad * Math.sin(ang)]);
  for (let i = 0; i < N; i++) {
    const c = i * pa;
    at(rr, c - 0.30 * pa); at(ro, c - 0.12 * pa); at(ro, c + 0.12 * pa); at(rr, c + 0.30 * pa);
  }
  const g = extrude(pts, height);
  if (!(bore > 0)) return g;
  const hole = kernel().Manifold.cylinder(height + 2, bore / 2, bore / 2, CURVE_SEGMENTS, true);
  const out = g.subtract(hole);
  g.delete(); hole.delete();
  return out;
}

// Stadium / slot prism: a rounded-end bar (hull of two cylinders). `length` is
// the overall length, `radius` the end radius (half-width). Centred.
export function slot(length, radius, height, segments = 48) {
  const M = kernel().Manifold;
  const r = Math.max(0.5, Math.min(radius, length / 2 - 0.1));
  const d = Math.max(0, length / 2 - r);
  const a = M.cylinder(height, r, r, segments, true).translate([-d, 0, 0]);
  const b = M.cylinder(height, r, r, segments, true).translate([d, 0, 0]);
  const out = M.hull([a, b]);
  a.delete();
  b.delete();
  return out;
}

// Star prism: an n-pointed star (alternating outer/inner radius) extruded. Centred.
export function star(points, outer, inner, height) {
  const n = Math.max(3, Math.round(points));
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = (i % 2 === 0) ? outer : Math.max(0.5, Math.min(inner, outer - 0.1));
    const a = (i / (n * 2)) * Math.PI * 2 + Math.PI / 2;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const cs = kernel().CrossSection([pts]);
  const out = cs.extrude(height, 0, 0, [1, 1], true);
  cs.delete();
  return out;
}

// Cylinder with filleted top + bottom rim, standing on the plate. Built by
// revolving a rounded-corner profile (reliable — no general edge fillet needed).
export function roundedCylinder(height, radius, fillet, segments = CURVE_SEGMENTS, arcSeg = 8) {
  const f = Math.max(0.1, Math.min(fillet, Math.min(radius - 0.1, height / 2 - 0.1)));
  const pts = [[0, 0], [radius - f, 0]];
  for (let i = 1; i <= arcSeg; i++) { const a = -Math.PI / 2 + (i / arcSeg) * (Math.PI / 2); pts.push([(radius - f) + f * Math.cos(a), f + f * Math.sin(a)]); }
  for (let i = 0; i <= arcSeg; i++) { const a = (i / arcSeg) * (Math.PI / 2); pts.push([(radius - f) + f * Math.cos(a), (height - f) + f * Math.sin(a)]); }
  pts.push([0, height]);
  const cs = kernel().CrossSection([pts]);
  const out = cs.revolve(segments, 360); // revolve yields a Z-axis solid, base on z=0
  cs.delete();
  return out;
}

// Cylinder with a 45 degree chamfer on the top + bottom rim (revolve, base on plate).
export function chamferedCylinder(height, radius, chamfer, segments = CURVE_SEGMENTS) {
  const c = Math.max(0.1, Math.min(chamfer, Math.min(radius - 0.1, height / 2 - 0.1)));
  const pts = [[0, 0], [radius - c, 0], [radius, c], [radius, height - c], [radius - c, height], [0, height]];
  const cs = kernel().CrossSection([pts]);
  const out = cs.revolve(segments, 360);
  cs.delete();
  return out;
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

// --- Imported meshes --------------------------------------------------------
// Build a Manifold from a vertex-welded triangle mesh. `positions` is a flat
// xyz array (deduplicated verts), `triangles` flat vertex indices.
export function meshSolid(positions, triangles) {
  const M = kernel();
  const mesh = new M.Mesh({
    numProp: 3,
    vertProperties: positions instanceof Float32Array ? positions : Float32Array.from(positions),
    triVerts: triangles instanceof Uint32Array ? triangles : Uint32Array.from(triangles),
  });
  return new M.Manifold(mesh);
}

// Parse an STL (binary or ASCII) into a flat list of triangle vertices.
function parseSTL(buffer) {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // ASCII starts with "solid" AND has no plausible binary tri-count match.
  const header = String.fromCharCode(...bytes.slice(0, 5)).toLowerCase();
  const looksAscii = header === 'solid' && buffer.byteLength > 84 &&
    (84 + dv.getUint32(80, true) * 50) !== buffer.byteLength;
  const tris = [];
  if (looksAscii) {
    const text = new TextDecoder().decode(buffer);
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m;
    while ((m = re.exec(text))) tris.push(+m[1], +m[2], +m[3]);
  } else {
    const n = dv.getUint32(80, true);
    let o = 84;
    for (let i = 0; i < n; i++) {
      o += 12; // skip the face normal
      for (let v = 0; v < 3; v++) { tris.push(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)); o += 12; }
      o += 2; // attribute byte count
    }
  }
  return tris; // flat [x,y,z, x,y,z, ...], 9 per triangle
}

// Import an STL buffer as a watertight solid: weld coincident vertices (raw STL
// is an unshared triangle soup), build the Manifold, then centre it on X/Y with
// its base on the plate.
export function importSTL(buffer) {
  const flat = parseSTL(buffer);
  const map = new Map();
  const verts = [];
  const idx = [];
  const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
  const add = (x, y, z) => {
    const k = key(x, y, z);
    let i = map.get(k);
    if (i === undefined) { i = verts.length / 3; verts.push(x, y, z); map.set(k, i); }
    return i;
  };
  for (let i = 0; i < flat.length; i += 9) {
    idx.push(add(flat[i], flat[i + 1], flat[i + 2]), add(flat[i + 3], flat[i + 4], flat[i + 5]), add(flat[i + 6], flat[i + 7], flat[i + 8]));
  }
  const man = meshSolid(verts, idx);
  const bb = man.boundingBox();
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  const out = man.translate([-cx, -cy, -bb.min[2]]); // centre XY, base on z=0
  man.delete();
  return out;
}

// Import a Wavefront OBJ as a watertight solid: read v/f, fan-triangulate any
// polygons, weld coincident vertices, build the Manifold, centre XY + base on
// the plate. Texture/normal indices (f a/b/c) and 1-based / negative indices are
// handled; everything else (vt, vn, groups, materials) is ignored.
export function importOBJ(text) {
  const raw = [];   // raw OBJ vertex coords
  const faces = []; // triangles as [i,j,k] 0-based into raw
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('v ')) {
      const p = t.slice(2).trim().split(/\s+/);
      raw.push(+p[0], +p[1], +p[2]);
    } else if (t.startsWith('f ')) {
      const toks = t.slice(2).trim().split(/\s+/);
      const vi = toks.map((tok) => {
        let i = parseInt(tok.split('/')[0], 10);
        if (i < 0) i = raw.length / 3 + i; else i -= 1; // -> 0-based
        return i;
      });
      for (let k = 1; k < vi.length - 1; k++) faces.push([vi[0], vi[k], vi[k + 1]]); // fan
    }
  }
  const nRaw = raw.length / 3;
  const map = new Map();
  const verts = [];
  const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
  const remap = (oi) => {
    const x = raw[oi * 3], y = raw[oi * 3 + 1], z = raw[oi * 3 + 2];
    const k = key(x, y, z);
    let i = map.get(k);
    if (i === undefined) { i = verts.length / 3; verts.push(x, y, z); map.set(k, i); }
    return i;
  };
  const idx = [];
  for (const f of faces) {
    if (f.some((i) => i < 0 || i >= nRaw || Number.isNaN(i))) continue;
    idx.push(remap(f[0]), remap(f[1]), remap(f[2]));
  }
  const man = meshSolid(verts, idx);
  const bb = man.boundingBox();
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  const out = man.translate([-cx, -cy, -bb.min[2]]);
  man.delete();
  return out;
}

// Import a 3MF (a zip of model XML). Finds the 3D model part, inflates it if
// DEFLATE-compressed (via DecompressionStream), parses every <mesh> (offsetting
// indices) into one welded solid, and centres it on the plate. Build-item
// transforms aren't applied (parts use mesh-local coords) — fine for the common
// single-object case. Async (inflate is stream-based).
export async function import3MF(buffer) {
  const dv = new DataView(buffer), bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0 && i > buffer.byteLength - 22 - 65557; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip / 3MF');
  const cdCount = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true), found = null;
  for (let i = 0; i < cdCount && !found; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (/\.model$/i.test(name)) {
      const ds = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
      found = { method, data: bytes.subarray(ds, ds + compSize) };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!found) throw new Error('no 3D model in 3MF');
  let xmlBytes = found.data;
  if (found.method === 8) {
    const s = new Blob([found.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    xmlBytes = new Uint8Array(await new Response(s).arrayBuffer());
  } else if (found.method !== 0) {
    throw new Error('unsupported 3MF compression');
  }
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), 'application/xml');
  const verts = [], idx = [];
  for (const mesh of doc.getElementsByTagNameNS('*', 'mesh')) {
    const base = verts.length / 3;
    for (const v of mesh.getElementsByTagNameNS('*', 'vertex')) verts.push(+v.getAttribute('x'), +v.getAttribute('y'), +v.getAttribute('z'));
    for (const t of mesh.getElementsByTagNameNS('*', 'triangle')) idx.push(base + +t.getAttribute('v1'), base + +t.getAttribute('v2'), base + +t.getAttribute('v3'));
  }
  if (!idx.length) throw new Error('empty 3MF mesh');
  const man = meshSolid(verts, idx);
  const bb = man.boundingBox();
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  const out = man.translate([-cx, -cy, -bb.min[2]]);
  man.delete();
  return out;
}

// Session registry of imported solids, keyed by id. The build tree / language
// reference them by id (imported("...")), so a mesh round-trips through
// code<->build within a session without embedding its geometry in the source.
const _solidReg = new Map();
export function registerSolid(id, manifold) {
  const prev = _solidReg.get(id);
  if (prev && prev !== manifold) { try { prev.delete(); } catch { /* freed */ } }
  _solidReg.set(id, manifold);
  return id;
}
export function imported(id) {
  const m = _solidReg.get(id);
  if (!m) return kernel().Manifold.cube([10, 10, 10], true); // placeholder if the id is gone
  return m.translate([0, 0, 0]); // a fresh copy — the evaluator frees what it builds
}

// Read a registered solid's welded mesh as plain arrays, for saving a project.
export function solidMesh(id) {
  const m = _solidReg.get(id);
  if (!m) return null;
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties;
  const p = [];
  for (let i = 0; i < vp.length / np; i++) p.push(vp[i * np], vp[i * np + 1], vp[i * np + 2]);
  return { p, t: Array.from(mesh.triVerts) };
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

export function revolve(points, degrees = 360, segments = CURVE_SEGMENTS) {
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
