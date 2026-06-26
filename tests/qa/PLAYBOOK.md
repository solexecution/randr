# R&R — Human QA Playbook

**Session policy:** fix-as-you-go (P0/P1 bugs fixed + committed during session)  
**Target duration:** 5 hours · **Loop interval:** 20 minutes  
**App URL:** http://localhost:5173/

Status legend: `pending` · `pass` · `fail` · `blocked` · `skip`

| ID | Workflow | Status | Last run |
|----|----------|--------|----------|
| W01 | First-time user: empty → box → move → STL export | pass | 2026-06-27 |
| W02 | Gallery sweep: add one of each primitive category | pending | — |
| W03 | Solid/hole toggle + H key on selected part | pending | — |
| W04 | Duplicate, delete, undo/redo chain | pending | — |
| W05 | Multi-select align (2 boxes, align min X) | pending | — |
| W06 | Group subtract: box minus cylinder hole | pending | — |
| W07 | Group union + intersect smoke | pending | — |
| W08 | Linear array along X (3 copies) | pending | — |
| W09 | Mirror flip X + drop-to-base | pending | — |
| W10 | Lock + hide part behavior | pending | — |
| W11 | Code mode: edit param, recompile, switch back to build | pending | — |
| W12 | Code mode: invalid syntax clears viewport | pending | — |
| W13 | Save project, New, Open manager reload | pending | — |
| W14 | Save As via name modal | pending | — |
| W15 | Rename + delete project (two-click confirm) | pending | — |
| W16 | Result view preview + back to edit | pending | — |
| W17 | Export OBJ + 3MF + Bambu 3MF | pending | — |
| W18 | Import mesh adds part (if fixture available) | pending | — |
| W19 | Toolbar customize + dock edge persist | pending | — |
| W20 | Command palette open/filter/escape | pending | — |
| W21 | Help modal open, tabs, close, a11y | pending | — |
| W22 | Grid, theme, measure, layers toggles | pending | — |
| W23 | Transform gizmo W/E/R + arrow nudge | pending | — |
| W24 | Grouped parts move together (arrow keys) | pending | — |
| W25 | Stress: add 10 parts rapidly, delete half | pending | — |
| W26 | Cut in half along Z | pending | — |
| W27 | Sketch mode start + cancel | pending | — |
| W28 | Workspace toggle edit ↔ result in build mode | pending | — |

---

## W01 — First-time user: empty → box → move → STL export
**Goal:** Core happy path for a new maker  
**Steps:**
1. New project (☰ → New) — confirm empty build tree
2. Tap + → add Box from gallery
3. Select box; set position X=10, Y=15, Z=5 via numeric fields
4. Toggle solid (should default solid)
5. ☰ → Export → STL — confirm download starts
**Pass:** No console errors; `buildTree.nodes.length >= 1`; pos values persisted; export does not throw  
**Status:** pass

## W02 — Gallery sweep: add one of each primitive category
**Goal:** Every major shape compiles  
**Steps:**
1. New project
2. From + gallery add: box, sphere, cylinder, cone, torus, wedge, tube (skip import/sketch)
3. After each add, wait for compile; check status bar not error
4. Result view — merged preview loads
**Pass:** 7 parts, no compile errors, result view shows geometry  
**Status:** pending

## W03 — Solid/hole toggle + H key
**Goal:** Boolean role assignment works  
**Steps:**
1. New project, add box + cylinder overlapping
2. Select cylinder; click hole op button; verify `op === 'hole'`
3. Press H on box — toggles solid/hole
**Pass:** op toggles; model recompiles without error  
**Status:** pending

## W04 — Duplicate, delete, undo/redo chain
**Goal:** History integrity  
**Steps:**
1. Add box; duplicate via clone button and Ctrl+D (two dupes)
2. Delete one part
3. Undo twice, redo once
4. Part count matches expected at each step
**Pass:** Counts correct; no console errors  
**Status:** pending

## W05 — Multi-select align (2 boxes, align min X)
**Goal:** Align bar works  
**Steps:**
1. Add two boxes at different X positions
2. Enable multi-select (⊹); select both
3. Align X min
4. Both share same min X bound
**Pass:** Positions aligned within 0.01mm  
**Status:** pending

## W06 — Group subtract: box minus cylinder hole
**Goal:** Realistic printable part with hole  
**Steps:**
1. Box 40×40×10 at origin
2. Cylinder r=5 h=20 centered; mark hole
3. Multi-select; group; set combine subtract
4. Result view — single merged solid with through-hole
**Pass:** groupMode subtract; result compiles; no NaN in HUD  
**Status:** pending

## W07 — Group union + intersect smoke
**Goal:** Other combine modes compile  
**Steps:**
1. Two overlapping boxes; group union → result OK
2. New project; two boxes; group intersect → result OK
**Pass:** Both modes compile without error  
**Status:** pending

## W08 — Linear array along X (3 copies)
**Goal:** Array tool  
**Steps:**
1. Single box; multi-select not needed — select box
2. Array linear X, count 3, spacing 25
3. Part count increases by 2
**Pass:** 3 copies spaced ~25mm apart  
**Status:** pending

