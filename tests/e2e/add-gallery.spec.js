import { test, expect } from '@playwright/test';
import {
  gotoApp,
  partCount,
  getNode,
  ensureBuildMode,
  openAddGallery,
  closeAddGallery,
  collectConsoleErrors,
} from './_helpers.js';

// E2E coverage for the R&R (randr) "Add to scene" gallery (#add-modal).
//
// Verified against src/ui/app.js:
//   - ADD_GALLERY (app.js:30) defines the categories + tiles.
//   - data-cat sections: draw · basic · rounded · text · fasteners · ready · import.
//   - Shape tiles carry [data-add="<kind>"]; _addShape(kind) → buildTree.add(kind)
//     → createNode(kind) sets node.kind = kind, so data-add maps 1:1 to node.kind
//     (buildtree.js:87-92). Every gallery data-add has a DEFS entry, so all are
//     addable in Pro tier (no tier gating in add()).
//   - Template tiles carry [data-tpl="<name>"]; _loadTemplate (app.js:1491) in
//     build mode REPLACES buildTree.nodes with the template's nodes (it does not
//     append) — so the template test resets to an empty tree first.
//   - Search #add-search → _filterAdd: toggles .add-hide on non-matching tiles
//     (CSS display:none) and .cat-nomatch on empty sections; #add-empty shows
//     only when the query matches nothing.
//   - Sketch tile #add-sketch → _startSketch reveals #sketch-bar; #sketch-cancel
//     hides it. Import tile #modal-import clicks the hidden #stl-file input.

const EXPECTED_CATS = ['draw', 'basic', 'rounded', 'text', 'fasteners', 'ready', 'import'];

/** Empty the build tree so partCount deltas are unambiguous (templates replace, not append). */
async function resetTree(page) {
  await page.evaluate(() => {
    window.__forgeApp.buildTree.nodes = [];
    window.__forgeApp.selectedNodes = [];
    window.__forgeApp.selectedNode = -1;
  });
}

