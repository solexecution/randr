import { test, expect } from '@playwright/test';
import { gotoApp, ensureBuildMode, addShape, partCount, collectConsoleErrors } from './_helpers.js';

// The result view draws each colour part as its own solid, so abutting parts
// (e.g. a post resting on a slab) share coincident faces that used to z-fight
// into a shimmering "uneven surface". setColoredModel now gives each part after
// the first a small polygon-offset depth bias so those ties resolve in a fixed
// order. The shimmer itself is hard to assert from a screenshot, so this locks
// in the mechanism: distinct biases across the result meshes.
test.describe('result view — coincident-face z-fighting fix', () => {
  test('result part meshes carry distinct per-part depth biases', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await gotoApp(page);
    await ensureBuildMode(page);

    // Two extra solids -> several coloured parts that can abut/overlap.
    await addShape(page, 'box');
    await addShape(page, 'cylinder');
    expect(await partCount(page)).toBeGreaterThanOrEqual(2);

    await page.waitForFunction(() => !!window.__forgeApp.currentModel);
    await page.evaluate(() => window.__forgeApp._setViewMode('result'));
    await page.waitForFunction(
      () =>
        window.__forgeApp.viewMode === 'result' &&
        window.__forgeApp.viewport.modelGroup.children.some((c) => c.isMesh),
    );

    const offsets = await page.evaluate(() =>
      window.__forgeApp.viewport.modelGroup.children
        .filter((c) => c.isMesh)
        .map((m) => ({
          polygonOffset: !!m.material.polygonOffset,
          units: m.material.polygonOffsetUnits ?? 0,
        })),
    );

    // At least two coloured parts are drawn.
    expect(offsets.length).toBeGreaterThanOrEqual(2);
    // Every part has a distinct depth-offset value, so no two coincident faces
    // can tie (which is what produced the z-fighting shimmer).
    const units = offsets.map((o) => o.units);
    expect(new Set(units).size).toBe(units.length);
    // Parts after the first are explicitly biased.
    expect(offsets.slice(1).every((o) => o.polygonOffset)).toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('result view — pick to edit', () => {
  test('clicking a part in result preview selects it and opens edit', async ({ page }) => {
    await gotoApp(page);
    await ensureBuildMode(page);
    // Start from an empty plate so the centred result pick is unambiguous — the
    // box is then the only solid under the centre pixel (the starter scene's other
    // parts would otherwise sit in front of the raycast).
    await page.evaluate(() => {
      const a = window.__forgeApp;
      a.buildTree.nodes = [];
      a.selectedNodes = [];
      a.selectedNode = -1;
    });
    const i = await addShape(page, 'box');
    await page.waitForFunction(() => !!window.__forgeApp.currentModel);
    await page.evaluate(() => window.__forgeApp._setViewMode('result'));

    const pickIdx = await page.evaluate(() => {
      const v = window.__forgeApp.viewport;
      const r = v.canvas.getBoundingClientRect();
      const hit = v._pickResultShape(r.left + r.width / 2, r.top + r.height / 2);
      return hit?.object?.userData?.index ?? null;
    });
    expect(pickIdx).toBe(i);

    await page.evaluate((idx) => window.__forgeApp.viewport.onSelect(idx, false), i);
    await expect.poll(() => page.evaluate(() => window.__forgeApp.viewMode)).toBe('edit');
    expect(await page.evaluate(() => window.__forgeApp.selectedNodes)).toContain(i);
  });
});

test.describe('result view — keeps edit-mode coordinates', () => {
  test('a part sunk below the plate stays sunk in the result (no snap to bed)', async ({ page }) => {
    await gotoApp(page);
    await ensureBuildMode(page);
    const i = await addShape(page, 'box');
    // Sink the box well below the plate.
    await page.evaluate((idx) => {
      const a = window.__forgeApp;
      a.buildTree.nodes[idx].pos[2] = -8;
      a.recompile();
    }, i);
    await page.waitForFunction(() => !!window.__forgeApp.currentModel);
    await page.evaluate(() => window.__forgeApp._setViewMode('result'));
    await page.waitForFunction(
      () => window.__forgeApp.viewMode === 'result'
        && window.__forgeApp.viewport.modelGroup.children.some((c) => c.isMesh),
    );
    const r = await page.evaluate(() => {
      const mg = window.__forgeApp.viewport.modelGroup;
      let worldMinY = Infinity;
      mg.children.forEach((c) => {
        if (!c.isMesh) return;
        c.geometry.computeBoundingBox();
        worldMinY = Math.min(worldMinY, mg.position.y + c.geometry.boundingBox.min.y);
      });
      return { posY: mg.position.y, worldMinY };
    });
    // The result must not be translated to seat it on the bed, so the sunk part's
    // lowest point is still below the plate (y = 0).
    expect(r.posY).toBe(0);
    expect(r.worldMinY).toBeLessThan(-1);
  });
});
