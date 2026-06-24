import { test, expect } from '@playwright/test';
import { gotoApp, ensureBuildMode, collectConsoleErrors } from './_helpers.js';

// The left tool strip is draggable/dockable and user-customizable. Layout +
// dock persist in randr.toolbar. Tools are re-parented (handlers survive), so
// these guard both the movement and that relocated tools still fire.

test('toolbar floats, docks to an edge, and persists', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await gotoApp(page);

  const tools = page.locator('#tools');
  await expect(tools).toHaveClass(/dock-left/); // default

  const gb = await page.locator('#tools-grip').boundingBox();
  const vw = await page.evaluate(() => window.innerWidth);
  await page.mouse.move(gb.x + 6, gb.y + gb.height / 2); // grab the grip dots, not the ✎
  await page.mouse.down();
  await page.mouse.move(gb.x + 250, gb.y + 120, { steps: 10 });
  await page.mouse.move(vw - 24, gb.y + 120, { steps: 10 }); // drag to the right edge
  await page.mouse.up();

  await expect(tools).toHaveClass(/dock-right/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('randr.toolbar')).dock)).toBe('right');

  await page.reload();
  await page.waitForFunction(
    () => !!window.__forgeApp && document.querySelector('#boot')?.classList.contains('gone'),
  );
  await expect(tools).toHaveClass(/dock-right/);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('toolbar renders from layout, groups open, relocated tools still work', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await gotoApp(page);
  await ensureBuildMode(page);

  for (const id of ['rail-home', 'v-grid', 'v-snap', 'v-theme']) {
    await expect(page.locator(`#tools-body > #${id}`)).toHaveCount(1); // top-level buttons
  }
  // the curve-quality control is a top-level button (the gear dropdown is gone)
  await expect(page.locator('#tools-body > #v-quality')).toHaveCount(1);
  // the code panel + mode toggles left the floating bar for the top-bar control
  await expect(page.locator('#tools-body > #panel-toggle, #tools-body > #mode-toggle')).toHaveCount(0);

  const group = page.locator('#tools-body .tb-group');
  await expect(group).toHaveCount(1); // default "More" group
  await expect(group.locator('#v-measure')).toHaveCount(1); // print tools live inside it

  // relocated tool inside a group still fires
  await group.locator('.rail-btn').first().click();
  await expect(group).toHaveClass(/open/);
  await group.locator('#v-measure').click();
  await expect.poll(() => page.evaluate(() => window.__forgeApp.measureMode)).toBe(true);

  // relocated top-level tool still fires
  const before = await page.evaluate(() => document.querySelector('#v-grid').classList.contains('on'));
  await page.locator('#tools-body > #v-grid').click();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('#v-grid').classList.contains('on')))
    .toBe(!before);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('customize modal edits the bar and persists', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await gotoApp(page);
  await ensureBuildMode(page);

  await page.click('#tools-edit');
  await expect(page.locator('#toolbar-modal')).toBeVisible();

  // turn a tool OFF → gone from the bar
  await page.locator('.tbm-place[data-id="v-theme"]').selectOption('off');
  await expect(page.locator('#tools-body #v-theme')).toHaveCount(0);

  // new group → one more group in the layout
  const gBefore = await page.evaluate(() => window.__forgeApp.toolbar.layout.filter((e) => e.type === 'group').length);
  await page.locator('.tbm-newgroup').click();
  await expect
    .poll(() => page.evaluate(() => window.__forgeApp.toolbar.layout.filter((e) => e.type === 'group').length))
    .toBe(gBefore + 1);

  // assign a tool into the new group
  const newGid = await page.evaluate(() => {
    const gs = window.__forgeApp.toolbar.layout.filter((e) => e.type === 'group');
    return gs[gs.length - 1].gid;
  });
  await page.locator('.tbm-place[data-id="v-grid"]').selectOption('g:' + newGid);
  await expect
    .poll(() => page.evaluate((gid) => window.__forgeApp.toolbar.layout.find((e) => e.gid === gid)?.items.includes('v-grid'), newGid))
    .toBe(true);

  // persists across reload
  await page.reload();
  await page.waitForFunction(() => !!window.__forgeApp && document.querySelector('#boot')?.classList.contains('gone'));
  await expect(page.locator('#tools-body > #v-theme')).toHaveCount(0);
  expect(await page.evaluate(() => window.__forgeApp.toolbar.layout.some((e) => e.type === 'group' && (e.items || []).includes('v-grid')))).toBe(true);

  // reset restores the default bar
  await page.click('#tools-edit');
  await page.click('#toolbar-reset');
  await expect(page.locator('#tools-body > #v-theme')).toHaveCount(1);
  expect(await page.evaluate(() => window.__forgeApp.toolbar.layout.some((e) => e.gid === 'g-more'))).toBe(true);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('an empty group is not shown on the bar (no stranded box)', async ({ page }) => {
  await gotoApp(page);
  await ensureBuildMode(page);

  // an empty group must not render a button or a stray menu-pop
  await page.evaluate(() => {
    const a = window.__forgeApp;
    a.toolbar.layout = [
      { type: 'tool', id: 'rail-home' },
      { type: 'group', gid: 'gx', label: 'More', glyph: '⋯', items: [] },
    ];
    a.toolbar.render();
  });
  await expect(page.locator('#tools-body .tb-group')).toHaveCount(0);
  await expect(page.locator('#tools-body .menu-pop')).toHaveCount(0);
});

test('an opened group is a compact icon grid, not a tall text list', async ({ page }) => {
  await gotoApp(page); // pro → the default "More" group has all 8 print tools
  await ensureBuildMode(page);
  const group = page.locator('#tools-body .tb-group');
  await group.locator('.rail-btn').first().click();
  await expect(group).toHaveClass(/open/);

  const pop = group.locator('.menu-pop');
  // tools render as icon buttons (~38px), not full-width text rows (the bug: ~142px)
  const w = await pop.locator('#v-measure').evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeLessThan(60);
  // and the popup stays compact rather than a tall list that overflows the viewport
  const h = await pop.evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeLessThan(220);
});

test('the top-bar segmented control switches code/build; the old bar toggles are gone', async ({ page }) => {
  await gotoApp(page); // pro, build
  await ensureBuildMode(page);

  // the floating-bar mode + view toggles were replaced by the top-bar control
  await expect(page.locator('#mode-toggle, #view-mode-toggle')).toHaveCount(0);

  const code = page.locator('#seg-code');
  const build = page.locator('#seg-build');
  await expect(page.locator('#mode-seg')).toBeVisible();

  // the active segment fills (.on); switching flips both the mode and the highlight
  await expect.poll(() => page.evaluate(() => window.__forgeApp.mode)).toBe('build');
  await expect(build).toHaveClass(/on/);

  await code.click();
  await expect.poll(() => page.evaluate(() => window.__forgeApp.mode)).toBe('code');
  await expect(code).toHaveClass(/on/);
  await expect(build).not.toHaveClass(/on/);

  await build.click();
  await expect.poll(() => page.evaluate(() => window.__forgeApp.mode)).toBe('build');
  await expect(build).toHaveClass(/on/);
});

test('the tier system is gone — no tier switch anywhere', async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator('[data-seg-tier], #tier-switch, #tier-toggle')).toHaveCount(0);
});
