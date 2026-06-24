import { test, expect } from '@playwright/test';
import {
  gotoApp,
  ensureBuildMode,
  addShape,
  partCount,
  collectConsoleErrors,
} from './_helpers.js';

// Project management (save / save-as / new / open / rename / delete) and the
// mesh exports (STL / OBJ / 3MF / Bambu), driven through the real UI.
//
// HARD APP RULE under test: the app must NEVER use native browser dialogs.
// Save-as and rename go through the in-page #name-modal; deletes use a
// two-click in-page confirm on the row's [data-del] button. Every test arms a
// page.on('dialog') guard so any stray native alert/confirm/prompt fails the run.

/** Fail loudly if the app ever pops a native alert/confirm/prompt. */
function forbidNativeDialogs(page) {
  const seen = [];
  page.on('dialog', async (d) => {
    seen.push(`${d.type()}: ${d.message()}`);
    await d.dismiss().catch(() => {});
  });
  return seen;
}

/** Open the ☰ app menu (its items live in a display:none .menu-pop until open). */
async function openAppMenu(page) {
  await page.click('#app-btn');
  await expect(page.locator('#app-menu')).toHaveClass(/open/);
  await expect(page.locator('#proj-save')).toBeVisible();
}

/** Read the persisted projects index from localStorage. */
function readIndex(page) {
  return page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('randr.index') || '[]'); } catch { return []; }
  });
}

/** Whether a randr.project.<id> blob exists in localStorage. */
function projectBlobExists(page, id) {
  return page.evaluate((pid) => localStorage.getItem(`randr.project.${pid}`) !== null, id);
}

const currentProjectId = (page) => page.evaluate(() => window.__forgeApp.project?.id ?? null);
const currentProjectName = (page) => page.evaluate(() => window.__forgeApp.project?.name ?? null);

