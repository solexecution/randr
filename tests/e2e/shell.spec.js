// E2E coverage for the R&R (randr) CAD app shell: boot health, command palette,
// undo/redo, the view/display toggles, and the user-facing mode switch.
//
// Selectors verified against src/ui/app.js:
//   - boot ready          → #boot.gone (helper waits on it)
//   - command palette      → #cmd-open ▸ #cmd-modal / #cmd-input / #cmd-list
//                            (#cmd-open opens the palette; Ctrl+K also works)
//   - undo / redo          → #v-undo / #v-redo (always-present FABs)
//   - grid / theme         → #v-grid (.on class) / #v-theme (html.theme-light + randr.theme)
//   - measure / layers / cut → live in the customizable "More" group (.tb-group):
//                            #v-measure→app.measureMode, #v-layers→#layer-bar, #v-cut→app.printCut
//   - mode toggle          → #mode-toggle button on the bar → app.mode (code/build)
//   - curve quality        → #v-quality button cycles app.curveQuality (24/48/64/128)
//   - code panel           → #panel-toggle button shows/hides #panel (docked right)
import { test, expect } from '@playwright/test';
import {
  gotoApp,
  partCount,
  addShape,
  ensureBuildMode,
  collectConsoleErrors,
} from './_helpers.js';

// Open the "More" tools group and wait for it. These tools (measure / layers /
// cut …) now live in the customizable toolbar's default "More" group (.tb-group),
// not the old #tools-more menu.
async function openToolsMore(page) {
  await page.evaluate(() => {
    const groups = [...document.querySelectorAll('#tools-body .tb-group')];
    const more = groups.find((el) => el.querySelector('button')?.title === 'More') || groups[0];
    more?.querySelector('button')?.click();
  });
  await page.waitForFunction(
    () => !!document.querySelector('#tools-body .tb-group.open'),
    null,
    { timeout: 5000 },
  );
}

// Click a control by firing its real bound click handler. The ⋯ menu-pop opens
// downward and its lower items (cut / layers) can fall below the small headless
// viewport, so a geometric click flakes; .click() on the element exercises the
// exact same wired handler without the pixel hit-test. Asserts the node exists.
async function clickEl(page, selector) {
  const ok = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector);
  expect(ok, `element not found: ${selector}`).toBe(true);
}

test('app boots clean with no console errors', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await gotoApp(page);

  expect(await page.evaluate(() => !!window.__forgeApp)).toBe(true);
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('command palette opens, filters as you type, and closes on Escape', async ({ page }) => {
  await gotoApp(page); // pro tier → #cmd-open is available
  const modal = page.locator('#cmd-modal');
  const list = page.locator('#cmd-list');

  // Opens via the ⌕ button.
  await page.click('#cmd-open');
  await expect(modal).toBeVisible();
  await expect(page.locator('#cmd-input')).toBeFocused();

  const allCount = await list.locator('.cmd-item').count();
  expect(allCount).toBeGreaterThan(0);

  // Typing filters the list (every shown row must match the query).
  await page.fill('#cmd-input', 'grid');
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('#cmd-list .cmd-item')];
    return items.length > 0 && items.every((el) => el.textContent.toLowerCase().includes('grid'));
  }, null, { timeout: 5000 });
  const filtered = await list.locator('.cmd-item').count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThanOrEqual(allCount);

  // A nonsense query yields the empty-state, not stale rows.
  await page.fill('#cmd-input', 'zzzznotacommand');
  await expect(list.locator('.cmd-empty')).toBeVisible();
  await expect(list.locator('.cmd-item')).toHaveCount(0);

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});

test('undo and redo step the build tree back and forth', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  // The buttons live in the top-left rail (one each — no leftover floating dupes).
  const placement = await page.evaluate(() => ({
    undoInLeft: !!document.querySelector('.rail-left #v-undo'),
    redoInLeft: !!document.querySelector('.rail-left #v-redo'),
    undos: document.querySelectorAll('#v-undo').length,
    redos: document.querySelectorAll('#v-redo').length,
  }));
  expect(placement).toEqual({ undoInLeft: true, redoInLeft: true, undos: 1, redos: 1 });

  const before = await partCount(page);
  await addShape(page, 'box');
  expect(await partCount(page)).toBe(before + 1);

  // Undo removes the added part.
  await page.click('#v-undo');
  await page.waitForFunction((n) => window.__forgeApp.buildTree.nodes.length === n, before, {
    timeout: 5000,
  });
  expect(await partCount(page)).toBe(before);

  // Redo restores it.
  await page.click('#v-redo');
  await page.waitForFunction((n) => window.__forgeApp.buildTree.nodes.length === n, before + 1, {
    timeout: 5000,
  });
  expect(await partCount(page)).toBe(before + 1);
});

test('grid toggle flips its .on state', async ({ page }) => {
  await gotoApp(page);
  const grid = page.locator('#v-grid');
  const wasOn = await grid.evaluate((el) => el.classList.contains('on'));

  await grid.click();
  await expect.poll(() => grid.evaluate((el) => el.classList.contains('on'))).toBe(!wasOn);

  await grid.click();
  await expect.poll(() => grid.evaluate((el) => el.classList.contains('on'))).toBe(wasOn);
});

