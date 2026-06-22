// Shared kernel bootstrap for unit tests that need geometry.
//
// loadKernel() uses the inlined base64 WASM (src/kernel/_wasm-inline.js) and
// passes it to ManifoldModule({ wasmBinary }), which works under Node — no
// file-path resolution or fetch needed. Call setupKernel() in a beforeAll.
import { loadKernel } from '../../src/kernel/manifold.js';

let _ready;

export function setupKernel() {
  if (!_ready) _ready = loadKernel();
  return _ready;
}
