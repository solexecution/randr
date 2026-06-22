import { test, expect } from '@playwright/test';
import {
  gotoApp,
  ensureBuildMode,
  addShape,
  selectNode,
  setPos,
  setRot,
  getNode,
  collectConsoleErrors,
} from './_helpers.js';

// Selection + transforms for the R&R (randr) build mode.
//
// Source facts verified against src/ui/app.js + src/ui/viewport.js:
//   - Numeric editor fields exist only for pos ([data-pos="i:a"]) and rot
//     ([data-rot="i:a"]); there is NO [data-scale] field — scale is gizmo-only.
//   - viewport.editMeshes[] entries are { index, mesh, ... }; the editGroup is
//     only rotated (no scale), so mesh.position.{x,y,z} maps 1:1 to node.pos
//     [0,1,2] in mm.
//   - Keyboard (window keydown, app.js:2517): w→translate, e→rotate, r→scale
//     (build mode, no modifiers, not typing in INPUT/TEXTAREA). [data-xform]
//     buttons carry the same values.
//   - Arrow nudge (app.js:2564): step = shiftKey ? 10 : 1 mm. ArrowRight +x,
//     ArrowLeft -x, ArrowUp +y, ArrowDown -y, PageUp +z, PageDown -z. _nudge()
//     applies the delta to EVERY selected node (app.js:816).
//
// All keyboard cases blur the active element first so the "typing" guard
// (app.js:2533) does not swallow the key after the edit panel renders.

/** Read the editMesh world-frame position (THREE units == mm here) for node i. */
function editMeshPos(page, i) {
  return page.evaluate((idx) => {
    const em = window.__forgeApp.viewport.editMeshes.find((e) => e.index === idx);
    if (!em) return null;
    const p = em.mesh.position;
    return [p.x, p.y, p.z];
  }, i);
}

/**
 * Drop input focus so window-level key shortcuts (W/E/R, arrows) are not
 * swallowed by the "typing" guard (app.js:2533 checks activeElement.tagName).
 * The keydown listener is on window, so no element needs focus — blurring any
 * focused numeric field is enough, and avoids a canvas .click() that the gizmo
 * pointer handlers would intercept and hang on.
 */
async function blurInputs(page) {
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el && el.blur && /^(INPUT|TEXTAREA)$/.test(el.tagName)) el.blur();
  });
  await page.waitForFunction(
    () => !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || ''),
    null,
    { timeout: 5000 },
  );
}

test('setPos updates node.pos and the matching editMesh position', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await gotoApp(page);
  await ensureBuildMode(page);

  const i = await addShape(page, 'box');
  await selectNode(page, i);

  await setPos(page, i, 0, 25);
  await setPos(page, i, 1, -12);
  await setPos(page, i, 2, 8);

  const node = await getNode(page, i);
  expect(node.pos[0]).toBeCloseTo(25, 3);
  expect(node.pos[1]).toBeCloseTo(-12, 3);
  expect(node.pos[2]).toBeCloseTo(8, 3);

  // The numeric field schedules a debounced recompile (app.js:467, 180ms) that
  // rebuilds the edit meshes from node.pos — wait for the mesh to catch up, then
  // assert it matches (editGroup has no scale, so mm == THREE units, 1:1).
  await page.waitForFunction(
    (idx) => {
      const em = window.__forgeApp.viewport.editMeshes.find((e) => e.index === idx);
      if (!em) return false;
      const p = em.mesh.position;
      return Math.abs(p.x - 25) < 1e-3 && Math.abs(p.y - -12) < 1e-3 && Math.abs(p.z - 8) < 1e-3;
    },
    i,
    { timeout: 10000 },
  );
  const mp = await editMeshPos(page, i);
  expect(mp).not.toBeNull();
  expect(mp[0]).toBeCloseTo(25, 3);
  expect(mp[1]).toBeCloseTo(-12, 3);
  expect(mp[2]).toBeCloseTo(8, 3);

  expect(errors).toEqual([]);
});

test('setRot updates node.rot on every axis', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const i = await addShape(page, 'box');
  await selectNode(page, i);

  await setRot(page, i, 0, 30);
  await setRot(page, i, 1, 45);
  await setRot(page, i, 2, -90);

  const node = await getNode(page, i);
  expect(node.rot[0]).toBeCloseTo(30, 3);
  expect(node.rot[1]).toBeCloseTo(45, 3);
  expect(node.rot[2]).toBeCloseTo(-90, 3);
});

// PATH TAKEN: gizmo mode. There is no numeric scale field in the edit panel
// (only [data-pos]/[data-rot]), so scale is asserted via the transform gizmo
// switching to 'scale' mode rather than by editing a field.
test('scale is driven by the gizmo (no numeric field): switching to scale mode', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const i = await addShape(page, 'box');
  await selectNode(page, i);

  // Sanity: confirm the codebase really exposes no scale input for this part.
  expect(await page.locator(`[data-scale="${i}:0"]`).count()).toBe(0);

  await page.locator('[data-xform="scale"]').click();
  await page.waitForFunction(
    () => window.__forgeApp.viewport.transformMode === 'scale',
    null,
    { timeout: 5000 },
  );
  expect(await page.evaluate(() => window.__forgeApp.viewport.transformMode)).toBe('scale');
});