test('theme toggle flips randr.theme and the html.theme-light class', async ({ page }) => {
  await gotoApp(page); // seeded dark
  const readTheme = () =>
    page.evaluate(() => ({
      stored: localStorage.getItem('randr.theme'),
      lightClass: document.documentElement.classList.contains('theme-light'),
    }));

  const start = await readTheme();
  await page.click('#v-theme');
  await expect.poll(readTheme).not.toEqual(start);

  const flipped = await readTheme();
  // Stored value and the class must agree on light/dark.
  expect(flipped.lightClass).toBe(flipped.stored === 'light');
  expect(flipped.stored).not.toBe(start.stored);

  // Flips back.
  await page.click('#v-theme');
  await expect.poll(readTheme).toEqual(start);
});

test('measure toggle (in the ⋯ menu) flips app.measureMode', async ({ page }) => {
  await gotoApp(page); // measure is Pro-only; pro is seeded
  await openToolsMore(page);

  expect(await page.evaluate(() => !!window.__forgeApp.measureMode)).toBe(false);
  await clickEl(page, '#v-measure');
  await page.waitForFunction(() => window.__forgeApp.measureMode === true, null, { timeout: 5000 });

  await openToolsMore(page); // menu closed itself after the click — reopen
  await clickEl(page, '#v-measure');
  await page.waitForFunction(() => window.__forgeApp.measureMode === false, null, { timeout: 5000 });
});

test('layers toggle (in the ⋯ menu) reveals #layer-bar', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);
  await addShape(page, 'box'); // need geometry to slice into layers
  const bar = page.locator('#layer-bar');
  await expect(bar).toBeHidden();

  await openToolsMore(page);
  await clickEl(page, '#v-layers');
  await expect(bar).toBeVisible({ timeout: 10000 });
  await expect.poll(() => page.evaluate(() => !!window.__forgeApp._layerMode)).toBe(true);
});

test('cut-in-half toggle (in the ⋯ menu) flips app.printCut', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);
  await addShape(page, 'box'); // give the cut something to act on
  expect(await page.evaluate(() => window.__forgeApp.printCut)).toBe(0);

  await openToolsMore(page);
  await clickEl(page, '#v-cut');
  await page.waitForFunction(() => window.__forgeApp.printCut > 0, null, { timeout: 10000 });
  expect(await page.evaluate(() => window.__forgeApp.printCut)).toBeGreaterThan(0);

  await openToolsMore(page);
  await clickEl(page, '#v-cut');
  await page.waitForFunction(() => window.__forgeApp.printCut === 0, null, { timeout: 10000 });
});

// The ⚙ gear menu was removed — its three controls (mode, curve quality, code
// panel) are now plain toolbar buttons. Mode is covered in toolbar.spec.js.
test('curve-quality button cycles Draft → Standard → Smooth → Ultra → Draft', async ({ page }) => {
  await gotoApp(page);
  const q = page.locator('#v-quality');
  await expect(q).toBeVisible();
  expect(await page.evaluate(() => window.__forgeApp.curveQuality)).toBe(64); // Smooth default
  await q.click();
  await expect.poll(() => page.evaluate(() => window.__forgeApp.curveQuality)).toBe(128); // Ultra
  await q.click();
  await expect.poll(() => page.evaluate(() => window.__forgeApp.curveQuality)).toBe(24); // wraps to Draft
});

test('code-panel button shows / hides the source panel', async ({ page }) => {
  await gotoApp(page); // boots in code mode → panel open
  const btn = page.locator('#panel-toggle');
  await expect(btn).toBeVisible();
  const collapsed = () => page.evaluate(() => document.querySelector('#panel').classList.contains('collapsed'));
  const start = await collapsed();
  await btn.click();
  await expect.poll(collapsed).toBe(!start);
  await btn.click();
  await expect.poll(collapsed).toBe(start);
});

test('the code panel is docked on the right edge (opposite the toolbar)', async ({ page }) => {
  await gotoApp(page);
  const right = await page.locator('#panel').evaluate((el) => getComputedStyle(el).right);
  expect(right).toBe('0px'); // pinned to the right
});

// (tier switching removed — the app is Pro-only now; see toolbar.spec.js)

test('code editor: scrolling the textarea keeps the highlight layer in sync', async ({ page }) => {
  await gotoApp(page); // boots in code mode — the editor is visible
  const synced = await page.evaluate(() => {
    const ed = document.querySelector('#editor');
    ed.value = Array.from({ length: 150 }, (_, i) => `// line ${i + 1}`).join('\n');
    ed.dispatchEvent(new Event('input', { bubbles: true })); // re-highlights the .editor-hl layer
    ed.scrollTop = 300;
    ed.dispatchEvent(new Event('scroll', { bubbles: true }));
    const hl = document.querySelector('.editor-hl');
    return { ed: ed.scrollTop, hl: hl.scrollTop };
  });
  expect(synced.ed).toBeGreaterThan(0); // the textarea actually scrolled
  expect(synced.hl).toBe(synced.ed);    // and the colour (highlight) layer followed it
});
