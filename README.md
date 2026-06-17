# RandR

Offline, parametric 3D modelling for 3D printing. A workshop instrument that
runs in the browser, installs as a PWA, and works with no network once cached —
the design goal that started this: a Tinkercad/Fusion-style tool that actually
runs offline, including on an Android tablet.

Two ways to model, one watertight result:

- **Code mode** — an OpenSCAD-style parametric language. Type values or drag
  the sliders that appear for every `param`. Everything is millimetres.
- **Build mode** — Tinkercad-style: tap to drop primitives, mark each one
  *solid* or *hole*, position it. Under the hood this emits the same language,
  so a touch-built model is real, editable source.

The geometry kernel is Google's **manifold-3d** (WASM), so Booleans are
guaranteed watertight and STL/3MF exports are print-safe — no leaked
non-manifold edges that wreck a slice.

## Hosted (GitHub Pages)

Pushing to `main` builds and deploys automatically (`.github/workflows/deploy.yml`):

- **App (installable PWA):** https://solexecution.github.io/forge-cad/
- **Single-file build:** https://solexecution.github.io/forge-cad/RandR.html

On an Android tablet, open the app URL in Chrome and use **⋮ → Add to Home screen / Install app** for an offline, full-screen icon. Or just open the single-file URL.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build into dist/
npm run preview    # serve the production build
```

Everything is bundled — the WASM kernel is inlined into the JS and the two
fonts (Space Grotesk, IBM Plex Mono) are self-hosted, so there are **no CDN
calls at all**. On a production build the service worker precaches the shell +
fonts and runtime-caches the hashed app/WASM chunks, so after the first load the
app is fully offline (verified: the cache holds all 14 assets the app needs).

There is also a single-file build, `RandR.html` — the whole app (kernel,
code, fonts) inlined into one HTML file. Copy it to a device and open it
directly from the file manager; no server, no install. Best for "use it on the
tablet right now."

## The language

```
param size = 30;            // declares a slider

box(x, y, z)                // or box(size) for a cube; centered
sphere(r)
cylinder(h, r)
cone(h, r1, r2)
roundedBox(x, y, z, r)      // true filleted edges
extrude(points, height)     // 2D polygon -> solid
revolve(points, degrees)

translate([x,y,z]) { ... }  // transforms wrap a child block
rotate([x,y,z]) { ... }
scale(v) { ... }
mirror([x,y,z]) { ... }

union() { ... }             // Booleans wrap child blocks
difference() { ... }        // first child minus the rest
intersection() { ... }
hull() { ... }

// units: 5mm, 2cm, 90deg, 1.5rad   (normalised to mm / degrees)
// math: sin cos tan sqrt abs min max pow floor ceil round, PI
```

A bare list of shapes is implicitly unioned. `difference` subtracts every child
after the first from the first.

## Exports

STL (binary), 3MF (with millimetre units, the better slicer choice), and OBJ.
The live HUD shows bounding box, volume, triangle count, and a manifold check
as you edit.

## Architecture

```
src/
  kernel/      manifold wrapper, mesh->three bridge, STL/3MF/OBJ exporters
  lang/        tokenizer -> parser -> evaluator -> compile
  ui/          three.js viewport, app controller, build-tree, styles
```

The build pane and code pane both produce mini-language source, so the kernel
only ever sees one input format — a single source of truth.

## Wrapping for Android (APK)

The web build is the whole app; wrapping it is mechanical:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "RandR" com.you.randr --web-dir=dist
npm run build
npx cap add android
npx cap copy
npx cap open android      # builds the APK in Android Studio
```

Capacitor serves `dist/` from the device filesystem, so the offline behaviour
carries over directly — no code changes.
