# RandR — Top 20 Most-Wanted Features (research, 2026-06-19)

**Purpose.** A ranked, evidence-backed list of the features that 3D-printing makers most
want from modeling software, filtered to the *most productive additions for **RandR*** (our
offline-first, Tinkercad-style parametric CAD on a manifold-3d mesh kernel, aimed at printing
on a Bambu A1 mini). This document is committed **before** any of these are implemented — the
apply-phase will then tackle them one at a time, each in its own commit, so every change can be
reviewed or reverted independently.

**Method.** Five parallel research passes over the real demand signal: slicer issue trackers
(Bambu Studio, OrcaSlicer, PrusaSlicer, Cura, SuperSlicer), open-source CAD trackers (OpenSCAD,
SolveSpace, Dune3D, FreeCAD), consumer/browser CAD idea portals (Tinkercad, Onshape Improvement
Requests, Fusion IdeaStation, SketchUp), maker communities (Reddit, Bambu/Prusa/Creality/Ultimaker
forums, Printables/MakerWorld), and touch/web-CAD tools (Shapr3D, Plasticity, SelfCAD, Vectary,
Womp). Ranking = **demand strength × productivity for printing × fit/feasibility in RandR**, with
priority given to genuine *gaps*. GitHub 👍/comment counts were pulled live where verifiable;
login-gated portals (Autodesk, Onshape) and Reddit are corroborated qualitatively and any
unconfirmed metric is marked *(unverified)*.

**What RandR already has** (so the list below is framed as gaps/enhancements, not duplicates):
~20 primitives incl. text/threads/bolt/nut/roundedBox/chamferedBox/tube; booleans + groups with
union/subtract/intersect modes; mirror/flip; linear & polar arrays; Tinkercad-style align
(min/center/max); move/rotate/scale gizmo + touch drag; multi-select; snap (1 mm/15°) + magnetic
drag-snap + **place-on-face**; undo/redo; per-part colour; units on every field + size/volume/tris
HUD + selection W×D×H; local projects (save/open/autosave); STL/OBJ/3MF export; STL import +
**explode**; layer preview; parametric code language + param sliders; **manifold kernel →
guaranteed-watertight exports**; PWA offline + Android/touch. Items below were confirmed against
the current `src/` (e.g. 3MF export writes geometry only — no colour; no fillet-edge/shell/measure
tooling; circular resolution uses the kernel default).

---

## The ranked top 20

> Status legend: ❌ missing · ⚠️ partial (have a weaker/adjacent version) · Complexity: **S** small · **M** medium · **L** large.

