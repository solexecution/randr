// Inline SVG previews for the Add gallery — little isometric pictures of each
// primitive / part / template instead of single-glyph icons. Solids use a cyan
// family (the "your part" colour, reads on light + dark); fasteners use a
// neutral metal; hole-features show a cyan slab with a dark void. Every art is a
// 64x64 viewBox with a thin dark outline supplied by the wrapper.

const C = {
  top: '#8fe6f1', mid: '#46c2d2', dark: '#2c8d9a',     // solid faces (light/mid/dark)
  line: '#173a41', void: '#0e2c33',                    // outline / cut cavity
  mTop: '#e3ebf0', mMid: '#aeb9c2', mDark: '#7e8b96',  // metal (fasteners)
};

const svg = (inner) =>
  `<svg viewBox="0 0 64 64" class="shape-art" aria-hidden="true" fill="none" stroke="${C.line}" ` +
  `stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">${inner}</svg>`;

// --- point generators -------------------------------------------------------
const fix = (n) => Math.round(n * 10) / 10;
function ngon(cx, cy, rx, sides, rot = 0, squash = 1) {
  const p = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    p.push(`${fix(cx + rx * Math.cos(a))},${fix(cy + rx * squash * Math.sin(a))}`);
  }
  return p.join(' ');
}
function cogPts(cx, cy, teeth, rOut, rRoot) {
  const p = []; const step = (Math.PI * 2) / teeth; const w = step * 0.28;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    p.push(`${fix(cx + rRoot * Math.cos(a - w))},${fix(cy + rRoot * Math.sin(a - w))}`);
    p.push(`${fix(cx + rOut * Math.cos(a - w))},${fix(cy + rOut * Math.sin(a - w))}`);
    p.push(`${fix(cx + rOut * Math.cos(a + w))},${fix(cy + rOut * Math.sin(a + w))}`);
    p.push(`${fix(cx + rRoot * Math.cos(a + w))},${fix(cy + rRoot * Math.sin(a + w))}`);
  }
  return p.join(' ');
}
function starPts(cx, cy, points, rOut, rIn) {
  const p = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? rIn : rOut;
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
    p.push(`${fix(cx + r * Math.cos(a))},${fix(cy + r * Math.sin(a))}`);
  }
  return p.join(' ');
}
// vertical cylinder: body + top ellipse
const cyl = (cx, top, bot, rx, ry, body, topc) =>
  `<path d="M${cx - rx},${top} V${bot} a${rx},${ry} 0 0 0 ${rx * 2},0 V${top}" fill="${body}"/>` +
  `<ellipse cx="${cx}" cy="${top}" rx="${rx}" ry="${ry}" fill="${topc}"/>`;

// shared isometric cube
const CUBE = {
  top: '32,11 53,22 32,33 11,22',
  left: '11,22 32,33 32,54 11,43',
  right: '53,22 32,33 32,54 53,43',
  sil: '32,11 53,22 53,43 32,54 11,43 11,22',
  y: 'M32,33 11,22 M32,33 53,22 M32,33 32,54',
};
const cubeFaces =
  `<polygon points="${CUBE.top}" stroke="none" fill="${C.top}"/>` +
  `<polygon points="${CUBE.left}" stroke="none" fill="${C.mid}"/>` +
  `<polygon points="${CUBE.right}" stroke="none" fill="${C.dark}"/>`;
const cube =
  `<polygon points="${CUBE.top}" fill="${C.top}"/>` +
  `<polygon points="${CUBE.left}" fill="${C.mid}"/>` +
  `<polygon points="${CUBE.right}" fill="${C.dark}"/>`;

