import { test, expect } from '@playwright/test';
import { gotoApp, ensureBuildMode } from './_helpers.js';

// Read the world point under a screen position, the camera target, and the
// camera→target distance (the effective zoom radius).
function probe(page, sx, sy) {
  return page.evaluate(({ sx, sy }) => {
    const v = window.__forgeApp.viewport;
    const p = v._pointUnderCursor(sx, sy);
    const t = v._target;
    const c = v.camera.position;
    return {
      p: p ? { x: p.x, y: p.y, z: p.z } : null,
      target: { x: t.x, y: t.y, z: t.z },
      dist: Math.hypot(c.x - t.x, c.y - t.y, c.z - t.z),
    };
  }, { sx, sy });
}

test('wheel zoom dollies toward the point under the cursor', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const box = await page.locator('#viewport-canvas').boundingBox();
  const sx = box.x + box.width * 0.42; // off-centre, over the model/plate
  const sy = box.y + box.height * 0.46;
  await page.mouse.move(sx, sy);

  const before = await probe(page, sx, sy);
  expect(before.p).not.toBeNull();
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const farBefore = d(before.target, before.p);
  expect(farBefore).toBeGreaterThan(0.5); // the cursor point is genuinely off the target

  await page.mouse.wheel(0, -400); // zoom in at the cursor
  await page.waitForTimeout(60);

  const after = await page.evaluate(() => {
    const v = window.__forgeApp.viewport, t = v._target, c = v.camera.position;
    return { target: { x: t.x, y: t.y, z: t.z }, dist: Math.hypot(c.x - t.x, c.y - t.y, c.z - t.z) };
  });

  expect(after.dist).toBeLessThan(before.dist); // actually zoomed in (radius shrank)
  // target moved toward the point that was under the cursor (zoom-to-cursor)
  expect(d(after.target, before.p)).toBeLessThan(farBefore - 0.01);
});

test('zooming out dollies away from the cursor point (symmetric)', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const box = await page.locator('#viewport-canvas').boundingBox();
  const sx = box.x + box.width * 0.6;
  const sy = box.y + box.height * 0.4;
  await page.mouse.move(sx, sy);

  const before = await probe(page, sx, sy);
  expect(before.p).not.toBeNull();
  await page.mouse.wheel(0, 400); // zoom out
  await page.waitForTimeout(60);
  const after = await page.evaluate(() => {
    const v = window.__forgeApp.viewport, t = v._target, c = v.camera.position;
    return { dist: Math.hypot(c.x - t.x, c.y - t.y, c.z - t.z) };
  });
  expect(after.dist).toBeGreaterThan(before.dist); // zoomed out
});
