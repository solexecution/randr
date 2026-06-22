import { defineConfig } from 'vitest/config';

// Unit / integration tests for the kernel, language, and pure UI modules.
// Default environment is Node (manifold-3d runs fine under Node's WASM).
// Files that need a DOM (e.g. projects.js / localStorage) opt in with a
// `// @vitest-environment jsdom` docblock at the top of the test file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.{test,spec}.{js,mjs}'],
    globals: true,
    // manifold WASM init + first compile can be slow on a cold run.
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
