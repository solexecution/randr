# R&R — Project Status

_Snapshot for resuming work. Last updated 2026-06-20._

> **R&R** is an offline-first, tablet-first, Tinkercad-style **parametric CAD for 3D printing** (Bambu A1 mini target). Watertight **manifold-3d** (WASM) kernel + **three.js** + **Vite**. Goal: go *beyond* Tinkercad — no-limits design for makers, with a Simple→Pro spectrum.
>
> - **Display name:** "R&R". **Everything internal stays `randr`** — repo `solexecution/randr`, live <https://solexecution.github.io/randr/>, standalone `RandR.html`, and **localStorage keys `randr.*`** (don't rename — would orphan saved projects/settings/tier).
> - **Local folder:** `C:\Users\MarosKuzmiak\Desktop\3d\forge-cad` (folder kept as `forge-cad`; internal ids `ForgeError`, `window.__forgeApp/__forgeExport/__dbg` unchanged).

---

## Run / build / deploy

```bash
cd forge-cad
npm install
npm run dev                 # Vite dev server :5173
npm run build               # → dist/ (catch errors here)
FORGE_BASE=./ npm run build:single   # → standalone RandR.html (single offline file)
```
Deploy = **push to `main`** → GitHub Pages Action builds + publishes. PWA (service worker) caches for offline; it's installable.

**Debug/scripting hooks (in the running app):**
- `window.__forgeApp` — the App instance.
- `window.__dbg = { src, compile, meshSolid, importSTL, importOBJ, import3MF, registerSolid, coloredParts }`
- `window.__forgeExport = { exportSTL, export3MF, export3MFColored, exportOBJ, build3MF }`
- `window.__recipes` — the (deferred) Simple-mode recipe catalogue.

---

## Architecture (key files)

| File | Role |
|---|---|
| `src/kernel/manifold.js` | Kernel wrapper: all primitives, booleans, `extrude`/`revolve`, fillet/chamfer (minkowski), `bisect`, curve quality, STL/OBJ/3MF import. |
| `src/kernel/export.js` | STL / OBJ / 3MF export (+ per-part colored 3MF for AMS). |
| `src/lang/` | The "Forge" code language: `tokenizer.js` → `parser.js` → `evaluator.js`. |
| `src/ui/app.js` | **Main controller (large).** Render/markup, build-tree editing, tiers, command palette, modals, print-prep, projects, undo, toasts, sketch UI. |
| `src/ui/viewport.js` | three.js viewport: custom orbit/touch controls, picking/drag, gizmo, edit meshes, measure, overhang, layer preview, build-volume box, **nav widget (cube+arrows+home+axis)**, **sketch interaction**. |
| `src/ui/buildtree.js` | Build-node DEFS, `buildTreeToSource`, modifiers (clearance/hollow/fillet), metric sizes, colored parts. |
| `src/ui/importBuild.js` | `sourceToNodes` — code → build-tree importer (round-trips). |
| `src/ui/projects.js` | localStorage project store. |
| `src/ui/recipes.js` | **Deferred** Simple-mode "makes" scaffold (1 recipe, only a test hook — see below). |
| `src/ui/styles.css` | All styling. |
| `MOST_WANTED_FEATURES.md` | Researched top-20 backlog with evidence + apply order. |

**Coordinate frame gotcha:** manifold is Z-up; three.js is Y-up (the `editGroup` applies the −90° X rotation). `box()`/`cylinder()` are **centered** (top at z=h/2, not z=h) — a recurring bug source. Build-mode primitives sit base-on-plate via `baseHalfHeight`.

---

## Implemented ✅

**Modeling core**
- Dual workflow: a parametric **code** language *and* a **build pane** (Tinkercad-style part tree) — same kernel, round-trip both ways.
- **~26 primitives:** box, cylinder, sphere, cone, pyramid, torus, wedge, dome, slot, star, roundedBox, roundedCylinder, chamferedBox, chamferedCylinder, tube, prism, gear, counterbore, countersink, insertHole, nutTrap, keyhole, text(3D), thread, bolt, nut.
- **Sketch → extrude & revolve** (draw a polygon on the ground plane → solid; revolve into a lathe solid) with **corner-rounding** for curved profiles. Editable `extrusion`/`revolution` parts; round-trip through code.
- **Booleans / groups:** union, difference (solid/hole), intersection, **hull**; per-group scoped holes; group-mode toolbar.
- **Modifiers:** fit clearance (press-fit), **hollow/shell** to a wall thickness, **fillet/chamfer** (round-all-edges via minkowski), metric fastener sizes (M2–M12).

