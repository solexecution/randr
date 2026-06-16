import { defineConfig } from 'vite';

export default defineConfig({
  // '/' for local dev; the Pages build sets FORGE_BASE=./ so assets resolve
  // under the project subpath (https://user.github.io/forge-cad/).
  base: process.env.FORGE_BASE || '/',
  // manifold-3d ships its own .wasm and uses top-level await; let vite serve it
  // as-is rather than pre-bundling, which mangles the wasm locateFile path.
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // keep the wasm as a separate cacheable file
  },
  server: {
    port: 5173,
    host: true,
  },
});