### 1. Fillet & chamfer on *selected edges*  ❌ · **L**
The single most universal request across **every** source. OpenSCAD
[#884 "fillet/chamfer" 16👍/39c, $80 bounty](https://github.com/openscad/openscad/issues/884);
SolveSpace [#149 12👍](https://github.com/solvespace/solvespace/issues/149),
[#577 6👍](https://github.com/solvespace/solvespace/issues/577); Dune3D
[#98](https://github.com/dune3d/dune3d/issues/98); the #1 named Tinkercad limitation (its fillet
only handles straight edges → people "Send to Fusion" just to round corners); persistent SketchUp
"built-in fillet/round-corner please" threads. **Why:** rounded/beveled edges are needed on nearly
every functional print (strength, comfort, self-supporting first layers). **Feasibility:** hard on
a mesh kernel — manifold has no edge-fillet. Pragmatic path: a "round all edges" op via
morphological close (offset out → in) or Minkowski-with-sphere, and 2D-profile fillet (CrossSection
round joins) for extruded shapes; true per-edge selection is a later milestone.

### 2. Interactive measure & dimension tool  ❌ · **M**
Click two points / an edge / a circle → live distance, diameter, angle on-canvas. Requested across
Bambu (#2553/#2821/#3338), Orca (#1590/#7741 — Bambu/Orca *shipped* a ported "Measure"), Cura
[#2536 "layers in mm"](https://github.com/Ultimaker/Cura/issues/2536), and every consumer-CAD pass
("more precise" is the top reason reviewers tell people to leave Tinkercad). **RandR status:** has
a size HUD + units but no point-to-point measure. **Why:** dimensional certainty is what separates
"art" from a part that fits real hardware.

### 3. Tolerance / clearance helper for press-fits  ❌ · **M**
Bake fit clearances into mating features instead of eyeballing. PrusaSlicer
[#8138 "slicing tolerance control" 49👍](https://github.com/prusa3d/PrusaSlicer/issues/8138),
[#4561 "holes XY compensation" 34👍](https://github.com/prusa3d/PrusaSlicer/issues/4561); rated
**very high** in the maker community as the *#1 reprint cause* (endless "0.15 snug / 0.20 sliding /
0.30 loose" threads + dedicated tolerance-tester prints). **Why:** a per-hole/peg clearance field
(+ optional global "fit" offset and a one-click fit-test strip) makes snap parts and inserts work
first try — the core Tinkercad-style use case.

### 4. Multi-colour / multi-material assignment + colour 3MF export (AMS)  ❌ · **M**
Assign colour/material per body (or paint per face) and export a 3MF the A1 mini's AMS reads.
OrcaSlicer [#7106 "per-wall/infill filament" 34👍/28c](https://github.com/SoftFever/OrcaSlicer/issues/7106);
a large active OpenSCAD colour-3MF cluster ([#5848](https://github.com/openscad/openscad/issues/5848),
[#4671](https://github.com/openscad/openscad/issues/4671), [#6060](https://github.com/openscad/openscad/issues/6060)).
**RandR status:** already stores per-part colour, but 3MF export writes geometry only. **Why:**
the single biggest AMS-workflow win and a near-free one given colours already exist in the model.

### 5. Smooth curves / adjustable resolution  ⚠️ · **S–M**
A global smoothness control (+ per-shape override) and a higher default, so cylinders/spheres
aren't faceted. Repeatedly cited as Tinkercad's most concrete limitation (low side-count cap;
[Bambu forum "smooth circles"](https://forum.bambulab.com/t/smooth-circles/62638)). **RandR
status:** uses the manifold default, not user-controllable. **Why:** faceted round parts print with
visible flats; one slider fixes a whole class of "looks low-poly" complaints.

### 6. 2D sketch → extrude / revolve (profile-driven modeling)  ⚠️ · **L**
Draw a 2D profile on a workplane and pull it into 3D; light dimensional constraints. SolveSpace
[#77 "parametric sketches" 36👍 — the repo's #1 issue](https://github.com/solvespace/solvespace/issues/77);
a distinct recurring Tinkercad ask (Fusion-style sketch + Bezier/spline). **RandR status:** the
kernel has `extrude`/`revolve` but there's no interactive sketcher. **Why:** custom outlines that
primitive-stacking can't make (brackets, profiles, organic 2D shapes). Start without a full
constraint solver (point/line/arc polyline → extrude), add constraints later.

### 7. Hollow / shell to a wall thickness (+ drain/escape holes)  ❌ · **M–L**
Turn a solid into a shell of thickness *t* with optional drain holes. PrusaSlicer shipped
"Hollow and drill" off [#3219](https://github.com/prusa3d/PrusaSlicer/issues/3219) /
[#156 "wall thickness in mm"](https://github.com/prusa3d/PrusaSlicer/issues/156). **RandR status:**
only the `tube` primitive. **Why:** saves filament/time on big solids — a top reason hobbyists open
a modeler. Feasibility: inward offset is hard generally; ship a robust version for convex/extruded
shapes first.

### 8. Printability checks — build-volume fit · overhang · thin-wall  ❌ · **S → L**
Overlays that flag problems *before* export: part exceeds the 180×180×180 mm A1-mini volume (**S**,
easy bbox check); faces steeper than ~45–50° overhang (**M**); walls thinner than the nozzle
(**L**). Widely wished-for ("makers wish the *modeler* flagged overhangs"); Cura wall-thickness
issue cluster ([#15219](https://github.com/Ultimaker/Cura/issues/15219), #10923, #1016). **Why:**
catches the most common print failures at design time. Ship the build-volume warning first.

### 9. Auto-orient for printability  ⚠️ · **M**
Auto-rotate to the orientation that minimizes overhangs/support (shipped in OrcaSlicer/SuperSlicer;
PrusaSlicer [#13091](https://github.com/prusa3d/PrusaSlicer/issues/13091); cross-slicer redundancy
is the signal). **RandR status:** has manual place-on-face. **Why:** orientation is the #1 lever on
print success; one button beats manual rotation.

### 10. Sweep / loft / extrude-along-path  ❌ · **M–L**
Sweep a profile along a path, or loft between profiles. SolveSpace
[#439 "extrude along path / loft" 15👍](https://github.com/solvespace/solvespace/issues/439);
OpenSCAD path-extrude asks + BOSL2's popularity. **Why:** handles, ducts, ergonomic grips,
transitions — big expressiveness win over stacked primitives.

### 11. Threads & fastener helper — standard sizes + print clearance  ⚠️ · **M**
Pick M3–M8 (or custom pitch/Ø), internal/external, with print offsets baked in (internal +0.2–0.4,
external −0.1–0.2) and a lead-in chamfer. FreeCAD
[#6533 "expose pitch/Ø of threaded hole"](https://github.com/FreeCAD/FreeCAD/issues/6533); rated
**high** in the maker community (cosmetic-thread trap; "printing nuts & threaded holes"). **RandR
status:** has `thread`/`bolt`/`nut` but no standard-size presets or print clearance. **Why:** caps,
inserts, bolted assemblies are core functional prints and easy to get subtly wrong.

### 12. Movable workplanes / construction planes + reference geometry  ⚠️ · **M**
Drop a workplane on any face and model relative to it; reference points/axes. Tinkercad's Workplane
tool, Shapr3D, Onshape. **RandR status:** has place-on-face + the ground plane. **Why:** the natural
home for the sketch tool (#6) and for adding features to angled/curved faces on a touch device.

### 13. Visual parametric history / feature timeline (build mode)  ⚠️ · **M**
An editable timeline of operations so changing an early dimension rebuilds downstream — the headline
reason reviewers push users off Tinkercad toward Fusion/Onshape; FreeCAD's Topological-Naming fix
was its 1.0 headline. **RandR status:** code mode *is* a re-editable history and the build tree is
partial; a visual timeline in build mode is missing. **Why:** "tweak one number, whole model
updates" is the core payoff of parametric.

### 14. Deeper STL mesh editing (beyond explode)  ⚠️ · **L**
Move/scale selected faces, simplify, repair, re-mesh an imported model. Rated **high**
("STL is triangle soup… often easier to re-make"; [Prusa "how do I edit an STL"](https://forum.prusa3d.com/forum/original-prusa-i3-mk3s-mk3-general-discussion-announcements-and-releases/how-do-i-edit-an-existing-stl-file/)).
**RandR status:** has import + decompose/explode. **Why:** most makers start from a downloaded
model; "open this and tweak it" is constant and poorly served.

### 15. Modifier volumes / per-region settings (3MF)  ❌ · **M–L**
Mark a region (a box/volume) that carries different print settings — denser infill, different
material, intersection-only. PrusaSlicer
[#10321 "print only intersection of modifier" 45👍](https://github.com/prusa3d/PrusaSlicer/issues/10321),
[#3635 "more height-range options" 35👍](https://github.com/prusa3d/PrusaSlicer/issues/3635). **Why:**
gives users localized control they currently hand-build in the slicer; exports as 3MF modifier
objects.

### 16. Support helpers — blocker/enforcer volumes, custom brim, first-layer chamfer  ❌ · **M**
Paint-on/volume support enforcers & blockers and base-adhesion helpers. PrusaSlicer
[#8283 "paint-on brim" 45👍](https://github.com/prusa3d/PrusaSlicer/issues/8283),
[#4744 brim-blocker 33👍](https://github.com/prusa3d/PrusaSlicer/issues/4744); Cura
[#3824 15👍](https://github.com/Ultimaker/Cura/issues/3824). **Why:** less support material/cleanup;
a first-layer chamfer fights elephant's-foot on the A1 mini's open bed.

### 17. Touch/tablet UX — select-mode filters, radial menu, two-finger camera, big hit targets  ⚠️ · **M**
Face-only/edge-only selection filters + generous hit areas (the #1 touch-CAD frustration is
fat-finger mis-selection — Shapr3D ["edge selection is confusing"](https://discourse.shapr3d.com/t/edge-selection-is-confusing/26122));
standard pinch-zoom / two-finger pan / orbit; thumb radial menus. **RandR status:** has touch drag,
multi-select toggle, context-menu hub. **Why:** RandR is Android/touch-first; this is the
under-served niche it can own.

### 18. Undo/redo that preserves selection (+ redo-safe gizmo)  ⚠️ · **S–M**
Undo shouldn't drop your multi-selection or leave the gizmo stale — a heavily-requested Shapr3D QoL
fix ([undo drops selection](https://discourse.shapr3d.com/t/undo-drops-selection/4781)). **RandR
status:** has undo/redo. **Why:** on touch, mistakes are frequent; selection-preserving undo is a
daily win.

### 19. Command palette / searchable command bar  ❌ · **S–M**
Type to find any tool/op (great with a tablet keyboard; CAD command-line tradition). **Why:** as the
feature set grows past ~20 primitives + ops, discoverability beats hunting menus; cheap to add.

### 20. Parametric part library / "Simple-mode" gallery with size knobs  ⚠️ · **M**
Adjustable ready-made models (bolt+nut, brackets, boxes/bins, gears, hooks) with a few size sliders
and one-tap export — the entire MakerWorld/Thingiverse **Customizer** ecosystem exists for this, and
"make it the size I need" is the #1 reason casual users edit a model at all. **RandR status:** has
static templates + a recipe engine started (gears). **Why:** it's the most approachable on-ramp and
directly serves the planned Simple/Maker/Pro tiers.

---

## Deferred / out of scope (with reasons)

- **STEP import/export** — high demand in CAD circles (OpenSCAD
  [#893 23👍](https://github.com/openscad/openscad/issues/893); FreeCAD
  [#19795](https://github.com/FreeCAD/FreeCAD/issues/19795)) but STEP is a B-rep format and RandR's
  manifold kernel is mesh-based; faithful STEP export is infeasible without a B-rep core. STEP
  *import* (tessellate to mesh) is a possible future, low priority.
- **Pure-slicer features** — infill patterns, brick layers, network/LAN mode, RTSP camera
  ([Bambu #1536 531👍](https://github.com/bambulab/BambuStudio/issues/1536)), Spoolman, MQTT.
  These dominate raw upvote counts but belong in the slicer, not a modeler.
- **Cloud collaboration / share-by-link / live multi-user** — RandR is deliberately offline-first
  and local; revisit only as file-based sharing.

## Suggested apply-phase order (value × tractability — quick wins first, gaps prioritized)

The demand ranking above is *what users want most*; this is the order to **build** in, front-loading
high-value/low-risk wins and interleaving the hard ones:

1. Build-volume fit warning (#8a, **S**) — immediate A1-mini value.
2. Smooth-curves resolution control (#5, **S–M**).
3. Multi-colour 3MF export (#4, **M**) — colours already in the model.
4. Measure / dimension tool (#2, **M**).
5. Tolerance / clearance helper + fit-test (#3, **M**).
6. Undo preserves selection (#18, **S–M**).
7. Threads-with-clearance + standard sizes (#11, **M**).
8. Hollow / shell op (#7, **M–L**).
9. Overhang highlight (#8b, **M**).
10. Auto-orient (#9, **M**).
11. Fillet / chamfer on edges (#1, **L**) — the flagship; pragmatic round-all-edges first.
12. Sweep / loft (#10), workplanes (#12), sketch→extrude (#6), then history UI (#13), mesh editing
    (#14), modifier volumes (#15), support helpers (#16), touch polish (#17), command palette (#19),
    Simple-mode gallery (#20).

_Each apply-phase feature ships in its own commit, verified in-browser before the next._