test.describe('project management', () => {
  test('Save persists the project to localStorage (index + blob + current)', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');

    const id = await currentProjectId(page);
    expect(id, 'app should have a current project after boot').toBeTruthy();

    await openAppMenu(page);
    await page.click('#proj-save');

    // randr.current points at this project, the index lists it, and its blob exists.
    const current = await page.evaluate(() => localStorage.getItem('randr.current'));
    expect(current).toBe(id);

    const index = await readIndex(page);
    expect(index.some((p) => p.id === id)).toBe(true);

    expect(await projectBlobExists(page, id)).toBe(true);
    expect(dialogs, 'no native dialogs allowed').toEqual([]);
  });

  test('Ctrl+S saves the current project', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'cylinder');

    const id = await currentProjectId(page);
    // Clear randr.current to prove the save handler re-sets it.
    await page.evaluate(() => localStorage.removeItem('randr.current'));

    await page.keyboard.press('Control+s');

    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('randr.current')))
      .toBe(id);
    expect(await projectBlobExists(page, id)).toBe(true);
    expect(dialogs).toEqual([]);
  });

  test('Save As uses the in-page #name-modal (not a native prompt) and creates the project', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');

    const prevId = await currentProjectId(page);
    const name = `SaveAs ${Date.now()}`;

    await openAppMenu(page);
    await page.click('#proj-saveas');

    // The in-page modal must appear — proves no native prompt() was used.
    const modal = page.locator('#name-modal');
    await expect(modal).toBeVisible();
    await expect(modal).not.toHaveClass(/hidden/);

    await page.fill('#name-input', name);
    await page.click('#name-ok');

    // Modal closes, app switches to the new project with the typed name.
    await expect(modal).toBeHidden();
    await expect.poll(() => currentProjectName(page)).toBe(name);

    const newId = await currentProjectId(page);
    expect(newId).not.toBe(prevId); // save-as forks a brand-new project

    const index = await readIndex(page);
    expect(index.some((p) => p.id === newId && p.name === name)).toBe(true);
    expect(await projectBlobExists(page, newId)).toBe(true);
    expect(dialogs).toEqual([]);
  });

  test('New creates a fresh empty project context', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');
    expect(await partCount(page)).toBeGreaterThan(0);

    const beforeId = await currentProjectId(page);

    await openAppMenu(page);
    await page.click('#proj-new');

    // Fresh project: new id, empty build tree.
    await expect.poll(() => currentProjectId(page)).not.toBe(beforeId);
    await expect.poll(() => partCount(page)).toBe(0);

    const newId = await currentProjectId(page);
    expect(await projectBlobExists(page, newId)).toBe(true);
    expect(dialogs).toEqual([]);
  });

  test('Open manager lists projects and opening a row loads it', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);

    // Make two distinct projects so the manager has a row to switch to.
    const nameA = `Mgr A ${Date.now()}`;
    const nameB = `Mgr B ${Date.now()}`;
    await addShape(page, 'box');
    await saveAs(page, nameA);
    const idA = await currentProjectId(page);
    await addShape(page, 'cylinder');
    await saveAs(page, nameB);
    const idB = await currentProjectId(page);
    expect(idB).not.toBe(idA);

    // Open the manager modal.
    await openAppMenu(page);
    await page.click('#proj-open');
    const modal = page.locator('#proj-modal');
    await expect(modal).toBeVisible();

    // Rows are present for both projects.
    await expect(page.locator(`#proj-list [data-pid="${idA}"]`)).toBeVisible();
    await expect(page.locator(`#proj-list [data-pid="${idB}"]`)).toBeVisible();

    // Open project A from its row; the manager closes and A becomes current.
    await page.click(`#proj-list [data-open="${idA}"]`);
    await expect(modal).toBeHidden();
    await expect.poll(() => currentProjectId(page)).toBe(idA);
    await expect.poll(() => currentProjectName(page)).toBe(nameA);
    expect(dialogs).toEqual([]);
  });

  test('Rename from the manager uses the in-page modal', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');

    const original = `Rename me ${Date.now()}`;
    await saveAs(page, original);
    const id = await currentProjectId(page);

    await openAppMenu(page);
    await page.click('#proj-open');
    await expect(page.locator('#proj-modal')).toBeVisible();

    // Click the row's rename (✎) -> the in-page #name-modal opens (not prompt()).
    await page.click(`#proj-list [data-rename="${id}"]`);
    const modal = page.locator('#name-modal');
    await expect(modal).toBeVisible();

    const renamed = `Renamed ${Date.now()}`;
    await page.fill('#name-input', renamed);
    await page.click('#name-ok');
    await expect(modal).toBeHidden();

    // The open project's name updates and the index reflects it.
    await expect.poll(() => currentProjectName(page)).toBe(renamed);
    const index = await readIndex(page);
    expect(index.find((p) => p.id === id)?.name).toBe(renamed);
    expect(dialogs).toEqual([]);
  });

  test('Delete from the manager uses a two-click in-page confirm (no native dialog)', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);

    // Create a throwaway project, then a second one so deleting the first leaves
    // the app in a clean state (the open project, if deleted, falls back anyway).
    await addShape(page, 'box');
    const victimName = `Delete me ${Date.now()}`;
    await saveAs(page, victimName);
    const victimId = await currentProjectId(page);
    await addShape(page, 'cylinder');
    await saveAs(page, `Keeper ${Date.now()}`);

    await openAppMenu(page);
    await page.click('#proj-open');
    await expect(page.locator('#proj-modal')).toBeVisible();

    const delBtn = page.locator(`#proj-list [data-del="${victimId}"]`);
    await expect(delBtn).toBeVisible();

    // First click arms the in-page confirm state (text -> "sure?"); it does NOT
    // delete yet and does NOT open a native confirm().
    await delBtn.click();
    await expect(delBtn).toHaveText(/sure/i);
    await expect(delBtn).toHaveClass(/confirm/);
    expect((await readIndex(page)).some((p) => p.id === victimId)).toBe(true);

    // Second click confirms the delete -> the project leaves the index + blob.
    await page.locator(`#proj-list [data-del="${victimId}"]`).click();
    await expect
      .poll(() => readIndex(page).then((idx) => idx.some((p) => p.id === victimId)))
      .toBe(false);
    expect(await projectBlobExists(page, victimId)).toBe(false);
    expect(dialogs, 'delete must use the in-page confirm, never a native dialog').toEqual([]);
  });
});

