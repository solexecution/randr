// Fold the single-chunk build (dist-single/) into one self-contained HTML file.
// Inlines the CSS (with woff2 fonts as data: URIs) and the JS module, strips the
// PWA manifest link. Output: RandR.html (here) and ../RandR.html (the
// copy in Desktop/3d that you open on the tablet).
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const dir = 'dist-single';
let html = readFileSync(join(dir, 'index.html'), 'utf8');

const cssTag = html.match(/<link[^>]*href="([^"]+\.css)"[^>]*>/);
const jsTag = html.match(/<script[^>]*src="([^"]+\.js)"[^>]*><\/script>/);
if (!cssTag || !jsTag) throw new Error('could not find css/js tags in dist-single/index.html');

const cssFile = cssTag[1].replace(/^\.?\//, '');
const jsFile = jsTag[1].replace(/^\.?\//, '');

// CSS, with each woff2 font inlined as a data: URI so there are no asset fetches.
let css = readFileSync(join(dir, cssFile), 'utf8');
let fontCount = 0;
css = css.replace(/url\((['"]?)([^'")]*?)([\w-]+\.woff2)\1\)/g, (_m, _q, _path, file) => {
  const b64 = readFileSync(join(dir, 'fonts', file)).toString('base64');
  fontCount++;
  return `url(data:font/woff2;base64,${b64})`;
});

// JS module (escape any literal </script> so it can live inside an inline tag).
const js = readFileSync(join(dir, jsFile), 'utf8').replace(/<\/script>/g, '<\\/script>');

// Use replacement FUNCTIONS so any `$` sequences in the JS/CSS (e.g. `$&`, `$1`)
// are inserted literally rather than interpreted as String.replace patterns.
html = html
  .replace(cssTag[0], () => `<style>${css}</style>`)
  .replace(jsTag[0], () => `<script type="module">\n${js}\n</script>`)
  .replace(/<link[^>]*rel="manifest"[^>]*>\s*/g, '');

writeFileSync('RandR.html', html);
// Also drop a copy in the parent folder (the Desktop/3d working dir) for
// convenience. Guarded — in CI the parent isn't part of the checkout.
try { writeFileSync(join('..', 'RandR.html'), html); } catch { /* not writable (CI) — fine */ }
console.log(`RandR.html written (${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB, ${fontCount} fonts inlined)`);
