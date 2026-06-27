import { defineConfig, devices } from '@playwright/test';

// End-to-end tests drive the real app in headless Chromium (WebGL via
// SwiftShader). Tests load with `?nosw` to bypass the PWA service worker
// and assert against `window.__forgeApp` state where possible.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: false,
  // Each test boots a manifold-3d WASM kernel + a SwiftShader WebGL context, so
  // across a long full-suite run the machine saturates and an occasional
  // recompile/render overruns a per-step wait budget (the same test then passes
  // on its own in isolation). These are environmental flakes, not logic races,
  // so one retry recovers them — a genuine failure still fails every attempt,
  // and any retried test is reported as "flaky" rather than hidden. (No CI here,
  // so the local branch must be non-zero or these surface as hard failures.)
  retries: process.env.CI ? 2 : 1,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
