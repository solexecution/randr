// Simple-mode "makes": each recipe turns a few kid-friendly knobs into RandR
// mini-language source, compiled by the SAME kernel as code/build mode. So a kid
// picks a thing + size and gets a correct, print-ready result — no parts, no
// booleans, no coordinates. The "it just fits / it moves" magic is coupled
// dimensions + baked-in print clearances (here: the ball-joint gap).

const r2 = (n) => Math.round(n * 100) / 100;

// One gear's outline (CCW) as [x,y] points: N trapezoidal teeth around a pitch
// circle. Centre at (cxOff, 0). Standard module geometry so two gears with the
// same module and centre distance = m*(N1+N2)/2 actually mesh.
function gearPolygon(N, m, cxOff = 0) {
  const rp = (m * N) / 2;       // pitch radius
  const ro = rp + m;            // tip (addendum)
  const rr = rp - 1.25 * m;     // root (dedendum)
  const pa = (2 * Math.PI) / N; // angle per tooth
  const pts = [];
  const at = (rad, ang) => pts.push([cxOff + rad * Math.cos(ang), rad * Math.sin(ang)]);
  for (let i = 0; i < N; i++) {
    const c = i * pa;
    // teeth thinner than the gaps -> backlash, so meshed gears stay separate
    at(rr, c - 0.30 * pa); // root, entering the tooth
    at(ro, c - 0.12 * pa); // tip start
    at(ro, c + 0.12 * pa); // tip end
    at(rr, c + 0.30 * pa); // root, leaving the tooth
  }
  return pts;
}

// A snap-together gear toy: a thin base bar with two SPLIT, BARBED hubs (a slot
// down each lets the halves flex; the wider barbed top means a wheel clicks on
// and won't come off but still spins). The two wheels are separate parts, laid
// out beside the bar to print, then pressed onto the hubs (where they mesh).
// Every sub-expression ends with `;` — the parser otherwise adopts a following
// call as a child and silently drops booleans.
export function flexiDino({ size = 'medium' } = {}) {
  const s = size === 'small' ? 0.7 : size === 'large' ? 1.4 : 1;
  const m = 2.4 * s, N1 = 16, N2 = 10;
  const baseT = 2 * s, barW = 4.5 * s, wheelT = 4 * s;
  const D = (m * (N1 + N2)) / 2 + 0.4 * s;          // hub spacing = mesh distance
  const ro1 = (m * N1) / 2 + m, ro2 = (m * N2) / 2 + m;
  const rShaft = 2.6 * s, rHole = rShaft + 0.35 * s; // wheel spins on the shaft
  const rLip = rHole + 0.9 * s, rTip = rHole - 0.5 * s; // barb wider than the hole = retention
  const shaftTop = baseT + wheelT + 0.4 * s, barbTop = shaftTop + 2.6 * s;
  const slotW = 1.1 * s;

  const g1 = gearPolygon(N1, m, 0);
  const ph = Math.PI / N2;
  const g2 = gearPolygon(N2, m, 0).map(([x, y]) => [x * Math.cos(ph) - y * Math.sin(ph), x * Math.sin(ph) + y * Math.cos(ph)]);

  const poly = (p) => p.map(([x, y]) => `[${r2(x)}, ${r2(y)}]`).join(', ');
  const cyl = (x, y, z0, z1, r) => `translate([${r2(x)}, ${r2(y)}, ${r2((z0 + z1) / 2)}]) cylinder(${r2(z1 - z0)}, ${r2(r)});`;
  const cone = (x, z0, z1, rb, rt) => `translate([${r2(x)}, 0, ${r2((z0 + z1) / 2)}]) cone(${r2(z1 - z0)}, ${r2(rb)}, ${r2(rt)});`;
  const box = (x, y, z0, z1, w, d) => `translate([${r2(x)}, ${r2(y)}, ${r2((z0 + z1) / 2)}]) box(${r2(w)}, ${r2(d)}, ${r2(z1 - z0)});`;

  // a wheel lying flat at (gx,gy) with a centre hole
  const wheel = (p, gx, gy) => `difference() { translate([${r2(gx)}, ${r2(gy)}, ${r2(wheelT / 2)}]) extrude([${poly(p)}], ${r2(wheelT)}); ${cyl(gx, gy, -1, wheelT + 1, rHole)} }`;
  // a split, barbed hub at x: shaft + downward-widening barb, slotted in two so it can flex
  const hub = (x) => `difference() { union() { ${cyl(x, 0, baseT, shaftTop, rShaft)} ${cone(x, shaftTop, barbTop, rLip, rTip)} } ${box(x, 0, baseT, barbTop + 1, slotW, 2 * rLip + 2)} }`;

  // thin base bar with a small pad at each hub
  const base = `union() { ${box(D / 2, 0, 0, baseT, D, barW)} ${cyl(0, 0, 0, baseT, rLip + 1)} ${cyl(D, 0, 0, baseT, rLip + 1)} }`;
  const chassis = `union() { ${base} ${hub(0)} ${hub(D)} }`;

  const gy = -(ro1 + rLip + 8 * s);                 // wheels parked below the bar
  const cx = r2(D / 2);
  return `// snap-together gears — click each wheel onto its split hub, the wider top keeps it on\ntranslate([${-cx}, 0, 0]) union() {\n  ${chassis};\n  ${wheel(g1, 0, gy)};\n  ${wheel(g2, ro1 + ro2 + 8 * s, gy)};\n}\n`;
}

// The Simple-mode catalogue. Each recipe: friendly knobs + build(vals) -> source.
export const RECIPES = [
  {
    id: 'flexi-dino',
    name: 'Flexi dino',
    icon: 'ti-dog',
    blurb: 'Bends and wiggles once it’s printed',
    knobs: [
      { key: 'size', label: 'Size', type: 'choice', options: ['small', 'medium', 'large'], default: 'medium' },
    ],
    build: flexiDino,
  },
];