## W09 — Mirror flip X + drop-to-base
**Goal:** Placement helpers  
**Steps:**
1. Add box; raise Z; drop-to-base — Z min on plate
2. Mirror flip X — scale.x sign flips
**Pass:** Both operations update node state  
**Status:** pending

## W10 — Lock + hide part behavior
**Goal:** Part visibility/lock flags  
**Steps:**
1. Add two parts; lock one; try to nudge locked — should not move
2. Hide one; verify hidden flag; show again
**Pass:** locked/hidden flags respected  
**Status:** pending

## W11 — Code mode: edit param, recompile, switch back to build
**Goal:** Mode switch preserves model  
**Steps:**
1. Add box in build; switch to code
2. Change a dimension in code; verify compile
3. Switch back to build — part still present
**Pass:** No data loss; compile success  
**Status:** pending

## W12 — Code mode: invalid syntax clears viewport
**Goal:** Error handling (recent fix)  
**Steps:**
1. Code mode with valid model visible
2. Introduce syntax error (delete a brace)
3. Viewport clears; error shown; fix syntax — model returns
**Pass:** Stale model not shown during error  
**Status:** pending

## W13 — Save project, New, Open manager reload
**Goal:** Project persistence  
**Steps:**
1. Add distinctive part; Save (Ctrl+S)
2. New empty project
3. Open manager; open saved project — part restored
**Pass:** Part kind/count match after reload  
**Status:** pending

## W14 — Save As via name modal
**Goal:** Named project creation  
**Steps:**
1. Add part; Save As "QA-Test-Project"
2. Manager lists new name
**Pass:** Project appears in list  
**Status:** pending

## W15 — Rename + delete project (two-click confirm)
**Goal:** Manager CRUD  
**Steps:**
1. Create throwaway project via Save As
2. Rename in manager
3. Delete with two-click confirm
**Pass:** Rename sticks; delete removes from list  
**Status:** pending

## W16 — Result view preview + back to edit
**Goal:** Merged preview workflow  
**Steps:**
1. Two parts; switch workspace to Result
2. Preview renders; switch back to Edit
3. No console errors
**Pass:** viewMode toggles cleanly  
**Status:** pending

## W17 — Export OBJ + 3MF + Bambu 3MF
**Goal:** All export formats  
**Steps:**
1. Single box; export OBJ, 3MF, Bambu 3MF from menu
2. Each download non-empty
**Pass:** Three downloads triggered  
**Status:** pending

## W18 — Import mesh adds part
**Goal:** STL import path  
**Steps:**
1. If tests/fixtures has STL, import via gallery
2. Else export STL then re-import
3. Part appears in build tree
**Pass:** Import adds node; compiles  
**Status:** pending

## W19 — Toolbar customize + dock edge persist
**Goal:** Toolbar UX  
**Steps:**
1. Open customize; move a tool
2. Dock toolbar to different edge
3. Reload page — layout persists (localStorage)
**Pass:** Settings survive reload  
**Status:** pending

## W20 — Command palette open/filter/escape
**Goal:** Power-user navigation  
**Steps:**
1. Open palette (Ctrl+K or button)
2. Type "export" — filters
3. Escape closes
**Pass:** No errors; palette closes  
**Status:** pending

## W21 — Help modal open, tabs, close, a11y
**Goal:** Help UX + a11y  
**Steps:**
1. Open help; switch Features/G-code tabs
2. Close via X and backdrop click (two opens)
3. Check aria-hidden toggles on modal
**Pass:** Modal works; no stuck focus trap  
**Status:** pending

## W22 — Grid, theme, measure, layers toggles
**Goal:** Viewport chrome  
**Steps:**
1. Toggle grid, theme, measure mode, layers bar
2. Each flips expected app flag/class
**Pass:** All four toggles work  
**Status:** pending

## W23 — Transform gizmo W/E/R + arrow nudge
**Goal:** Transform modes  
**Steps:**
1. Add box; W/E/R switch modes
2. Arrow keys nudge; Shift+arrow = 10mm
**Pass:** pos/rot updates in tree  
**Status:** pending

## W24 — Grouped parts move together
**Goal:** Group rigid body  
**Steps:**
1. Two parts grouped; select one; arrow nudge
2. Both move same delta
**Pass:** Relative positions preserved  
**Status:** pending

## W25 — Stress: add 10 parts rapidly
**Goal:** Stability under load  
**Steps:**
1. Rapidly add 10 boxes via gallery
2. Delete 5; undo 2
3. App remains responsive; compile completes
**Pass:** No crash; part count correct  
**Status:** pending

## W26 — Cut in half along Z
**Goal:** Split operation  
**Steps:**
1. Add box; cut in half Z
2. Part count +1; both halves compile
**Pass:** 2 parts from 1  
**Status:** pending

## W27 — Sketch mode start + cancel
**Goal:** Sketch entry/exit  
**Steps:**
1. + gallery → sketch tile
2. Cancel sketch mode
3. Back to normal build UI
**Pass:** No stuck sketch overlay  
**Status:** pending

## W28 — Workspace toggle edit ↔ result in build mode
**Goal:** Build-mode preview segment  
**Steps:**
1. Build mode with parts; toggle workspace Result/Edit
2. Sidebar shows correct panel
**Pass:** Mutual exclusivity code/build panels intact  
**Status:** pending