test.describe('exports', () => {
  // Open the ☰ menu, reveal the Export fly-out, then click the export button and
  // capture the resulting download in one shot.
  async function exportDownload(page, buttonSel) {
    await openAppMenu(page);
    await page.hover('#export-fly');
    await expect(page.locator(buttonSel)).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click(buttonSel),
    ]);
    return download;
  }

  test('STL export downloads part.stl', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');

    const dl = await exportDownload(page, '#btn-stl');
    expect(dl.suggestedFilename()).toBe('part.stl');
    expect(dialogs).toEqual([]);
  });

  test('OBJ export downloads part.obj', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');

    const dl = await exportDownload(page, '#btn-obj');
    expect(dl.suggestedFilename()).toBe('part.obj');
    expect(dialogs).toEqual([]);
  });

  test('3MF export downloads part.3mf', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');

    const dl = await exportDownload(page, '#btn-3mf');
    expect(dl.suggestedFilename()).toBe('part.3mf');
    expect(dialogs).toEqual([]);
  });

  test('Bambu export downloads a .3mf (named after the project)', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');

    const dl = await exportDownload(page, '#btn-bambu');
    // Bambu export names the file after the current project (sanitized) + .3mf.
    expect(dl.suggestedFilename()).toMatch(/\.3mf$/);
    expect(dialogs).toEqual([]);
  });
});

test.describe('edit / result view', () => {
  test('the Result segment previews the merged solid and back, with no console errors (colors kept)', async ({ page }) => {
    const dialogs = forbidNativeDialogs(page);
    const errors = collectConsoleErrors(page);
    await gotoApp(page);
    await ensureBuildMode(page);
    await addShape(page, 'box');

    await expect(page.locator('#mode-seg')).toBeVisible();
    expect(await page.evaluate(() => window.__forgeApp.viewMode)).toBe('edit');

    // build -> result: the merged solid renders via setColoredModel (per-part colors).
    await page.click('#seg-result');
    await expect.poll(() => page.evaluate(() => window.__forgeApp.viewMode)).toBe('result');
    await expect(page.locator('body')).toHaveClass(/view-result/);
    // result is a preview — it preserves the authoring mode (no lossy code<->build flip)
    expect(await page.evaluate(() => window.__forgeApp.mode)).toBe('build');

    // result -> build (edit): the preview class clears.
    await page.click('#seg-build');
    await expect.poll(() => page.evaluate(() => window.__forgeApp.viewMode)).toBe('edit');
    await expect(page.locator('body')).not.toHaveClass(/view-result/);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
    expect(dialogs).toEqual([]);
  });

  test('Import… in the ☰ menu opens the file picker (next to Export)', async ({ page }) => {
    await gotoApp(page);
    await openAppMenu(page);
    await expect(page.locator('#menu-import')).toBeVisible();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('#menu-import'),
    ]);
    expect(chooser).toBeTruthy();
  });
});

// --- shared local helper ----------------------------------------------------
// Save-as via the in-page modal (used by several manager tests). Asserts the
// modal path so every save-as in this suite also proves no native prompt.
async function saveAs(page, name) {
  await openAppMenu(page);
  await page.click('#proj-saveas');
  const modal = page.locator('#name-modal');
  await expect(modal).toBeVisible();
  await page.fill('#name-input', name);
  await page.click('#name-ok');
  await expect(modal).toBeHidden();
  await expect.poll(() => currentProjectName(page)).toBe(name);
}
