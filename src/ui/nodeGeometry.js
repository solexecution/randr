// The build-mode edit-view mesh: one primitive node → three.js geometry, built
// with the SAME kernel call (and args) the source path emits (see primitives.js),
// so the fast preview can't drift from the compiled result. Pulled out of app.js
// to keep the kernel-primitive surface in one focused place.
import { box, cylinder, sphere, cone, pyramid, torus, wedge, dome, slot, star, roundedBox, roundedCylinder, chamferedBox, chamferedCylinder, tube, prism, gear, counterbore, countersink, insertHole, nutTrap, keyhole, text, thread, bolt, nut, extrude, revolve, imported } from '../kernel/manifold.js';
import { manifoldToGeometry } from '../kernel/mesh.js';
import { compile } from '../lang/compile.js';
import { effField, shapeCall } from './buildtree.js';
import { PRIMITIVES } from './primitives.js';

// Kernel constructor per primitive kind, keyed by the registry's call name
// (kind === fn for these). The point/mesh-driven kinds — imported, extrusion,
// revolution, thread (extra crest arg) — are handled explicitly below.
const KERNEL = {
  box, cylinder, sphere, cone, pyramid, torus, wedge, dome, slot, star,
  roundedBox, roundedCylinder, chamferedBox, chamferedCylinder, tube, prism, gear,
  counterbore, countersink, insertHole, nutTrap, keyhole, text, bolt, nut,
};

// Generic kinds call KERNEL[kind] with the registry's args — the SAME args the
// source path emits — so the fast mesh path can't drift from the compiled
// result. Frees the manifold once meshed; returns null on any failure.
export function nodeToGeometry(node) {
  const f = (k) => effField(node, k);
  const prim = PRIMITIVES[node.kind];
  if (!prim) return null;
  let m;
  try {
    if (node.hollow > 0 || node.fillet > 0) {
      // Hollow shells + fillet/chamfer are source-level wrappers (shapeCall) the
      // fast kernel path can't express; compile that node's source so the edit
      // mesh matches the compiled result. Plain parts keep the fast direct path.
      const src = shapeCall(node);
      m = src ? compile(src, {}).result : null;
      if (!m) return null;
    } else {
      switch (node.kind) {
        case 'imported':   m = imported(node.meshId || ''); break;
        case 'extrusion':  { const pts = node.points || []; if (pts.length < 3) return null; m = extrude(pts, f('height')); break; }
        case 'revolution': { const pts = node.points || []; if (pts.length < 3) return null; m = revolve(pts, f('degrees')); break; }
        case 'thread':     m = thread(f('length'), f('pitch'), f('d'), 0.61 * f('pitch')); break;
        default:           m = KERNEL[node.kind](...prim.args.map(f)); break;
      }
    }
    const g = manifoldToGeometry(m);
    m.delete();
    return g;
  } catch (e) {
    if (m) try { m.delete(); } catch { /* freed */ }
    return null;
  }
}