test.describe('Add gallery', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await ensureBuildMode(page);
  });

  test('opens the gallery and shows every expected category', async ({ page }) => {
    await openAddGallery(page);
    await expect(page.locator('#add-modal')).toBeVisible();

    const cats = await page.$$eval('#add-modal [data-cat]', (els) =>
      els.map((e) => e.dataset.cat),
    );
    for (const cat of EXPECTED_CATS) {
      expect(cats, `category "${cat}" present`).toContain(cat);
    }
    // The whole expected set, nothing missing.
    expect(new Set(cats)).toEqual(new Set(EXPECTED_CATS));

    await closeAddGallery(page);
    await expect(page.locator('#add-modal')).toBeHidden();
  });

  test('every shape tile adds a part whose kind matches its data-add', async ({ page }) => {
    // ~26 shapes, each triggering a real geometry recompile, so give this one
    // the room it needs rather than the default per-test budget.
    test.setTimeout(180000);
    const errors = collectConsoleErrors(page);

    // Read the real data-add list from the DOM at runtime (source of truth).
    await openAddGallery(page);
    const kinds = await page.$$eval('#add-modal [data-add]', (els) =>
      els.map((e) => e.dataset.add),
    );
    await closeAddGallery(page);

    expect(kinds.length, 'gallery exposes shape tiles').toBeGreaterThan(0);

    // Add the shapes sequentially onto one empty tree (_addShape appends), so
    // after the k-th add partCount === k and the new node sits at index k-1.
    // This is the core "every shape button works" check and avoids 26 resets.
    await resetTree(page);
    expect(await partCount(page)).toBe(0);

    for (let k = 0; k < kinds.length; k++) {
      const kind = kinds[k];
      const before = k; // current count before this add

      await openAddGallery(page);
      await page.locator(`#add-modal [data-add="${kind}"]`).first().click();
      await page.waitForFunction(
        (n) => window.__forgeApp.buildTree.nodes.length > n,
        before,
        { timeout: 15000 },
      );
      // _addShape closes the modal itself; make sure it's gone before the next open.
      await page.locator('#add-modal').waitFor({ state: 'hidden', timeout: 5000 });

      expect(await partCount(page), `partCount after adding "${kind}"`).toBe(before + 1);
      const node = await getNode(page, before);
      expect(node, `node created for "${kind}"`).not.toBeNull();
      expect(node.kind, `node.kind for data-add="${kind}"`).toBe(kind);
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('template tiles insert one or more parts', async ({ page }) => {
    const tpls = await (async () => {
      await openAddGallery(page);
      const list = await page.$$eval('#add-modal [data-tpl]', (els) =>
        els.map((e) => e.dataset.tpl),
      );
      await closeAddGallery(page);
      return list;
    })();

    expect(tpls.length, 'gallery exposes template tiles').toBeGreaterThanOrEqual(3);

    // Exercise at least the first three templates. _loadTemplate replaces the
    // tree, so start each from empty and assert the count grew above zero.
    for (const tpl of tpls.slice(0, 3)) {
      await resetTree(page);
      expect(await partCount(page)).toBe(0);

      await openAddGallery(page);
      await page.locator(`#add-modal [data-tpl="${tpl}"]`).first().click();
      await page.waitForFunction(
        () => window.__forgeApp.buildTree.nodes.length > 0,
        null,
        { timeout: 15000 },
      );
      await closeAddGallery(page);

      expect(await partCount(page), `parts inserted by template "${tpl}"`).toBeGreaterThan(0);
    }
  });

  test('search filters tiles and shows the empty state for no matches', async ({ page }) => {
    await openAddGallery(page);

    const tiles = page.locator('#add-modal .cat-grid button');
    const total = await tiles.count();
    expect(total).toBeGreaterThan(0);

    const search = page.locator('#add-search');
    const empty = page.locator('#add-empty');
    const boxTile = page.locator('#add-modal [data-add="box"]');

    // Type 'box' → only matching tiles remain visible, the rest are hidden.
    await search.fill('box');
    await page.waitForFunction(
      (n) => {
        const all = [...document.querySelectorAll('#add-modal .cat-grid button')];
        return all.filter((b) => !b.classList.contains('add-hide')).length < n;
      },
      total,
      { timeout: 5000 },
    );

    const shown = await page.$$eval('#add-modal .cat-grid button', (els) =>
      els.filter((b) => !b.classList.contains('add-hide')).map((b) => b.textContent.trim()),
    );
    expect(shown.length, 'some tiles match "box"').toBeGreaterThan(0);
    expect(shown.length, 'not every tile matches "box"').toBeLessThan(total);
    // Every visible tile actually contains the query; the box tile is one of them.
    for (const label of shown) {
      expect(label.toLowerCase()).toContain('box');
    }
    await expect(boxTile).toBeVisible();
    await expect(empty).toBeHidden();

    // Clear → all tiles visible again, empty state stays hidden.
    await search.fill('');
    await page.waitForFunction(
      (n) => {
        const all = [...document.querySelectorAll('#add-modal .cat-grid button')];
        return all.filter((b) => !b.classList.contains('add-hide')).length === n;
      },
      total,
      { timeout: 5000 },
    );
    await expect(empty).toBeHidden();
    const visibleAfterClear = await page.$$eval(
      '#add-modal .cat-grid button',
      (els) => els.filter((b) => !b.classList.contains('add-hide')).length,
    );
    expect(visibleAfterClear).toBe(total);

    // Nonsense query → no matches, #add-empty becomes visible.
    await search.fill('zzzqqqnope');
    await expect(empty).toBeVisible();
    const visibleNonsense = await page.$$eval(
      '#add-modal .cat-grid button',
      (els) => els.filter((b) => !b.classList.contains('add-hide')).length,
    );
    expect(visibleNonsense, 'no tiles match nonsense query').toBe(0);

    await closeAddGallery(page);
  });

  test('import tile is present and clicking it does not error', async ({ page }) => {
    const errors = collectConsoleErrors(page);

    // The hidden file input that the import tile triggers must exist.
    await expect(page.locator('#stl-file')).toHaveCount(1);

    await openAddGallery(page);
    const importBtn = page.locator('#modal-import');
    await expect(importBtn).toBeVisible();

    // Clicking opens a native file chooser; intercept it so nothing hangs, and
    // do NOT pick a file. The handler also closes the modal.
    page.on('filechooser', (chooser) => chooser.setFiles([]).catch(() => {}));
    await importBtn.click();
    await expect(page.locator('#add-modal')).toBeHidden();

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('sketch tile starts sketch mode and cancel exits it', async ({ page }) => {
    await openAddGallery(page);
    await page.locator('#add-sketch').click();

    // Sketch start closes the modal and reveals the sketch bar.
    await expect(page.locator('#add-modal')).toBeHidden();
    const bar = page.locator('#sketch-bar');
    await expect(bar).toBeVisible();
    await page.waitForFunction(() => window.__forgeApp.viewport?._sketch?.on === true, null, {
      timeout: 5000,
    });

    // Cancel hides the sketch bar again and leaves sketch mode.
    await page.locator('#sketch-cancel').click();
    await expect(bar).toBeHidden();
    await page.waitForFunction(() => !window.__forgeApp.viewport?._sketch?.on, null, {
      timeout: 5000,
    });
  });
});