**Manipulation**
- Move/rotate/scale **gizmo** (W/E/R) + one-finger touch drag; **magnetic drag-snap** + grid snap (1 mm / 15°); arrow-key nudge.
- Mirror/flip, **linear & polar arrays**, **align** (min/center/max per axis), place ops (drop/center/level/1:1/stack), **place-on-face**, **movable workplanes**.
- Multi-select; group/ungroup; per-part color (swatch + hex); lock/hide; collapse; duplicate (clones all props incl. sketch points); change-type; delete.
- **Undo/redo** (selection-preserving) + autosave.

**Experience tiers** (this session)
- **Simple / Maker / Pro** progressive disclosure via one `.tier-*` class; first-run chooser; persisted in `randr.tier`; switch-safety (code-only design falling back to Maker). Pro = everything; Maker = full builder + code, minus measure/layers; Simple = pick-and-size (no code/booleans/coords; friendly Add gallery; simplified cards).

**Navigation / UI** (this session)
- **Command palette** (Ctrl+K, ⌕): 63 commands, fuzzy filter, keyboard nav (Maker/Pro).
- **Navigation widget** (top-right): FreeCAD-style **ViewCube** (face/edge/corner snap + hover highlight) + **rotate-arrow ring** + **Home** + **Blender-style axis gizmo** (X/Y/Z balls).
- **Add modal:** search box + collapsible categories + wrapped labels + dense 6-col grid.
- Tap-to-dismiss toasts (length-scaled duration); context-menu submenus open on a single tap.

**Tablet-first UI overhaul** (latest session)
- **Consolidated top bar:** logo · project name (**click to rename**) · **☰ app menu** (Project / **Templates▸** / **Export▸** fly-out submenus) · **⚙ gear** (mode · level · view) · **▤ parts toggle** · **+ add** · ⌕ ↶ ↷ ⤢ — all left-aligned for max canvas. (Retired the old separate File/Templates/Export bar menus.)
- **Parts panel = collapsible sidebar** (`#part-card`): docks **left/right** (drag header or **▣**), collapses off its edge via the top-bar **▤** or a **canvas tap**, reopen from **▤**; persists in `randr.cardDock` `{mode,collapsed}`. Compact rows: select · colour · name · solid/hole · lock · hide · duplicate · remove · **G** group badge. (Replaced the inline per-row editor.)
- **Per-part editor = standalone modal** (`#part-modal`): opens as a popover that **grows from the tapped row**; holds the full editor (dims / pos / rot / colour / fit / fillet / size), per-part actions, the **align/group/array/place/flip tools** (moved here from the retired floating ⛭ dock), and a size **metric**. Multi-select shows the tools with an "N selected" summary.
- **Readout** moved to the **top-right corner** with the status dot folded into its header; **nav-cube fixed just below it**.
- **Multi-select on touch:** long-press a part in the scene to arm additive select; tap empty to finish (plus the per-row select toggles).
- _Note:_ canvas-tap auto-collapse currently fires on **any** canvas tap (incl. selecting a part) — could be scoped to empty-space taps if desired.

**Print prep**
- Build-volume fit warning (180³), scale-to-fit, **cut-in-half** (two glue-able pieces), auto-orient (least support), overhang highlight, layer preview, curve-quality (Draft/Standard/Smooth/Ultra). _(Cut/overhang return you to edit view when toggled off.)_

**Files**
- Export **STL / OBJ / 3MF** (+ **multi-color 3MF** for AMS). Import **STL / OBJ / 3MF** (round-trip verified) + explode/decompose. Local **projects** (save/open/autosave/restore incl. imported meshes + sketch points).

**Other**
- Code-mode syntax highlighting, param sliders, caret→object highlight, resizable editor. Measure tool (distance, pinnable). Engrave text on a face. HUD readout (size/volume/mesh/state/fit/filament). Templates (soap dish, pen cup, coaster, stacking bin, bolt & nut, washer, L-bracket, knob, fit test). PWA offline + installable.

---

## Partial / next-up ⚠️

