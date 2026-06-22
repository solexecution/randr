import { test, expect } from '@playwright/test';
import { gotoApp, ensureBuildMode, addShape, selectNode, setPos, getNode, partCount } from './_helpers.js';

// Proves the core E2E patterns: boot → build mode → add via gallery → select →
// move via numeric inputs → assert against build-tree state. Broad coverage
// lives in the dedicated E2E suites.
test('add a box, select it, and move it via numeric inputs', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  const before = await partCount(page);
  const i = await addShape(page, 'box');
  expect(await partCount(page)).toBe(before + 1);
  expect((await getNode(page, i)).kind).toBe('box');

  await selectNode(page, i);
  await setPos(page, i, 0, 25);
  await setPos(page, i, 1, 15);

  const node = await getNode(page, i);
  expect(node.pos[0]).toBe(25);
  expect(node.pos[1]).toBe(15);
});
