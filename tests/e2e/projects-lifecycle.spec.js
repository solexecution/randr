// Project lifecycle regressions.
//  - Deleting the OPEN project must not resurrect it: the fallback (open the next
//    project, or make a fresh one) used to checkpoint the *current* project first,
//    re-saving the just-deleted one straight back into the index.
//  - Importing a mesh adds an 'imported' build part that persists across save+reopen.
import { test, expect } from '@playwright/test';
import { gotoApp, ensureBuildMode, ensureCodeMode, addShape } from './_helpers.js';

const indexIds = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('randr.index') || '[]').map((p) => p.id));

test('deleting the OPEN project does not resurrect it (falls back to the next)', async ({ page }) => {
  await gotoApp(page);
  const { id1, id2 } = await page.evaluate(() => {
    const app = window.__forgeApp;
    const id1 = app.project.id;
    app._newProject();           // project 2 becomes the open one
    return { id1, id2: app.project.id };
  });
  await page.evaluate((id) => window.__forgeApp._deleteProject(id), id2); // delete the OPEN project

  const ids = await indexIds(page);
  expect(ids).not.toContain(id2);  // gone, not re-saved
  expect(ids).toContain(id1);      // the other one survives
  expect(await page.evaluate(() => window.__forgeApp.project.id)).toBe(id1); // and is now open
});

test('deleting the only project leaves exactly one fresh project', async ({ page }) => {
  await gotoApp(page);
  const id1 = await page.evaluate(() => window.__forgeApp.project.id);
  await page.evaluate((id) => window.__forgeApp._deleteProject(id), id1);

  const ids = await indexIds(page);
  expect(ids).not.toContain(id1); // old one truly gone
  expect(ids).toHaveLength(1);    // a single fresh project, not a duplicate
  expect(await page.evaluate(() => window.__forgeApp.project.id)).toBe(ids[0]);
});

test('importing a mesh adds a build part that survives save + reopen', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);
  await addShape(page, 'box');
  await page.waitForFunction(() => !!window.__forgeApp.currentModel, null, { timeout: 12000 });

  // export the current model to a valid (watertight) STL and re-import it
  const before = await page.evaluate(() => {
    const app = window.__forgeApp;
    const stl = window.__forgeExport.exportSTL(app.currentModel);
    const n = app.buildTree.nodes.length;
    app._importSTLFile(new File([stl], 'roundtrip.stl', { type: 'model/stl' }));
    return n;
  });
  await page.waitForFunction((n) => {
    const nodes = window.__forgeApp.buildTree.nodes;
    return nodes.length > n && nodes[nodes.length - 1].kind === 'imported';
  }, before, { timeout: 12000 });
  expect(await page.evaluate(() => window.__forgeApp.mode)).toBe('build');

  // save + reopen → the imported node and its mesh come back, and it recompiles
  await page.evaluate(() => { const a = window.__forgeApp; a._saveCurrent(); a._openProject(a.project.id); });
  await page.waitForFunction(
    () => window.__forgeApp.buildTree.nodes.some((n) => n.kind === 'imported') && !!window.__forgeApp.currentModel,
    null,
    { timeout: 12000 },
  );
});

test('importing while in code mode switches to build so the part is visible', async ({ page }) => {
  // The ☰ menu Import fires in any mode; in code mode the part used to land in the
  // build tree behind the editor (looked like nothing happened). It must switch.
  await gotoApp(page);
  await ensureCodeMode(page);
  await page.waitForFunction(() => !!window.__forgeApp.currentModel, null, { timeout: 12000 });
  await page.evaluate(() => {
    const a = window.__forgeApp;
    a._importSTLFile(new File([window.__forgeExport.exportSTL(a.currentModel)], 'm.stl', { type: 'model/stl' }));
  });
  await page.waitForFunction(
    () => window.__forgeApp.mode === 'build' && window.__forgeApp.buildTree.nodes.some((n) => n.kind === 'imported'),
    null,
    { timeout: 12000 },
  );
});
