// Shared Playwright helpers for the R&R (randr) CAD app E2E suite.
//
// App facts (verified against source):
//   - window.__forgeApp        → the App instance (src/main.js:6)
//   - window.__dbg / __forgeExport / __recipes → scripting/test hooks (app.js:353-355)
//   - boot ready signal        → #boot gains class "gone" once the kernel loads (app.js:364)
//   - service worker           → only registers in PROD, so dev runs are SW-free
//   - localStorage namespace   → randr.* (theme/layout/projects)
//
// State lives on window.__forgeApp:
//   .mode 'code'|'build' · .tier 'pro' (Pro-only) · .viewMode 'edit'|'result'
//   .buildTree.nodes[] (each: kind, op 'solid'|'hole', pos[3], rot[3], scale[3],
//                       color, locked, hidden, group, groupMode, fields[])
//   .selectedNodes[] · .selectedNode · .currentModel
//   ._selectNode(i, additive) · .recompile()
import { expect } from '@playwright/test';

const SEED = { theme: 'dark', layout: 'inspector' };

/** Seed deterministic settings, open the app, and wait until the kernel is ready. */
export async function gotoApp(page, opts = {}) {
  const seed = { ...SEED, ...opts };
  await page.addInitScript((s) => {
    try {
      localStorage.setItem('randr.theme', s.theme);
      localStorage.setItem('randr.layout', s.layout);
    } catch { /* storage may be unavailable */ }
  }, seed);
  await page.goto('/');
  await page.waitForFunction(
    () => !!window.__forgeApp && document.querySelector('#boot')?.classList.contains('gone'),
    null,
    { timeout: 30000 },
  );
}

/** Number of parts in the build tree. */
export function partCount(page) {
  return page.evaluate(() => window.__forgeApp.buildTree.nodes.length);
}

/** Read a serializable snapshot of a build-tree node. */
export function getNode(page, i) {
  return page.evaluate((idx) => {
    const n = window.__forgeApp.buildTree.nodes[idx];
    if (!n) return null;
    return {
      kind: n.kind,
      op: n.op,
      pos: [...n.pos],
      rot: [...n.rot],
      scale: [...n.scale],
      color: n.color,
      locked: !!n.locked,
      hidden: !!n.hidden,
      group: n.group ?? null,
      groupMode: n.groupMode ?? null,
    };
  }, i);
}

// The code/build tabs live inside a menu (hidden by default), so for test setup
// we drive the real switch method directly. The shell E2E suite exercises the
// actual menu-click path separately.
export async function ensureBuildMode(page) {
  await page.evaluate(() => {
    if (window.__forgeApp.mode !== 'build') window.__forgeApp._switchMode('build');
  });
  await page.waitForFunction(() => window.__forgeApp.mode === 'build', null, { timeout: 5000 });
}

export async function ensureCodeMode(page) {
  await page.evaluate(() => {
    if (window.__forgeApp.mode !== 'code') window.__forgeApp._switchMode('code');
  });
  await page.waitForFunction(() => window.__forgeApp.mode === 'code', null, { timeout: 5000 });
}

export async function openAddGallery(page) {
  await page.click('#add-open');
  await expect(page.locator('#add-modal')).toBeVisible();
}

export async function closeAddGallery(page) {
  const modal = page.locator('#add-modal');
  if (await modal.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await modal.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  }
}

/** Add a primitive via the gallery (data-add="box" etc). Returns the new node's index. */
export async function addShape(page, kind) {
  const before = await partCount(page);
  await openAddGallery(page);
  await page.locator(`#add-modal [data-add="${kind}"]`).first().click();
  await page.waitForFunction((n) => window.__forgeApp.buildTree.nodes.length > n, before, {
    timeout: 12000,
  });
  await closeAddGallery(page);
  return before; // index of the newly added node === previous count
}

/** Insert a ready-made template via the gallery (data-tpl="..."). */
export async function addTemplate(page, tpl) {
  const before = await partCount(page);
  await openAddGallery(page);
  await page.locator(`#add-modal [data-tpl="${tpl}"]`).first().click();
  await page.waitForFunction((n) => window.__forgeApp.buildTree.nodes.length > n, before, {
    timeout: 15000,
  });
  await closeAddGallery(page);
  return before;
}

/** Select a part by index (drives the same path as a viewport pick, which also
 *  opens the edit panel so the numeric fields render). */
export async function selectNode(page, i, additive = false) {
  await page.evaluate(({ i, additive }) => window.__forgeApp.viewport.onSelect(i, additive), {
    i,
    additive,
  });
  await page
    .waitForFunction((i) => window.__forgeApp.selectedNodes?.includes(i), i, { timeout: 5000 })
    .catch(() => {});
}

/** Set a position axis (0=x,1=y,2=z) via the numeric editor field and wait for it to apply. */
export async function setPos(page, i, axis, value) {
  const sel = `[data-pos="${i}:${axis}"]`;
  await expect(page.locator(sel)).toBeVisible();
  await page.locator(sel).fill(String(value));
  await page.waitForFunction(
    ({ i, axis, value }) => window.__forgeApp.buildTree.nodes[i].pos[axis] === value,
    { i, axis, value },
  );
}

/** Set a rotation axis (0=rx,1=ry,2=rz, degrees) via the numeric editor field. */
export async function setRot(page, i, axis, value) {
  const sel = `[data-rot="${i}:${axis}"]`;
  await expect(page.locator(sel)).toBeVisible();
  await page.locator(sel).fill(String(value));
  await page.waitForFunction(
    ({ i, axis, value }) => window.__forgeApp.buildTree.nodes[i].rot[axis] === value,
    { i, axis, value },
  );
}

/** Start collecting console + page errors. Returns the mutable array. */
export function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}
