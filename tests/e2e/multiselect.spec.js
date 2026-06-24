// Regression: on touch (no Shift key) multi-select must be discoverable. A ⊹ multi
// toggle lives in the parts-panel header (shown with 2+ parts); tapping it arms the
// additive mode so tapping parts in the scene accumulates. Mirrors the edit-tools
// toggle (#multi-toggle) — both carry .js-multi and stay in sync.
import { test, expect } from '@playwright/test';
import { gotoApp, ensureBuildMode, addShape } from './_helpers.js';

test('the parts-header ⊹ multi toggle reveals at 2+ parts and arms additive selection', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);
  await addShape(page, 'box');
  await addShape(page, 'box');

  const head = page.locator('#multi-head');
  await expect(head).toBeVisible(); // 2+ parts → offered

  // off by default
  expect(await page.evaluate(() => window.__forgeApp.multiSelect)).toBe(false);
  await expect(head).not.toHaveClass(/\bon\b/);

  // tap → armed; app + viewport + both toggles in sync
  await head.click();
  expect(await page.evaluate(() => window.__forgeApp.multiSelect)).toBe(true);
  expect(await page.evaluate(() => window.__forgeApp.viewport.multiSelect)).toBe(true);
  await expect(head).toHaveClass(/\bon\b/);

  // tap again → off (does NOT clear the selection)
  await head.click();
  expect(await page.evaluate(() => window.__forgeApp.multiSelect)).toBe(false);
  await expect(head).not.toHaveClass(/\bon\b/);

  // hidden again when there's nothing to multi-select
  await page.evaluate(() => { window.__forgeApp.buildTree.nodes = []; window.__forgeApp.selectedNodes = []; window.__forgeApp._updatePartsHeader(); });
  await expect(head).toBeHidden();
});
