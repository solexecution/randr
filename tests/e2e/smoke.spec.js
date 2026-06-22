import { test, expect } from '@playwright/test';

// Validates the Playwright scaffolding + that the app boots clean.
test('app boots and exposes __forgeApp with no console errors', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?nosw');
  await page.waitForFunction(() => !!window.__forgeApp, null, { timeout: 25000 });

  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