const ART = {
  // --- basic solids ---
  box: cube,
  cylinder: cyl(32, 20, 44, 20, 8, C.mid, C.top),
  sphere:
    `<circle cx="32" cy="32" r="21" fill="${C.mid}"/>` +
    `<path d="M32,11 A21,21 0 0 0 32,53 A15,21 0 0 1 32,11 Z" fill="${C.top}"/>` +
    `<ellipse cx="24" cy="23" rx="5.5" ry="3.6" fill="#ffffff" stroke="none" opacity=".55"/>`,
  cone:
    `<ellipse cx="32" cy="46" rx="18" ry="7" fill="${C.dark}"/>` +
    `<path d="M32,10 L14,46 A18,7 0 0 0 50,46 Z" fill="${C.mid}"/>` +
    `<path d="M32,10 L14,46 A18,7 0 0 0 32,53 Z" fill="${C.top}"/>`,
  pyramid:
    `<polygon points="32,9 10,40 32,55" fill="${C.top}"/>` +
    `<polygon points="32,9 54,40 32,55" fill="${C.mid}"/>`,
  prism:
    `<polygon points="14,18 23,26 23,48 14,40" fill="${C.mid}"/>` +
    `<polygon points="23,26 41,26 41,48 23,48" fill="${C.mid}"/>` +
    `<polygon points="41,26 50,18 50,40 41,48" fill="${C.dark}"/>` +
    `<polygon points="${ngon(32, 18, 18, 6, 0, 0.5)}" fill="${C.top}"/>`,
  gear:
    `<polygon points="${cogPts(32, 30, 9, 22, 17)}" fill="${C.mid}"/>` +
    `<circle cx="32" cy="30" r="9" fill="${C.top}"/>` +
    `<circle cx="32" cy="30" r="4" fill="${C.void}"/>`,
  wedge:
    `<polygon points="16,46 16,24 26,18 26,40" fill="${C.dark}"/>` +
    `<polygon points="16,24 26,18 56,40 46,46" fill="${C.top}"/>` +
    `<polygon points="16,46 46,46 16,24" fill="${C.mid}"/>`,
  torus:
    `<path fill-rule="evenodd" fill="${C.mid}" d="M10,30 a22,12 0 1 0 44,0 a22,12 0 1 0 -44,0 M21,30 a11,5 0 1 0 22,0 a11,5 0 1 0 -22,0"/>` +
    `<path d="M14,27 a20,9 0 0 1 36,0" stroke="${C.top}" stroke-width="3.5"/>`,
  dome:
    `<ellipse cx="32" cy="44" rx="20" ry="6" fill="${C.dark}"/>` +
    `<path d="M12,44 A20,22 0 0 1 52,44 Z" fill="${C.mid}"/>` +
    `<path d="M12,44 A20,22 0 0 1 32,46 A13,22 0 0 0 12,44 Z" fill="${C.top}"/>`,
  slot:
    `<path d="M20,27 h24 a10,10 0 0 1 0,20 h-24 a10,10 0 0 1 0,-20 Z" fill="${C.dark}"/>` +
    `<path d="M20,22 h24 a10,10 0 0 1 0,20 h-24 a10,10 0 0 1 0,-20 Z" fill="${C.top}"/>`,
  star:
    `<polygon points="${starPts(32, 34, 5, 21, 9)}" fill="${C.dark}"/>` +
    `<polygon points="${starPts(32, 30, 5, 21, 9)}" fill="${C.top}"/>`,

  // --- rounded & chamfered ---
  roundedBox: `${cubeFaces}<path d="${CUBE.y}"/><polygon points="${CUBE.sil}" stroke-width="4.5" stroke-linejoin="round"/>`,
  chamferedBox: `${cubeFaces}<path d="${CUBE.y}"/><polygon points="${CUBE.sil}" stroke-width="4.5" stroke-linejoin="bevel"/>`,
  roundedCylinder:
    `<path d="M12,28 V42 a20,8 0 0 0 40,0 V28" fill="${C.mid}"/>` +
    `<path d="M12,28 a20,17 0 0 1 40,0 Z" fill="${C.top}"/>`,
  chamferedCylinder:
    `<path d="M12,26 V42 a20,8 0 0 0 40,0 V26" fill="${C.mid}"/>` +
    `<path d="M12,26 a20,8 0 0 0 40,0 L46,18 a14,5 0 0 0 -28,0 Z" fill="${C.mid}"/>` +
    `<ellipse cx="32" cy="18" rx="14" ry="5" fill="${C.top}"/>`,
  tube:
    `<path d="M12,22 V40 a20,8 0 0 0 40,0 V22" fill="${C.mid}"/>` +
    `<ellipse cx="32" cy="22" rx="20" ry="8" fill="${C.top}"/>` +
    `<ellipse cx="32" cy="22" rx="9" ry="3.6" fill="${C.void}"/>`,

  // --- text ---
  text:
    `<text x="33" y="44" stroke="none" fill="${C.dark}" font-family="sans-serif" font-weight="800" font-size="36" text-anchor="middle">A</text>` +
    `<text x="31" y="42" stroke="none" fill="${C.top}" font-family="sans-serif" font-weight="800" font-size="36" text-anchor="middle">A</text>`,
  engrave: `${cube}<path d="M37,38 h9 M37,43 h6" stroke="${C.void}" stroke-width="1.8"/>`,

  // --- fasteners (metal) ---
  bolt:
    `<polygon points="20,14 32,8 44,14 44,24 32,30 20,24" fill="${C.mTop}"/>` +
    `<rect x="26" y="26" width="12" height="28" rx="1" fill="${C.mMid}"/>` +
    `<path d="M26,32 h12 M26,38 h12 M26,44 h12 M26,50 h12" stroke="${C.mDark}"/>`,
  nut:
    `<polygon points="14,33 23,21 41,21 50,33 41,45 23,45" fill="${C.mDark}"/>` +
    `<polygon points="14,28 23,16 41,16 50,28 41,40 23,40" fill="${C.mTop}"/>` +
    `<circle cx="32" cy="28" r="8" fill="${C.void}"/>`,
  thread:
    cyl(32, 14, 48, 10, 4, C.mMid, C.mTop) +
    `<path d="M22,20 q10,5 20,0 M22,28 q10,5 20,0 M22,36 q10,5 20,0 M22,44 q10,5 20,0" stroke="${C.mDark}"/>`,
  counterbore:
    `<rect x="12" y="16" width="40" height="34" rx="3" fill="${C.mid}"/>` +
    `<path d="M22,16 h20 v9 h-6 v17 h-8 v-17 h-6 Z" fill="${C.void}" stroke="none"/>`,
  countersink:
    `<rect x="12" y="16" width="40" height="34" rx="3" fill="${C.mid}"/>` +
    `<path d="M21,16 h22 l-7,12 v14 h-8 v-14 Z" fill="${C.void}" stroke="none"/>`,
  insertHole:
    `<rect x="12" y="16" width="40" height="34" rx="3" fill="${C.mid}"/>` +
    `<rect x="25" y="16" width="14" height="24" fill="${C.void}" stroke="none"/>` +
    `<path d="M25,21 h14 M25,26 h14 M25,31 h14 M25,36 h14" stroke="${C.mid}" stroke-width="1"/>`,
  nutTrap:
    `<rect x="12" y="14" width="40" height="36" rx="3" fill="${C.mid}"/>` +
    `<polygon points="20,28 26,19 38,19 44,28 38,37 26,37" fill="${C.void}" stroke="none"/>` +
    `<rect x="29" y="37" width="6" height="13" fill="${C.void}" stroke="none"/>`,
  keyhole:
    `<rect x="12" y="13" width="40" height="38" rx="3" fill="${C.mid}"/>` +
    `<circle cx="32" cy="26" r="9" fill="${C.void}" stroke="none"/>` +
    `<rect x="28" y="26" width="8" height="20" fill="${C.void}" stroke="none"/>`,

  // --- actions ---
  sketch:
    `<rect x="14" y="30" width="24" height="16" rx="1" stroke="${C.dark}" stroke-dasharray="3 3"/>` +
    `<polygon points="40,12 50,12 50,28 40,28" fill="${C.top}" stroke="none" opacity=".45"/>` +
    `<path d="M45,28 V14 M41,18 l4,-4 4,4" stroke="${C.top}" stroke-width="2"/>`,
  import:
    `<path d="M32,12 V33 M25,26 l7,7 7,-7" stroke="${C.top}" stroke-width="2.4"/>` +
    `<path d="M16,38 v8 a2,2 0 0 0 2,2 h28 a2,2 0 0 0 2,-2 v-8" stroke="${C.mid}" stroke-width="2"/>`,

  // --- ready-made templates ---
  soapDish:
    `<path d="M15,30 h34 l-4,13 a4,4 0 0 1 -4,3 h-18 a4,4 0 0 1 -4,-3 Z" fill="${C.mid}"/>` +
    `<ellipse cx="32" cy="30" rx="17" ry="6" fill="${C.top}"/>` +
    `<ellipse cx="32" cy="30" rx="12" ry="4" fill="${C.void}"/>`,
  penCup:
    `<path d="M20,18 V44 a12,5 0 0 0 24,0 V18" fill="${C.mid}"/>` +
    `<ellipse cx="32" cy="18" rx="12" ry="5" fill="${C.top}"/>` +
    `<ellipse cx="32" cy="18" rx="8.5" ry="3.4" fill="${C.void}"/>`,
  coaster:
    `<ellipse cx="32" cy="40" rx="22" ry="9" fill="${C.dark}"/>` +
    `<ellipse cx="32" cy="35" rx="22" ry="9" fill="${C.top}"/>` +
    `<ellipse cx="32" cy="35" rx="15" ry="6" fill="${C.mid}"/>`,
  stackingBin:
    `<path d="M18,20 h28 l-4,26 h-20 Z" fill="${C.mid}"/>` +
    `<polygon points="18,20 46,20 42,24 22,24" fill="${C.top}"/>` +
    `<path d="M22,24 h20 l-3,20 h-14 Z" fill="${C.void}"/>`,
  bolt_nut:
    `<polygon points="22,14 32,9 42,14 42,22 32,27 22,22" fill="${C.mTop}"/>` +
    `<rect x="27" y="24" width="10" height="30" rx="1" fill="${C.mMid}"/>` +
    `<path d="M27,30 h10 M27,50 h10" stroke="${C.mDark}"/>` +
    `<polygon points="${ngon(32, 44, 12, 6, 0, 0.5)}" fill="${C.mDark}"/>` +
    `<polygon points="${ngon(32, 41, 12, 6, 0, 0.5)}" fill="${C.mTop}"/>`,
  washer:
    `<path fill-rule="evenodd" fill="${C.top}" d="M10,32 a22,11 0 1 0 44,0 a22,11 0 1 0 -44,0 M22,32 a10,5 0 1 0 20,0 a10,5 0 1 0 -20,0"/>`,
  lBracket:
    `<path d="M16,14 h10 v24 h16 v10 h-26 Z" fill="${C.mid}"/>`,
  knob:
    `<path d="M18,30 V40 a14,6 0 0 0 28,0 V30" fill="${C.dark}"/>` +
    `<ellipse cx="32" cy="30" rx="14" ry="6" fill="${C.mid}"/>` +
    `<path d="M23,28 v5 M28,27 v6 M33,27 v6 M38,28 v5" stroke="${C.dark}"/>` +
    `<ellipse cx="32" cy="27" rx="10" ry="4" fill="${C.top}"/>`,
  fitTest:
    `<rect x="12" y="22" width="40" height="18" rx="2" fill="${C.mid}"/>` +
    `<path d="M20,22 v18 M28,22 v18 M36,22 v18 M44,22 v18" stroke="${C.void}"/>` +
    `<path d="M12,18 h40" stroke="${C.top}" stroke-width="2"/>`,
};

export function shapeArt(key) {
  return svg(ART[key] || ART.box);
}
