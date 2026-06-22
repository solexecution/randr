// E2E coverage for the R&R (randr) CAD app shell: boot health, command palette,
// undo/redo, the view/display toggles, and the user-facing mode + tier switches.
//
// Selectors verified against src/ui/app.js:
//   - boot ready          → #boot.gone (helper waits on it)
//   - command palette      → #cmd-open ▸ #cmd-modal / #cmd-input / #cmd-list
//                            (#cmd-open is Pro-only; _openCmd() no-ops in Simple)
//   - undo / redo          → #v-undo / #v-redo (always-present FABs)
//   - grid / theme         → #v-grid (.on class) / #v-theme (html.theme-light + randr.theme)
//   - measure / layers / cut → live in the #tools-more menu (open #tools-more-btn first):
//                            #v-measure→app.measureMode, #v-layers→#layer-bar, #v-cut→app.printCut
//   - mode tabs            → [data-mode] inside #gear-menu (open via #gear-btn) → app.mode
//   - tier buttons         → #tier-switch [data-tier] inside #gear-menu → app.tier;
//                            Simple hides #cmd-open (CSS .tier-simple #cmd-open{display:none})
import { test, expect } from '@playwright/test';
import {
  gotoApp,
  partCount,
  addShape,
  ensureBuildMode,
  collectConsoleErrors,
} from './_helpers.js';

// Open the ⋯ "more tools" fly-out menu and wait for it to be on screen, so the
// measure / layers / cut buttons inside it are actually clickable.
async function openToolsMore(page) {
  await page.click('#tools-more-btn');
  await page.waitForFunction(
    () => document.querySelector('#tools-more')?.classList.contains('open'),
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

// Open the ⚙ gear menu (holds the mode tabs + tier switch) and wait for it open.
async function openGearMenu(page) {
  await page.click('#gear-btn');
  await page.waitForFunction(
    () => document.querySelector('#gear-menu')?.classList.contains('open'),
    null,
    { timeout: 5000 },
  );
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

test('mode switch via the gear-menu [data-mode] tabs', async ({ page }) => {
  await gotoApp(page);
  expect(await page.evaluate(() => window.__forgeApp.mode)).toBe('code');

  await openGearMenu(page);
  await page.click('#gear-menu [data-mode="build"]');
  await page.waitForFunction(() => window.__forgeApp.mode === 'build', null, { timeout: 5000 });

  await openGearMenu(page); // reopen — the menu collapses on click
  await page.click('#gear-menu [data-mode="code"]');
  await page.waitForFunction(() => window.__forgeApp.mode === 'code', null, { timeout: 5000 });
});

test('tier switch via the gear-menu [data-tier] buttons toggles a pro-only control', async ({ page }) => {
  await gotoApp(page); // pro
  const cmdOpen = page.locator('#cmd-open');
  await expect(cmdOpen).toBeVisible(); // visible in Pro

  await openGearMenu(page);
  await page.click('#gear-menu [data-tier="simple"]');
  await page.waitForFunction(() => window.__forgeApp.tier === 'simple', null, { timeout: 5000 });
  // Simple-only effect: the command palette button is hidden (CSS .tier-simple #cmd-open).
  await expect(cmdOpen).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.__forgeApp.root.classList.contains('tier-simple')))
    .toBe(true);

  await openGearMenu(page);
  await page.click('#gear-menu [data-tier="pro"]');
  await page.waitForFunction(() => window.__forgeApp.tier === 'pro', null, { timeout: 5000 });
  await expect(cmdOpen).toBeVisible(); // restored in Pro
});