test('W/E/R keys switch the transform mode', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const i = await addShape(page, 'box');
  await selectNode(page, i);
  await blurInputs(page);

  const mode = () => page.evaluate(() => window.__forgeApp.viewport.transformMode);
  const waitMode = (m) =>
    page.waitForFunction((x) => window.__forgeApp.viewport.transformMode === x, m, {
      timeout: 5000,
    });

  await page.keyboard.press('e');
  await waitMode('rotate');
  expect(await mode()).toBe('rotate');

  await page.keyboard.press('r');
  await waitMode('scale');
  expect(await mode()).toBe('scale');

  await page.keyboard.press('w');
  await waitMode('translate');
  expect(await mode()).toBe('translate');
});

test('[data-xform] toolbar buttons switch the transform mode', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const i = await addShape(page, 'box');
  await selectNode(page, i);

  const mode = () => page.evaluate(() => window.__forgeApp.viewport.transformMode);

  await page.locator('[data-xform="rotate"]').click();
  await page.waitForFunction(() => window.__forgeApp.viewport.transformMode === 'rotate', null, {
    timeout: 5000,
  });
  expect(await mode()).toBe('rotate');

  await page.locator('[data-xform="translate"]').click();
  await page.waitForFunction(() => window.__forgeApp.viewport.transformMode === 'translate', null, {
    timeout: 5000,
  });
  expect(await mode()).toBe('translate');
});

test('arrow keys nudge the selected part by 1mm (10mm with Shift) on the right axis', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const i = await addShape(page, 'box');
  await selectNode(page, i);
  // Start from a known origin so signs/axes are unambiguous.
  await setPos(page, i, 0, 0);
  await setPos(page, i, 1, 0);
  await setPos(page, i, 2, 0);
  await blurInputs(page);

  const pos = async () => (await getNode(page, i)).pos;
  const waitPos = (axis, value) =>
    page.waitForFunction(
      ({ i, axis, value }) => Math.abs(window.__forgeApp.buildTree.nodes[i].pos[axis] - value) < 1e-6,
      { i, axis, value },
      { timeout: 5000 },
    );

  // ArrowRight → +x by 1mm.
  await page.keyboard.press('ArrowRight');
  await waitPos(0, 1);
  // ArrowUp → +y by 1mm.
  await page.keyboard.press('ArrowUp');
  await waitPos(1, 1);
  // PageUp → +z by 1mm.
  await page.keyboard.press('PageUp');
  await waitPos(2, 1);
  expect(await pos()).toEqual([1, 1, 1]);

  // ArrowDown → -y by 1mm (back to 0).
  await page.keyboard.press('ArrowDown');
  await waitPos(1, 0);
  // ArrowLeft → -x by 1mm (back to 0).
  await page.keyboard.press('ArrowLeft');
  await waitPos(0, 0);
  expect(await pos()).toEqual([0, 0, 1]);

  // Shift+ArrowRight → +x by 10mm.
  await page.keyboard.press('Shift+ArrowRight');
  await waitPos(0, 10);
  expect((await pos())[0]).toBeCloseTo(10, 6);
});

test('multi-select nudge applies the same delta to every selected part', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const a = await addShape(page, 'box');
  const b = await addShape(page, 'box');

  // Give them distinct starting positions so we test the DELTA, not equality.
  await selectNode(page, a);
  await setPos(page, a, 0, 0);
  await setPos(page, a, 1, 0);
  await selectNode(page, b);
  await setPos(page, b, 0, 30);
  await setPos(page, b, 1, 10);

  // Select both (b becomes the primary). selectNode(...,true) is additive.
  await selectNode(page, a);
  await selectNode(page, b, true);
  await page.waitForFunction(
    ({ a, b }) => {
      const s = window.__forgeApp.selectedNodes || [];
      return s.includes(a) && s.includes(b);
    },
    { a, b },
    { timeout: 5000 },
  );

  const before = { a: (await getNode(page, a)).pos, b: (await getNode(page, b)).pos };

  await blurInputs(page);
  // Re-assert the multi-selection survived the canvas click before nudging.
  await page.waitForFunction(
    ({ a, b }) => {
      const s = window.__forgeApp.selectedNodes || [];
      return s.includes(a) && s.includes(b);
    },
    { a, b },
    { timeout: 5000 },
  );

  // Shift+ArrowRight → +10mm in x for BOTH parts.
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForFunction(
    ({ a, bx }) => Math.abs(window.__forgeApp.buildTree.nodes[a].pos[0] - bx) < 1e-6,
    { a, bx: before.a[0] + 10 },
    { timeout: 5000 },
  );

  const after = { a: (await getNode(page, a)).pos, b: (await getNode(page, b)).pos };

  // Same delta (+10,0,0) applied to each, independent of their start positions.
  expect(after.a[0]).toBeCloseTo(before.a[0] + 10, 6);
  expect(after.a[1]).toBeCloseTo(before.a[1], 6);
  expect(after.b[0]).toBeCloseTo(before.b[0] + 10, 6);
  expect(after.b[1]).toBeCloseTo(before.b[1], 6);
});
