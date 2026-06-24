// Data, not logic: the default code-mode STARTER document and the ready-made
// TEMPLATES (the ☰ Templates▸ menu and command palette load these by key).
// Kept out of app.js so the controller is behaviour, not big data literals.

export const STARTER = `// Forge — parametric mode.
// Edit values or drag the sliders. Everything is millimetres.

param width     = 60;
param depth     = 40;
param height    = 20;
param wall      = 3;
param holeR     = 4;

difference() {
  roundedBox(width, depth, height, 4);
  // hollow it out
  translate([0, 0, wall]) {
    roundedBox(width - 2*wall, depth - 2*wall, height, 3);
  }
  // mounting holes
  translate([ width/2 - 8,  depth/2 - 8, 0]) cylinder(height + 2, holeR);
  translate([-width/2 + 8,  depth/2 - 8, 0]) cylinder(height + 2, holeR);
  translate([ width/2 - 8, -depth/2 + 8, 0]) cylinder(height + 2, holeR);
  translate([-width/2 + 8, -depth/2 + 8, 0]) cylinder(height + 2, holeR);
}
`;

// Ready-made parametric starters (loaded into the code pane). All flat-bottomed
// and print-safe on the A1 mini.
export const TEMPLATES = {
  'soap dish': `// Soap dish with drainage
param w = 100; param d = 70; param h = 22; param wall = 3; param holeR = 3;
difference() {
  box(w, d, h);
  translate([0, 0, wall]) { box(w - 2*wall, d - 2*wall, h); }
  translate([-24, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
  translate([-12, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
  translate([0, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
  translate([12, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
  translate([24, 0, wall/2 - h/2]) cylinder(wall + 6, holeR);
}
`,
  'fit test': `// Tolerance fit-test. Push the loose pin into each hole; the snuggest
// hole is your printer's clearance. Labels = clearance x 100 (20 = 0.20 mm).
param d = 5;   // target pin / rod diameter (mm)
param h = 8;   // bar height
union() {
  difference() {
    translate([0, 0, h/2]) { box(85, d + 18, h); }
    translate([-34, 2, h/2]) { cylinder(h + 4, d/2 + 0.10); }
    translate([-17, 2, h/2]) { cylinder(h + 4, d/2 + 0.15); }
    translate([0,   2, h/2]) { cylinder(h + 4, d/2 + 0.20); }
    translate([17,  2, h/2]) { cylinder(h + 4, d/2 + 0.25); }
    translate([34,  2, h/2]) { cylinder(h + 4, d/2 + 0.30); }
    translate([-34, -d/2 - 4, h - 0.8]) { text("10", 5, 1.4); }
    translate([-17, -d/2 - 4, h - 0.8]) { text("15", 5, 1.4); }
    translate([0,   -d/2 - 4, h - 0.8]) { text("20", 5, 1.4); }
    translate([17,  -d/2 - 4, h - 0.8]) { text("25", 5, 1.4); }
    translate([34,  -d/2 - 4, h - 0.8]) { text("30", 5, 1.4); }
  }
  translate([0, -d/2 - 18, (h + 6) / 2]) { cylinder(h + 6, d/2); }
}
`,
  'pen cup': `// Pen / tool cup
param w = 70; param d = 70; param h = 90; param wall = 2.5;
difference() {
  box(w, d, h);
  translate([0, 0, wall]) box(w - 2*wall, d - 2*wall, h);
}
`,
  'coaster': `// Coaster with rim
param r = 45; param h = 6; param wall = 3;
difference() {
  cylinder(h, r);
  translate([0, 0, wall]) cylinder(h, r - wall);
}
`,
  'stacking bin': `// Stacking bin
param w = 60; param d = 42; param h = 45; param wall = 2;
difference() {
  box(w, d, h);
  translate([0, 0, wall + 1]) box(w - 2*wall, d - 2*wall, h);
}
`,
  'bolt & nut': `// Threaded bolt with a matching nut (coarse, printable)
param d = 16; param pitch = 2.5;
bolt(d, pitch, 20, 24, 10);
translate([34, 0, 0]) nut(d, pitch, 12, 24);
`,
  'washer': `// Washer
tube(2.5, 11, 5.5);
`,
  'L-bracket': `// L-bracket with mounting holes
param t = 4; param w = 32; param d = 24; param h = 28; param hole = 4;
difference() {
  union() {
    translate([0, 0, t/2]) box(w, d, t);
    translate([-w/2 + t/2, 0, h/2]) box(t, d, h);
  }
  translate([w/4, 0, t/2]) cylinder(t + 2, hole/2);
  translate([-w/2 + t/2, 0, h*0.7]) rotate([0, 90, 0]) cylinder(t + 6, hole/2);
}
`,
  'knob': `// Stacked rounded knob
union() {
  roundedCylinder(6, 16, 4);
  translate([0, 0, 6]) roundedCylinder(10, 11, 4);
}
`,
};
