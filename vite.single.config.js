import { defineConfig } from 'vite';

// Build for the standalone single-file Forge-CAD.html: no code-splitting, so the
// whole app (the wasm kernel is already inlined as base64 in the JS) collapses
// into ONE js + ONE css. build-standalone.mjs then folds those — plus the
// fonts — into a single self-contained HTML you can open from a file manager.
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: {
    target: 'es2022',
    outDir: 'dist-single',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'asset-[name][extname]',
      },
    },
  },
});