- **Sketch v3** — only straight polygons + corner-rounding so far. Missing: **freeform arc/spline segments**, **dimensional constraints**, **sketching on an arbitrary face** (the `this.workplane` infra exists — finished sketches could orient onto it). _(I had started generalizing the sketch plane in `viewport.js` then reverted it — that's the natural starting point.)_
- **Per-edge fillet/chamfer selection** — currently rounds *all* convex edges; selecting specific edges is the harder milestone.
- **Touch UX polish** (#17) — have touch drag + multi-select toggle + context menu; missing face/edge **selection filters**, radial menu, even bigger hit targets.
- **Threads** — metric sizes done; dedicated internal/external **print-clearance presets** + lead-in chamfer partial.

## Missing / backlog ❌  (see `MOST_WANTED_FEATURES.md` for evidence + ranking)

- **Sweep / loft** (#10) — sweep a profile along a path / loft between two profiles. Needs new kernel work. _High value, was a candidate "big feature."_
- **Deeper STL mesh editing** (#14) — move/scale faces, simplify, repair. Largest/riskiest (manifold isn't built for vertex editing).
- **Modifier volumes** (#15) — mark a region carrying different print settings; export as 3MF modifier objects.
- **Support helpers** (#16) — blocker/enforcer volumes, custom brim, first-layer chamfer (anti-elephant-foot).
- **Visual parametric history / feature timeline** (#13) — code mode *is* a re-editable history; a build-mode timeline is missing.
- **Thin-wall printability check** (#8c) — build-volume + overhang done; wall-thickness analysis not.
- **Simple-mode recipe gallery** (#20) — tier UI done; the "pick a make + size knobs" gallery is **deferred** (scaffold below).

**Deferred / out of scope:** STEP import/export (B-rep — infeasible on a mesh kernel; tessellated STEP *import* maybe later), pure-slicer features (infill, network), cloud collaboration (R&R is offline-first/local).

---

## Deferred scaffold — `src/ui/recipes.js`

A Simple-mode **"makes" catalogue** (friendly knobs + `build(vals) → source`) was scaffolded but is **only wired as `window.__recipes`** — no UI renders it, and it has **just one recipe** (`flexiDino`). It's the truest realization of the "kid picks a thing + size, it just builds/fits" vision. To finish: render it as Simple's headline gallery + a knob panel + expand to ~6 makes. **Don't rebuild from scratch — extend the scaffold.** (The user previously chose the Add-menu-reflow approach for Simple over wiring recipes, so this stayed parked.)

---

## Known gotchas (esp. for in-browser verification)

- **Preview MCP viewport reports 0×0** → `preview_click` and **screenshots are unreliable** on this app. Verify instead via: `el.dispatchEvent(new MouseEvent('click',{bubbles:true}))` for DOM buttons; `window.__forgeApp` method calls + computed styles for state; and for **canvas** pick/drag/sketch, `preview_resize` to real dims (1280×800) + dispatch synthetic `mousedown/move/up` at a part's **projected screen position** (`editGroup.localToWorld(modelPt).project(camera)`).
- Build with `npm run build` to catch syntax errors before claiming done.
- GitHub pushes to this repo have been flaky — use a retry loop checking the real git exit code.
- After deploy, the **service worker caches** — refresh once or twice (or reopen if installed) to see changes.

---

## Recent commits (newest first)

**Tablet-first UI overhaul (latest):** `9805d10` group badge on rows · `886d372` parts toggle → top bar + canvas auto-collapse · `71fe8d7` parts sidebar (collapsible) + part popover editor + Templates/Export submenus + rename · `9a9bf63` left-aligned bar + top-right readout + parts list/modal split · `4c57c15` consolidated top bar + floating part card + long-press multi-select.

**Prior (tiers / nav / palette):** `c986e68` rename to **R&R** · `f3036e5` Add-modal density · `7ad3f16` Add-modal search/collapse/wrap · `2849941` toasts longer + tap-dismiss · `37ceb59` fix overlapping top-bar menus + readout move · `be918c6` readout reposition · `79042c4` nav widget (arrows+home+axis) · `bfd1a82` nav cube · `43facf9` context-menu submenu single-tap · `099bd67` cut/overhang no longer strand in Result view · `6cee97a` topbar tablet fit · `1d8e284` part-card collapse fix + View-tools modal · `a2de9ee` sketch v2 (revolve + curved profiles) · `3aec7b4` sketch → extrude · `5255ff3` command palette · `310a695` Simple/Maker/Pro tiers.

Full interaction sweep re-run the latest session (every top-bar menu, the parts sidebar + all row controls, the part editor modal, multi-select/group, canvas orbit/select/auto-collapse, readout, nav-cube, undo/redo, palette, snap left/right) — all green, zero console errors. No known regressions.

---

## Suggested next steps (pick one)

1. **Sweep / loft** — biggest remaining modeling gap; high value.
2. **Sketch v3** — freeform arcs + sketch-on-a-face (builds on fresh sketch code + existing workplane infra).
3. **Simple-mode recipe gallery** — finish the `recipes.js` scaffold for the kid-mode on-ramp.
4. **Touch polish** (#17) — selection filters + bigger targets, since R&R is tablet-first.
5. **Support helpers / modifier volumes** — slicer-adjacent print wins.
