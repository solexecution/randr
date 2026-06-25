import { describe, it, expect } from 'vitest';
import { compile } from '../../src/lang/compile.js';
import { loadKernel } from '../../src/kernel/manifold.js';

const FOLD7_BRACE = `param phoneT = 9.3;
param jawT = 2.5;
param flexT = 1.2;
param hookZ = 1.8;
param longArm = 100;
param shortArm = 40;
param footH = 5.0;
param footR = 8;
param cardW = 54.0;
param slotH = 2.2;
param railH = 2.0;
param wall = 2.5;
param clipDepth = 12;
clipStackZ = hookZ + phoneT + flexT + jawT;
frameH = (2 * railH) + slotH;
trayW = cardW + (2 * wall);

difference() {
  union() {
    translate([0, clipDepth / 2, clipStackZ / 2]) {
      roundedBox(longArm, clipDepth, clipStackZ, 2);
    }
    translate([0, 2, hookZ / 2]) {
      roundedBox(longArm, 4, hookZ, 1.5);
    }
    translate([0, clipDepth + trayW / 2, clipStackZ + frameH / 2]) {
      roundedBox(longArm, trayW, frameH, 2.5);
    }
    translate([longArm / 2 + shortArm / 2, clipDepth / 2, clipStackZ / 2]) {
      roundedBox(shortArm, clipDepth + 4, clipStackZ, 2);
    }
    translate([longArm / 2 + shortArm / 2, clipDepth / 2, footH / 2]) {
      roundedBox(14, clipDepth + 4, footH, 2);
    }
    translate([longArm / 2 + shortArm, clipDepth / 2, footH / 2]) {
      cylinder(footH, footR);
    }
  }
  translate([0, clipDepth / 2, hookZ + phoneT / 2 + 0.1]) {
    box(longArm + 1, clipDepth - 1, phoneT + 0.2);
  }
  translate([longArm / 2 + shortArm / 2, clipDepth / 2, hookZ + phoneT / 2 + 0.1]) {
    box(shortArm + 1, clipDepth, phoneT + 0.2);
  }
  translate([-10, clipDepth + trayW / 2, clipStackZ + railH + slotH / 2]) {
    box(longArm + 20, cardW + 0.4, slotH);
  }
  translate([-20, clipDepth + trayW / 2, clipStackZ + frameH - railH / 2]) {
    box(30, cardW - 10, railH + 1);
  }
}`;

describe('Fold 7 anti-wobble brace (R&R syntax)', () => {
  it('compiles without error', async () => {
    await loadKernel();
    const { error, result } = compile(FOLD7_BRACE);
    expect(error).toBeNull();
    expect(result).not.toBeNull();
    result?.delete();
  });
});