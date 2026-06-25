// The 3D viewport. Owns the three.js scene, a build-plate grid sized like a
// real printer bed, orbit controls, the merged "current model" mesh (code
// mode), and a group of individually-selectable per-shape meshes (build mode)
// you can click and drag straight on the workplane — the Tinkercad interaction,
// done without any extra dependencies.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { manifoldToGeometry, edgesGeometry } from '../kernel/mesh.js';

const COLORS = {
  bg: 0x1a1d21,
  grid: 0x2c3036,
  gridMajor: 0x3a4048,
  gridFine: 0x2a2f34,
  gridCm: 0x4d90e1,
  model: 0x4dd0e1,
  edge: 0x1a1d21,
  plate: 0x202428,
  hole: 0xef5350,
  glowSolid: 0x2a6b78,
  glowHole: 0x5a1a18,
  buildVol: 0x3a4048,
  buildVolBad: 0xef5350,
  measure: 0xffb74d,
};

// Snapshot of the dark palette so the theme toggle can restore it, plus a light
// variant tuned so the model, grid and plate read well on a bright background
// (not a naive invert — geometry needs different contrast in light).
const DARK = { ...COLORS };
const LIGHT = {
  bg: 0xeef1f4,
  grid: 0xc4ccd6,
  gridMajor: 0xaab4c0,
  gridFine: 0xdfe4ea,
  gridCm: 0x2f7dc4,
  model: 0x2bb6c9,
  edge: 0x8a98a8,
  plate: 0xe2e6ec,
  hole: 0xe24a47,
  glowSolid: 0x2a6b78,
  glowHole: 0x7a3a38,
  buildVol: 0x9aa6b3,
  buildVolBad: 0xe24a47,
  measure: 0xc77f1a,
};

// Printable build volume of the target printer (Bambu A1 mini = 180×180×180 mm).
// Exported so the HUD fit-check uses a single source of truth.
export const BUILD_VOLUME = { x: 180, y: 180, z: 180 };

export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.bg);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(120, 90, 120);
    this.camera.lookAt(0, 0, 0);

    this._setupLights();
    this._setupPlate(220, 220); // a generic 220x220 bed footprint
    this._setupBuildVolume();   // A1-mini 180³ printable envelope

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    // Per-shape editable group (build mode). Manifold is Z-up; rotate the whole
    // group to the scene's Y-up so shapes line up with the merged-model view.
    this.editGroup = new THREE.Group();
    this.editGroup.rotation.x = -Math.PI / 2;
    this.editGroup.visible = false;
    this.scene.add(this.editGroup);

    this.material = new THREE.MeshStandardMaterial({
      color: COLORS.model, metalness: 0.1, roughness: 0.55, flatShading: false,
    });
    // Overhang-analysis variant of the model material: same PBR lighting, but
    // faces whose normal points steeply downward (would need support to print)
    // are tinted amber -> red. The threshold is ~45deg from vertical.
    this.overhangMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.model, metalness: 0.1, roughness: 0.55, flatShading: false,
    });
    this.overhangMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vOHNormal;')
        .replace('#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\nvOHNormal = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vOHNormal;')
        // tint the base colour by overhang severity
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );',
          'float ohDown = -normalize(vOHNormal).y;\n' +
          '  vec3 ohCol = diffuse;\n' +
          '  if (ohDown > 0.7) ohCol = vec3(0.94, 0.33, 0.31);\n' +
          '  else if (ohDown > 0.34) ohCol = mix(diffuse, vec3(1.0, 0.72, 0.30), (ohDown - 0.34) / 0.36);\n' +
          '  vec4 diffuseColor = vec4( ohCol, opacity );')
        // and make overhangs glow so they read even when the face is in shadow
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' +
          '  if (ohDown > 0.7) totalEmissiveRadiance += vec3(0.50, 0.10, 0.09);\n' +
          '  else if (ohDown > 0.34) totalEmissiveRadiance += vec3(0.48, 0.30, 0.05) * ((ohDown - 0.34) / 0.36);');
    };
    this.overhangView = false;
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.edge });

    // --- edit-mode state ---
    this._wire = false;
    this.editActive = false;
    this.snap = true;
    this.snapStep = 1;             // mm
    this.magnet = true;            // snap to other parts' edges/centres while dragging
    this.magnetDist = 3;           // snap pull radius (mm)
    this.multiSelect = false;      // sticky additive selection (taps add — touch-friendly, no Shift needed)
    this._layerGroup = null;       // layer-preview line group
    this._layerObjs = null;        // per-layer LineSegments (for the slider)
    this.editMeshes = [];          // [{ index, mesh, op }]
    this.selectedIndex = -1;
    this.selectedSet = [];
    this.transformSet = [];        // rigid transform targets (selection + group members)
    this.getTransformSet = null;   // optional () => indices — refreshed on recompile
    this.transformMode = 'translate';
    this._gizmoDragging = false;
    this.onSelect = null;          // (index | -1)
    this.onContext = null;         // (index | -1, clientX, clientY) — right-click
    this.onShapeMove = null;       // (index, [x,y,z]) — live during drag
    this.onShapeMoveEnd = null;    // (index, [x,y,z])
    this.onTransform = null;       // (index, {pos,rot,scale}) — live during gizmo drag
    this.onGroupTransform = null;  // (updates[{index,pos,rot,scale}]) — rigid multi-part drag
    this.onTransformEnd = null;    // (index)
    this._groupPivot = null;       // gizmo anchor at selection centre (2+ parts)
    this._groupXformLocals = null; // each member's matrix relative to the pivot
    this._groupPivotCenter = null; // selection centre when the current drag started
    this._groupScaleBaseline = null; // per-member pos/rot/scale at drag start (scale mode)
    this._singleScaleRot = null;     // locked euler while a lone part is being scaled
    this.onMultiArm = null;        // (on) — long-press armed / disarmed multi-select
    this._lpTimer = null;          // long-press timer (touch multi-select)
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._outline = null;
    this._measure = { on: false, a: null, b: null, group: null }; // measure tool
    this.measureLabel = null; // DOM overlay positioned at the segment midpoint
    this.xformReadout = null; // DOM overlay: live size (W·D·H) while scaling, angles (X·Y·Z°) while rotating
    this._xfBox = new THREE.Box3();
    this._xfCenter = new THREE.Vector3();
    this._pins = []; // pinned dimension annotations (persist across recompiles)
    this.onMeasure = null;    // (info|null) — { dist, x, y, z } in mm
    this._sketch = { on: false, pts: [], cursor: null, group: null, mode: 'extrude' }; // sketch → extrude/revolve
    this.onSketchComplete = null; // (points:[[x,y],…]) — a closed polygon was drawn

    this._setupControls();
    this._setupGizmo();
    this._setupNavCube();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._animate();
  }

  _setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x202428, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(80, 140, 60);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aabb, 0.5);
    fill.position.set(-100, 40, -80);
    this.scene.add(fill);
  }

  _setupPlate(w, d) {
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: COLORS.plate, roughness: 0.9, metalness: 0 })
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -0.05;
    this.scene.add(plate);
    this.plate = plate;
    this._plateW = w;
    this._fineWanted = false;
    this._addGrids(w);
  }

  // Builds the 10 mm grid + the fine 1 mm grid. Split out so a theme change can
  // rebuild them: GridHelper bakes its colours into the geometry, so recolouring
  // means recreating the helpers rather than poking a material.
  _addGrids(w) {
    const grid = new THREE.GridHelper(w, w / 10, COLORS.gridMajor, COLORS.grid);
    this.scene.add(grid);
    this.grid = grid;

    // fine 1 mm grid — subtle, off by default; toggle on for mm-precise work
    const fine = new THREE.GridHelper(w, w, COLORS.gridFine, COLORS.gridFine);
    fine.material.opacity = 0.55;
    fine.material.transparent = true;
    fine.position.y = -0.02; // just under the 10 mm grid so the cm lines stay on top
    fine.visible = this._fineWanted && grid.visible;
    this.scene.add(fine);
    this.fineGrid = fine;
    this._setCmLinesBlue(this._fineWanted);
  }

  // A faint wireframe box marking the printable build volume; sits base-on-plate
  // and turns red when the model spills outside it (see setBuildVolumeExceeded).
  _setupBuildVolume() {
    const { x, y, z } = BUILD_VOLUME; // manifold space: x,y footprint, z up
    const box = new THREE.BoxGeometry(x, z, y); // three.js Y is up → map z→Y, y→Z
    const mat = new THREE.LineBasicMaterial({ color: COLORS.buildVol, transparent: true, opacity: 0.22 });
    const env = new THREE.LineSegments(new THREE.EdgesGeometry(box), mat);
    env.position.y = z / 2; // base on the plate (y=0 .. z)
    env.renderOrder = -1;    // behind the model
    this.scene.add(env);
    this.buildVolume = env;
    this._bvExceeded = false;
  }

  // Toggle the build-volume box between its faint resting state and a bright red
  // alarm when the current model exceeds the printable envelope.
  setBuildVolumeExceeded(over) {
    if (!this.buildVolume || over === this._bvExceeded) return;
    this._bvExceeded = over;
    const m = this.buildVolume.material;
    m.color.setHex(over ? COLORS.buildVolBad : COLORS.buildVol);
    m.opacity = over ? 0.9 : 0.22;
  }

  // --- picking helpers ------------------------------------------------------

  _ndcFrom(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this._ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    this._ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    return this._ndc;
  }

  _pickShape(clientX, clientY) {
    if (!this.editActive || this.editMeshes.length === 0) return null;
    this._raycaster.setFromCamera(this._ndcFrom(clientX, clientY), this.camera);
    const hits = this._raycaster.intersectObjects(this.editMeshes.map((e) => e.mesh), false);
    return hits.length ? hits[0] : null;
  }

  // World point under the pointer — the camera dollies toward this when zooming.
  // Prefers real geometry, then the ground plane, then the focal plane through
  // the target, so there is always a sensible point (even over empty space).
  _pointUnderCursor(clientX, clientY) {
    this._raycaster.setFromCamera(this._ndcFrom(clientX, clientY), this.camera);
    const targets = [];
    if (this.editActive) for (const e of this.editMeshes) targets.push(e.mesh);
    for (const c of this.modelGroup.children) if (c.isMesh) targets.push(c);
    const hits = this._raycaster.intersectObjects(targets, false);
    if (hits.length) return hits[0].point.clone();
    const p = new THREE.Vector3();
    const ground = this._groundPlane || (this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
    if (this._raycaster.ray.intersectPlane(ground, p)) return p;
    const focal = new THREE.Plane().setFromNormalAndCoplanarPoint(
      this.camera.getWorldDirection(new THREE.Vector3()), this._target || new THREE.Vector3());
    return this._raycaster.ray.intersectPlane(focal, p) ? p : null;
  }

  // --- measure tool ---------------------------------------------------------
  // Click two surface points (vertex-snapped) for a live distance + ΔX/Y/Z
  // readout. Works in build (per-shape meshes) and result/code (merged mesh).
  setMeasureMode(on) {
    this._measure.on = !!on;
    if (!on) this._clearMeasure();
    this.canvas.style.cursor = on ? 'crosshair' : '';
  }

  _clearMeasure() {
    const m = this._measure;
    if (m.group) { this.scene.remove(m.group); m.group.traverse((o) => o.geometry?.dispose()); m.group = null; }
    m.a = m.b = null;
    if (this.measureLabel) this.measureLabel.style.display = 'none';
    if (this.onMeasure) this.onMeasure(null);
  }

  _measurePick(clientX, clientY) {
    const p = this._pickSurfacePoint(clientX, clientY);
    if (!p) return;
    const m = this._measure;
    if (!m.a || m.b) { m.a = p; m.b = null; } // first point, or restart after a pair
    else m.b = p;
    this._renderMeasure();
    if (this.onMeasure) this.onMeasure(m.b ? this._measureInfo() : null);
  }

  // Raycast the visible solid geometry (build per-shape meshes + the merged
  // result mesh) and return the hit point, vertex-snapped near corners.
  _pickSurfacePoint(clientX, clientY) {
    this.editGroup.updateMatrixWorld(true);
    this._raycaster.setFromCamera(this._ndcFrom(clientX, clientY), this.camera);
    const targets = [];
    if (this.editActive) for (const e of this.editMeshes) targets.push(e.mesh);
    for (const c of this.modelGroup.children) if (c.isMesh) targets.push(c);
    const hits = this._raycaster.intersectObjects(targets, false);
    return hits.length ? this._snapVertex(hits[0]) : null;
  }

  // Snap to the nearest vertex of the hit triangle when the click lands close to
  // a corner (so corner-to-corner reads exact); else the precise surface point.
  _snapVertex(hit) {
    const pt = hit.point.clone();
    const geo = hit.object.geometry, face = hit.face;
    if (geo && face && geo.attributes.position) {
      const pos = geo.attributes.position;
      let best = null, bd = Infinity;
      for (const vi of [face.a, face.b, face.c]) {
        const v = hit.object.localToWorld(new THREE.Vector3().fromBufferAttribute(pos, vi));
        const d = v.distanceTo(pt);
        if (d < bd) { bd = d; best = v; }
      }
      if (best && bd < this.camera.position.distanceTo(pt) * 0.03) return best;
    }
    return pt;
  }

  _renderMeasure() {
    const m = this._measure;
    if (m.group) { this.scene.remove(m.group); m.group.traverse((o) => o.geometry?.dispose()); m.group = null; }
    if (!m.a) return;
    if (!this._measureMat) {
      this._measureMat = new THREE.MeshBasicMaterial({ color: COLORS.measure });
      this._measureLineMat = new THREE.LineBasicMaterial({ color: COLORS.measure });
    }
    const g = new THREE.Group();
    const mk = (p) => {
      const r = this.camera.position.distanceTo(p) * 0.012;
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), this._measureMat);
      s.position.copy(p); return s;
    };
    g.add(mk(m.a));
    if (m.b) {
      g.add(mk(m.b));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([m.a, m.b]), this._measureLineMat));
    }
    this.scene.add(g);
    m.group = g;
  }

  _measureInfo() {
    const m = this._measure;
    if (!m.a || !m.b) return null;
    // world delta -> manifold/printer space: model = (wx, -wz, wy)
    const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y, dz = m.b.z - m.a.z;
    return { dist: m.a.distanceTo(m.b), x: Math.abs(dx), y: Math.abs(dz), z: Math.abs(dy) };
  }

  // Pin the current measurement as a persistent 3D annotation (markers + line +
  // a floating distance sprite) that survives recompiles. Returns true if pinned.
  pinCurrentMeasure() {
    const m = this._measure;
    if (!m.a || !m.b) return false;
    if (!this._measureMat) {
      this._measureMat = new THREE.MeshBasicMaterial({ color: COLORS.measure });
      this._measureLineMat = new THREE.LineBasicMaterial({ color: COLORS.measure });
    }
    const g = new THREE.Group();
    const mk = (p) => { const s = new THREE.Mesh(new THREE.SphereGeometry(this.camera.position.distanceTo(p) * 0.012, 12, 8), this._measureMat); s.position.copy(p); return s; };
    g.add(mk(m.a), mk(m.b));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([m.a, m.b]), this._measureLineMat));
    const mid = m.a.clone().add(m.b).multiplyScalar(0.5);
    g.add(this._makeDistLabel(`${m.a.distanceTo(m.b).toFixed(1)} mm`, mid));
    this.scene.add(g);
    this._pins.push(g);
    return true;
  }

  clearPins() {
    for (const g of this._pins) {
      this.scene.remove(g);
      g.traverse((o) => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
    }
    this._pins = [];
  }

  // A camera-facing sprite showing distance text on an amber pill (canvas).
  _makeDistLabel(text, pos) {
    const cw = 256, ch = 72;
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffb74d'; ctx.fillRect(6, 16, cw - 12, ch - 32);
    ctx.fillStyle = '#1a1d21'; ctx.font = 'bold 34px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cw / 2, ch / 2);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, depthWrite: false }));
    const w = this.camera.position.distanceTo(pos) * 0.07;
    spr.scale.set(w, w * ch / cw, 1);
    spr.position.copy(pos);
    spr.renderOrder = 999;
    return spr;
  }

  // Keep the floating distance label glued to the segment midpoint each frame.
  _updateMeasureLabel() {
    const m = this._measure, el = this.measureLabel;
    if (!el) return;
    if (!(m.on && m.a && m.b)) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
    const mid = m.a.clone().add(m.b).multiplyScalar(0.5).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    el.style.left = ((mid.x * 0.5 + 0.5) * r.width) + 'px';
    el.style.top = ((-mid.y * 0.5 + 0.5) * r.height) + 'px';
    el.style.display = (mid.z < 1) ? 'block' : 'none';
  }

  // While the gizmo is dragging in size/turn mode, float a chip over the part
  // showing its live dimensions (W·D·H mm) or rotation (X·Y·Z°), so you can see
  // exactly what you're setting without looking away at the editor fields.
  _updateXformReadout() {
    const el = this.xformReadout;
    if (!el) return;
    const gizmo = this._gizmoDragging;
    const sizing = gizmo && this.transformMode === 'scale';
    const turning = gizmo && this.transformMode === 'rotate';
    // "moving" covers both the gizmo's translate handles and dragging the part body
    const moving = this._shapeDragging || (gizmo && this.transformMode === 'translate');
    const em = (sizing || turning || moving) ? this.editMeshes.find((m) => m.index === this.selectedIndex) : null;
    if (!em) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
    const mesh = em.mesh;

    if (sizing) {
      const g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox; // geometry-local = model frame (x=width, y=depth, z=height)
      const dim = (n, axis) => {
        const v = (bb.max[axis] - bb.min[axis]) * Math.abs(mesh.scale[axis]);
        return `<span class="xr-ax">${n}</span><span class="xr-v">${(Math.round(v * 10) / 10).toFixed(1)}</span>`;
      };
      el.innerHTML = dim('W', 'x') + dim('D', 'y') + dim('H', 'z') + '<span class="xr-u">mm</span>';
    } else if (turning) {
      const D = 180 / Math.PI;
      const ang = (n, axis) => {
        const a = Math.round(mesh.rotation[axis] * D) || 0;
        return `<span class="xr-ax">${n}</span><span class="xr-v">${a}°</span>`;
      };
      el.innerHTML = ang('X', 'x') + ang('Y', 'y') + ang('Z', 'z');
    } else { // moving — live position in mm
      const pos = (n, axis) => {
        const v = Math.round(mesh.position[axis] * 10) / 10;
        return `<span class="xr-ax">${n}</span><span class="xr-v">${v.toFixed(1)}</span>`;
      };
      el.innerHTML = pos('X', 'x') + pos('Y', 'y') + pos('Z', 'z') + '<span class="xr-u">mm</span>';
    }

    // anchor the chip at the part's world-space bounding-box centre
    this._xfBox.setFromObject(mesh);
    this._xfBox.getCenter(this._xfCenter);
    const p = this._xfCenter.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    el.style.left = ((p.x * 0.5 + 0.5) * r.width) + 'px';
    el.style.top = ((-p.y * 0.5 + 0.5) * r.height) + 'px';
    el.style.display = (p.z < 1) ? 'block' : 'none';
  }

  // --- sketch → extrude (draw a polygon on the ground workplane) ------------
  setSketchMode(on) {
    this._sketch.on = on;
    this._sketch.pts = [];
    this._sketch.cursor = null;
    this._clearSketch();
    if (on) this._renderSketch();
    this.canvas.style.cursor = on ? 'crosshair' : '';
  }

  sketchUndoPoint() { if (this._sketch.pts.length) { this._sketch.pts.pop(); this._renderSketch(); } }

  setSketchKind(mode) { this._sketch.mode = mode; if (this._sketch.on) this._renderSketch(); } // 'extrude' | 'revolve'

  cancelSketch() { this.setSketchMode(false); }

  finishSketch() {
    const pts = this._sketch.pts.slice();
    this._sketch.on = false;
    this._clearSketch();
    this.canvas.style.cursor = '';
    const ok = pts.length >= 3;
    if (ok && this.onSketchComplete) this.onSketchComplete(pts);
    return ok;
  }

  // Pointer → a grid-snapped point on the ground workplane, in model (x, y).
  _groundPoint(clientX, clientY) {
    this._raycaster.setFromCamera(this._ndcFrom(clientX, clientY), this.camera);
    const plane = this._groundPlane || (this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
    const hit = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(plane, hit)) return null;
    const local = this.editGroup.worldToLocal(hit.clone());
    const s = (v) => (this.snap ? Math.round(v / this.snapStep) * this.snapStep : Math.round(v * 100) / 100);
    return { x: s(local.x), y: s(local.y) };
  }

  // Client-px position of a model-space [x, y] point (to hit-test the first dot).
  _modelToScreen(pt) {
    const w = this.editGroup.localToWorld(new THREE.Vector3(pt[0], pt[1], 0)).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (w.x * 0.5 + 0.5) * r.width + r.left, y: (-w.y * 0.5 + 0.5) * r.height + r.top };
  }

  // A clean click while sketching: close the loop near the first vertex, else add.
  _sketchClick(clientX, clientY) {
    const p = this._groundPoint(clientX, clientY);
    if (!p) return;
    const pts = this._sketch.pts;
    if (pts.length >= 3) {
      const sp = this._modelToScreen(pts[0]);
      if (sp && Math.hypot(sp.x - clientX, sp.y - clientY) < 16) { this.finishSketch(); return; }
    }
    const last = pts[pts.length - 1];
    if (last && last[0] === p.x && last[1] === p.y) return; // ignore a no-move repeat
    pts.push([p.x, p.y]);
    this._renderSketch();
  }

  _sketchHover(clientX, clientY) {
    if (!this._sketch.on) return;
    const p = this._groundPoint(clientX, clientY);
    if (p) { this._sketch.cursor = [p.x, p.y]; this._renderSketch(); }
  }

  _sketchMats() {
    if (this._sketchLineMat) return;
    this._sketchLineMat = new THREE.LineBasicMaterial({ color: 0x4dd0e1, depthTest: false, transparent: true });
    this._sketchCloseMat = new THREE.LineBasicMaterial({ color: 0xffb74d, depthTest: false, transparent: true, opacity: 0.65 });
    this._sketchDotMat = new THREE.PointsMaterial({ color: 0x4dd0e1, size: 9, sizeAttenuation: false, depthTest: false });
    this._sketchFirstMat = new THREE.PointsMaterial({ color: 0xffb74d, size: 14, sizeAttenuation: false, depthTest: false });
  }

  _clearSketch() {
    const g = this._sketch.group;
    if (!g) return;
    while (g.children.length) { const c = g.children.pop(); c.geometry?.dispose(); }
    this.editGroup.remove(g);
    this._sketch.group = null;
  }

  _renderSketch() {
    this._clearSketch();
    if (!this._sketch.on) return;
    this._sketchMats();
    const g = new THREE.Group();
    if (this._sketch.mode === 'revolve') { // show the spin axis (x = 0)
      const ax = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -40, 0), new THREE.Vector3(0, 180, 0)]), this._sketchCloseMat);
      ax.renderOrder = 997; g.add(ax);
    }
    const pts = this._sketch.pts;
    const v = pts.map((p) => new THREE.Vector3(p[0], p[1], 0));
    const path = v.slice();
    if (this._sketch.cursor) path.push(new THREE.Vector3(this._sketch.cursor[0], this._sketch.cursor[1], 0));
    if (path.length >= 2) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path), this._sketchLineMat); l.renderOrder = 998; g.add(l); }
    if (v.length >= 3) { const cl = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v[v.length - 1], v[0]]), this._sketchCloseMat); cl.renderOrder = 998; g.add(cl); }
    if (v.length) {
      const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(v), this._sketchDotMat); dots.renderOrder = 999; g.add(dots);
      const first = new THREE.Points(new THREE.BufferGeometry().setFromPoints([v[0]]), this._sketchFirstMat); first.renderOrder = 999; g.add(first);
    }
    this.editGroup.add(g);
    this._sketch.group = g;
  }

  _setupControls() {
    let dragging = false, panning = false, shapeDrag = false, downOnCanvas = false, downAdditive = false;
    let lastX = 0, lastY = 0, downX = 0, downY = 0, moved = 0;
    let theta = -Math.PI / 2, phi = (40 * Math.PI) / 180, radius = 200; // open on the home view: front, 50° above the horizon
    const target = new THREE.Vector3(0, 0, 0);
    const dragPlane = new THREE.Plane();
    const hitV = new THREE.Vector3();
    const dragOffset = new THREE.Vector2(); // shape origin - grab point (local)

    const apply = () => {
      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.cos(phi);
      const z = radius * Math.sin(phi) * Math.sin(theta);
      this.camera.position.set(x + target.x, y + target.y, z + target.z);
      this.camera.lookAt(target);
    };
    apply();

    const snapV = (v) => (this.snap ? Math.round(v / this.snapStep) * this.snapStep : v);

    const startOrbit = (x, y, pan) => { dragging = true; panning = pan; lastX = x; lastY = y; };
    const moveOrbit = (x, y) => {
      const dx = x - lastX, dy = y - lastY;
      lastX = x; lastY = y;
      if (panning) {
        const panScale = radius * 0.0015;
        const right = new THREE.Vector3().subVectors(this.camera.position, target)
          .cross(this.camera.up).normalize();
        target.addScaledVector(right, -dx * panScale);
        target.y += dy * panScale;
      } else {
        theta -= dx * 0.01;
        phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - dy * 0.01));
      }
      apply();
    };
    const zoom = (delta, cx, cy) => {
      const next = Math.max(20, Math.min(1200, radius * (1 + delta * 0.001)));
      const f = next / radius;
      if (cx != null && f !== 1) {
        const p = this._pointUnderCursor(cx, cy);
        if (p) target.lerp(p, 1 - f); // dolly toward the point under the pointer (keeps it fixed on screen)
      }
      radius = next;
      apply();
    };

    const beginShapeDrag = (hit, additive) => {
      const idx = hit.object.userData.index;
      if (this.onSelect) this.onSelect(idx, additive);
      if (additive) return; // shift-click toggles selection, no drag
      const locked = this.editMeshes.find((e) => e.index === idx)?.lock;
      if (locked) return; // select only — don't move a locked shape
      shapeDrag = true;
      this._shapeDragging = true; // drives the live position readout
      // Drag on the horizontal plane through the shape's current height. The
      // raycaster is still aimed at the pointer-down position here, so the
      // intersection is the grab point — store its offset from the shape origin
      // so the shape moves *relative* to where you grabbed it (no teleport).
      dragPlane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 1, 0),
        hit.object.getWorldPosition(new THREE.Vector3())
      );
      if (this._raycaster.ray.intersectPlane(dragPlane, hitV)) {
        const grab = this.editGroup.worldToLocal(hitV.clone());
        dragOffset.set(hit.object.position.x - grab.x, hit.object.position.y - grab.y);
      } else {
        dragOffset.set(0, 0);
      }
      // Magnetic-snap setup: the dragged part's box (relative to its origin) and
      // the fixed boxes of every part NOT being dragged, to snap against.
      this._magnetSuppressed = false;
      this._dragBox = this._meshLocalBox(hit.object);
      this._magnetTargets = this.editMeshes
        .filter((e) => !this.transformSet.includes(e.index))
        .map((e) => this._meshWorldBox(e.mesh));
    };
    const moveShape = (x, y) => {
      this._raycaster.setFromCamera(this._ndcFrom(x, y), this.camera);
      if (!this._raycaster.ray.intersectPlane(dragPlane, hitV)) return;
      const em = this.editMeshes.find((e) => e.index === this.selectedIndex);
      if (!em) return;
      const local = this.editGroup.worldToLocal(hitV.clone());
      let nx = snapV(local.x + dragOffset.x);  // language X
      let ny = snapV(local.y + dragOffset.y);  // language Y (workplane)
      // Magnetic snap to other parts' edges/centres (hold Alt while dragging
      // to turn it off), then show the alignment guide(s) it locked onto.
      const mag = this._applyMagnet(nx, ny);
      nx = mag.x; ny = mag.y;
      this._showSnapGuides(mag.guides, em.mesh.position.z);
      // Shift every selected shape by the same delta so a group/multi-select
      // moves together (the primary tracks the cursor, the rest follow).
      const dx = nx - em.mesh.position.x, dy = ny - em.mesh.position.y;
      if (this.transformSet.length > 1) {
        for (const e of this.editMeshes) {
          if (e === em || !this.transformSet.includes(e.index)) continue;
          e.mesh.position.x += dx; e.mesh.position.y += dy;
        }
      }
      em.mesh.position.x = nx;
      em.mesh.position.y = ny;
      if (this._outline) this._outline.position.copy(em.mesh.position);
      if (this.onShapeMove) this.onShapeMove(this.selectedIndex,
        [em.mesh.position.x, em.mesh.position.y, em.mesh.position.z]);
    };

    const onDown = (x, y, pan, additive) => {
      if (this._gizmoDragging || (this.gizmo && this.gizmo.axis)) return; // a gizmo handle is grabbed
      if (this._planePick) { this._doPlanePick(x, y); return; } // arming a workplane pick
      if (this._measure.on && !pan) { // measure: left-drag still orbits, a clean click measures
        downOnCanvas = true; downX = x; downY = y; moved = 0;
        this._measurePending = true; startOrbit(x, y, false); return;
      }
      if (this._sketch.on && !pan) { // sketch: left-drag orbits, a clean click drops a point
        downOnCanvas = true; downX = x; downY = y; moved = 0;
        this._sketchPending = true; startOrbit(x, y, false); return;
      }
      downOnCanvas = true; downAdditive = additive;
      downX = x; downY = y; moved = 0;
      const hit = pan ? null : this._pickShape(x, y);
      if (hit) beginShapeDrag(hit, additive);
      else startOrbit(x, y, pan);
      // Long-press a shape (held still) to arm multi-select — the touch way to
      // build a selection without a Shift key. A move or quick release cancels.
      clearTimeout(this._lpTimer);
      if (hit && !additive) {
        this._lpTimer = setTimeout(() => {
          if (!downOnCanvas || moved >= 4 || this.multiSelect) return;
          shapeDrag = false; this._shapeDragging = false; this._clearSnapGuides(); this._magnetTargets = null; this._dragBox = null;
          this.multiSelect = true;
          if (navigator.vibrate) navigator.vibrate(15);
          if (this.onMultiArm) this.onMultiArm(true);
        }, 450);
      }
    };
    const onMove = (x, y) => {
      moved = Math.max(moved, Math.hypot(x - downX, y - downY));
      if (shapeDrag) moveShape(x, y);
      else if (dragging) moveOrbit(x, y);
    };
    const onUp = () => {
      if (!downOnCanvas) return; // ignore mouseups that didn't start on the canvas (e.g. panel clicks)
      downOnCanvas = false;
      this._shapeDragging = false;
      clearTimeout(this._lpTimer); // a release cancels any pending long-press
      if (this._measurePending) { // measure mode: a click (not a drag) places a point
        this._measurePending = false; dragging = false; panning = false;
        if (moved < 4) this._measurePick(downX, downY);
        return;
      }
      if (this._sketchPending) { // sketch mode: a click (not a drag) drops/closes a point
        this._sketchPending = false; dragging = false; panning = false;
        if (moved < 4) this._sketchClick(downX, downY);
        return;
      }
      if (shapeDrag) {
        const em = this.editMeshes.find((e) => e.index === this.selectedIndex);
        if (em && this.onShapeMoveEnd) this.onShapeMoveEnd(this.selectedIndex,
          [em.mesh.position.x, em.mesh.position.y, em.mesh.position.z]);
        shapeDrag = false;
        this._clearSnapGuides();
        this._magnetTargets = null; this._dragBox = null;
      } else if (this.editActive && moved < 4) {
        const onEmpty = !this._pickShape(downX, downY);
        if (onEmpty && this.multiSelect) {
          // armed long-press multi-select: an empty tap finishes it
          this.multiSelect = false;
          if (this.onMultiArm) this.onMultiArm(false);
          if (this.onSelect) this.onSelect(-1, false);
        } else if (onEmpty && !downAdditive && this.onSelect) {
          // a plain click on empty space clears the selection
          this.onSelect(-1, false);
        }
      }
      dragging = false; panning = false;
    };

    const c = this.canvas;
    c.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY, e.button === 2, e.shiftKey || this.multiSelect));
    window.addEventListener('mousemove', (e) => { if (dragging || shapeDrag) { this._magnetSuppressed = e.altKey; onMove(e.clientX, e.clientY); } });
    c.addEventListener('mousemove', (e) => { if (this._sketch.on) this._sketchHover(e.clientX, e.clientY); }); // sketch rubber-band
    window.addEventListener('mouseup', onUp);
    c.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY, e.clientX, e.clientY); }, { passive: false });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (moved > 4) return; // it was a right-drag (pan), not a click
      const hit = this._pickShape(e.clientX, e.clientY);
      if (this.onContext) this.onContext(hit ? hit.object.userData.index : -1, e.clientX, e.clientY);
    });

    // Touch: one finger = drag a shape (or orbit on empty), two = pinch-zoom + pan.
    let pinchDist = 0;
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) onDown(e.touches[0].clientX, e.touches[0].clientY, false, this.multiSelect);
      else if (e.touches.length === 2) {
        shapeDrag = false;
        clearTimeout(this._lpTimer); // a second finger cancels a pending long-press
        pinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        startOrbit((e.touches[0].clientX + e.touches[1].clientX) / 2,
                   (e.touches[0].clientY + e.touches[1].clientY) / 2, true);
      }
    }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY);
      else if (e.touches.length === 2) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        zoom((pinchDist - d) * 2,
             (e.touches[0].clientX + e.touches[1].clientX) / 2,
             (e.touches[0].clientY + e.touches[1].clientY) / 2);
        pinchDist = d;
        moveOrbit((e.touches[0].clientX + e.touches[1].clientX) / 2,
                  (e.touches[0].clientY + e.touches[1].clientY) / 2);
      }
    }, { passive: true });
    c.addEventListener('touchend', onUp);

    this._frameModel = (size) => {
      target.set(0, size.y / 2, 0);
      radius = Math.max(60, Math.hypot(size.x, size.y, size.z) * 1.8);
      apply();
    };
    this._setView = (which) => {
      if (which === 'top') { phi = 0.001; }
      else if (which === 'front') { phi = Math.PI / 2 - 0.02; theta = -Math.PI / 2; }
      else { phi = Math.PI / 4; theta = Math.PI / 4; } // iso
      apply();
    };
    // Snap the camera to look from a world-space direction (used by the nav cube).
    this._target = target;
    this._setViewDir = (dx, dy, dz) => {
      const r = Math.hypot(dx, dy, dz) || 1;
      phi = Math.max(0.001, Math.min(Math.PI - 0.001, Math.acos(Math.max(-1, Math.min(1, dy / r)))));
      theta = Math.atan2(dz, dx);
      apply();
    };
    // 45° orbit steps (nav-cube arrows) + home (iso).
    this._rotateView = (dir) => {
      const s = Math.PI / 4;
      if (dir === 'left') theta -= s;
      else if (dir === 'right') theta += s;
      else if (dir === 'up') phi = Math.max(0.05, phi - s);
      else if (dir === 'down') phi = Math.min(Math.PI - 0.05, phi + s);
      apply();
    };
    // Home: face the plate from the front-50 angle, then pull the camera to the
    // exact distance where the whole plate (or the model, if larger) fills the
    // view without clipping. A corner's x/y in camera space don't depend on the
    // distance — only its depth does — so the tight radius is a closed-form max
    // over the corners (accounts for the tilt + the window's aspect ratio).
    this._homePlate = (plateW, modelBox) => {
      const h = plateW / 2;
      target.set(0, 0, 0); // centre on the plate so the plate itself drives the fill
      phi = (40 * Math.PI) / 180; theta = -Math.PI / 2; // front, 50° above the horizon
      const u = new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
      const fwd = u.clone().negate();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      right.normalize();
      const cup = new THREE.Vector3().crossVectors(right, fwd).normalize();
      if (this._resize) this._resize(); // sync the camera aspect to the live canvas before framing
      const tanY = Math.tan((this.camera.fov * Math.PI / 180) / 2);
      const asp = this.camera.aspect || 1;
      const MARGIN = 0.97; // leave a hair so nothing clips
      // Fit the real points — the four plate corners plus the model's own box
      // corners (so a tall part never clips) — NOT their merged AABB, which would
      // invent phantom corners at plate-width × model-height and shrink the view.
      const pts = [];
      for (let i = 0; i < 4; i++) pts.push(new THREE.Vector3(i & 1 ? h : -h, 0, i & 2 ? h : -h));
      if (modelBox && !modelBox.isEmpty()) {
        const b = modelBox;
        for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
      }
      let r = 60;
      for (const p of pts) {
        const c = p.sub(target);
        const need = Math.max(Math.abs(c.dot(cup)) / tanY, Math.abs(c.dot(right)) / (tanY * asp)) / MARGIN;
        r = Math.max(r, c.dot(u) + need);
      }
      radius = r;
      apply();
    };
  }

  // --- transform gizmo (build mode) ----------------------------------------

  _setupGizmo() {
    const g = new TransformControls(this.camera, this.renderer.domElement);
    g.setSize(0.82);
    g.setSpace('world');
    g.addEventListener('dragging-changed', (e) => {
      this._gizmoDragging = e.value;
      if (e.value) {
        this._syncGroupGizmo();
        if (this.transformMode === 'scale' && this.transformSet.length < 2) {
          const em = this.editMeshes.find((m) => m.index === this.selectedIndex);
          const D = 180 / Math.PI;
          this._singleScaleRot = em
            ? [em.mesh.rotation.x * D, em.mesh.rotation.y * D, em.mesh.rotation.z * D]
            : null;
        }
      } else {
        this._singleScaleRot = null;
        if (this.onTransformEnd && this.selectedIndex >= 0) this.onTransformEnd(this.selectedIndex);
      }
    });
    g.addEventListener('objectChange', () => {
      if (this._groupXformLocals) {
        if (this.transformMode === 'scale') this._propagateGroupScaleTransform();
        else this._propagateGroupPivotTransform();
        return;
      }
      const em = this.editMeshes.find((m) => m.index === this.selectedIndex);
      if (!em || !this.onTransform) return;
      const m = em.mesh, D = 180 / Math.PI;
      if (this._outline) { this._outline.position.copy(m.position); this._outline.rotation.copy(m.rotation); this._outline.scale.copy(m.scale); }
      const rot = this.transformMode === 'scale' && this._singleScaleRot
        ? this._singleScaleRot
        : [m.rotation.x * D, m.rotation.y * D, m.rotation.z * D];
      this.onTransform(this.selectedIndex, {
        pos: [m.position.x, m.position.y, m.position.z],
        rot,
        scale: [m.scale.x, m.scale.y, m.scale.z],
      });
    });
    this.scene.add(g.getHelper());
    this.gizmo = g;
    this.setSnap(this.snap);
  }

  setTransformMode(mode) {
    this.transformMode = mode;
    if (this.gizmo) this.gizmo.setMode(mode);
  }

  // With 2+ transform targets (multi-select or a linked group), park the gizmo on a
  // pivot at the selection centre so move/rotate/scale is one rigid body.
  _syncGroupGizmo() {
    const ts = this.transformSet;
    const em = this.editMeshes.find((e) => e.index === this.selectedIndex);
    if (!this.gizmo || !this.editActive) return false;
    if (!em || em.lock) { this._clearGroupPivot(); this.gizmo.detach(); return false; }
    if (ts.length < 2) {
      this._clearGroupPivot();
      this.gizmo.attach(em.mesh);
      this.gizmo.setMode(this.transformMode);
      return false;
    }
    if (!this._groupPivot) {
      this._groupPivot = new THREE.Object3D();
      this.editGroup.add(this._groupPivot);
    }
    const box = new THREE.Box3();
    for (const i of ts) {
      const m = this.editMeshes.find((e) => e.index === i);
      if (m) { m.mesh.updateMatrixWorld(true); box.expandByObject(m.mesh); }
    }
    if (box.isEmpty()) return false;
    box.getCenter(this._xfCenter);
    this._groupPivot.position.copy(this._xfCenter);
    this._groupPivot.rotation.set(0, 0, 0);
    this._groupPivot.scale.set(1, 1, 1);
    this._groupPivot.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this._groupPivot.matrixWorld).invert();
    this._groupXformLocals = [];
    for (const i of ts) {
      const m = this.editMeshes.find((e) => e.index === i);
      if (!m) continue;
      const local = new THREE.Matrix4().copy(m.mesh.matrixWorld).premultiply(inv);
      this._groupXformLocals.push({ index: i, matrix: local });
    }
    this._captureGroupScaleBaseline(ts);
    this.gizmo.attach(this._groupPivot);
    this.gizmo.setMode(this.transformMode);
    return true;
  }

  _captureGroupScaleBaseline(indices) {
    const D = 180 / Math.PI;
    this._groupPivotCenter = this._xfCenter.clone();
    this._groupScaleBaseline = [];
    for (const i of indices) {
      const em = this.editMeshes.find((e) => e.index === i);
      if (!em) continue;
      const m = em.mesh;
      this._groupScaleBaseline.push({
        index: i,
        pos: [m.position.x, m.position.y, m.position.z],
        rot: [m.rotation.x * D, m.rotation.y * D, m.rotation.z * D],
        scale: [m.scale.x, m.scale.y, m.scale.z],
      });
    }
  }

  _clearGroupPivot() {
    this._groupXformLocals = null;
    this._groupScaleBaseline = null;
    this._groupPivotCenter = null;
  }

  // Scale the group around the pivot centre without touching each part's rotation.
  // Matrix decompose would invent euler drift when a scaled pivot is applied to
  // already-rotated members.
  _propagateGroupScaleTransform() {
    if (!this._groupScaleBaseline || !this._groupPivotCenter || !this.onGroupTransform) return;
    const p = this._groupPivot;
    const C = this._groupPivotCenter;
    const fx = p.scale.x, fy = p.scale.y, fz = p.scale.z;
    const rnd = (v, d) => { const x = Math.round(v * 10 ** d) / 10 ** d; return x === 0 ? 0 : x; };
    const updates = [];
    const D = 180 / Math.PI;
    for (const base of this._groupScaleBaseline) {
      const em = this.editMeshes.find((e) => e.index === base.index);
      if (!em) continue;
      const nx = C.x + (base.pos[0] - C.x) * fx;
      const ny = C.y + (base.pos[1] - C.y) * fy;
      const nz = C.z + (base.pos[2] - C.z) * fz;
      const ns = [base.scale[0] * fx, base.scale[1] * fy, base.scale[2] * fz];
      em.mesh.position.set(nx, ny, nz);
      em.mesh.scale.set(ns[0], ns[1], ns[2]);
      em.mesh.rotation.set(base.rot[0] / D, base.rot[1] / D, base.rot[2] / D);
      updates.push({
        index: base.index,
        pos: [rnd(nx, 2), rnd(ny, 2), rnd(nz, 2)],
        rot: base.rot.map((v) => rnd(v, 2)),
        scale: ns.map((v) => rnd(v, 3)),
      });
    }
    const primary = this.editMeshes.find((e) => e.index === this.selectedIndex);
    if (primary && this._outline) {
      this._outline.position.copy(primary.mesh.position);
      this._outline.rotation.copy(primary.mesh.rotation);
      this._outline.scale.copy(primary.mesh.scale);
    }
    this.onGroupTransform(updates);
  }

  _propagateGroupPivotTransform() {
    if (!this._groupXformLocals || !this._groupPivot || !this.onGroupTransform) return;
    this._groupPivot.updateMatrixWorld(true);
    const D = 180 / Math.PI;
    const rnd = (v, p) => { const x = Math.round(v * 10 ** p) / 10 ** p; return x === 0 ? 0 : x; };
    const updates = [];
    for (const loc of this._groupXformLocals) {
      const em = this.editMeshes.find((e) => e.index === loc.index);
      if (!em) continue;
      const world = new THREE.Matrix4().multiplyMatrices(this._groupPivot.matrixWorld, loc.matrix);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
      world.decompose(pos, quat, scale);
      em.mesh.position.copy(pos);
      em.mesh.quaternion.copy(quat);
      em.mesh.scale.copy(scale);
      const euler = new THREE.Euler().setFromQuaternion(quat, 'ZYX');
      updates.push({
        index: loc.index,
        pos: [rnd(pos.x, 2), rnd(pos.y, 2), rnd(pos.z, 2)],
        rot: [rnd(euler.x * D, 2), rnd(euler.y * D, 2), rnd(euler.z * D, 2)],
        scale: [rnd(scale.x, 3), rnd(scale.y, 3), rnd(scale.z, 3)],
      });
    }
    const primary = this.editMeshes.find((e) => e.index === this.selectedIndex);
    if (primary && this._outline) {
      this._outline.position.copy(primary.mesh.position);
      this._outline.rotation.copy(primary.mesh.rotation);
      this._outline.scale.copy(primary.mesh.scale);
    }
    this.onGroupTransform(updates);
  }

  setSnap(on) {
    this.snap = on;
    if (this.gizmo) {
      this.gizmo.setTranslationSnap(on ? this.snapStep : null);
      this.gizmo.setRotationSnap(on ? Math.PI / 12 : null); // 15°
      this.gizmo.setScaleSnap(on ? 0.1 : null);
    }
    return on;
  }

  // Shift every selected shape's mesh by a delta (language frame), without
  // rebuilding geometry — used for keyboard nudge so threaded parts don't
  // re-mesh on every key press.
  shiftSelected(dx, dy, dz) {
    for (const e of this.editMeshes) {
      if (!this.transformSet.includes(e.index)) continue;
      e.mesh.position.x += dx; e.mesh.position.y += dy; e.mesh.position.z += dz;
    }
    const em = this.editMeshes.find((e) => e.index === this.selectedIndex);
    if (em && this._outline) this._outline.position.copy(em.mesh.position);
  }

  // Bounding-box z range of a shape relative to its origin, with its current
  // rotation + scale baked in (used to drop it onto the plate).
  shapeExtent(index) {
    const em = this.editMeshes.find((e) => e.index === index);
    if (!em) return null;
    const g = em.mesh.geometry;
    g.computeBoundingBox();
    const mat = new THREE.Matrix4().compose(new THREE.Vector3(), em.mesh.quaternion, em.mesh.scale);
    const bb = g.boundingBox.clone().applyMatrix4(mat);
    return { minZ: bb.min.z, maxZ: bb.max.z };
  }

  // Local Z-extent of a shape (scale baked, NO rotation) — the distance from its
  // origin to its base, used to seat it on a picked face along the face normal.
  shapeLocalZ(index) {
    const em = this.editMeshes.find((e) => e.index === index);
    if (!em) return null;
    const g = em.mesh.geometry;
    g.computeBoundingBox();
    const sz = em.mesh.scale.z || 1;
    return { minZ: g.boundingBox.min.z * sz, maxZ: g.boundingBox.max.z * sz };
  }

  // Absolute AABB of a shape in the editGroup (language) frame — for aligning
  // shapes by their min / centre / max edges.
  shapeBounds(index) {
    const em = this.editMeshes.find((e) => e.index === index);
    if (!em) return null;
    const g = em.mesh.geometry;
    g.computeBoundingBox();
    const mat = new THREE.Matrix4().compose(new THREE.Vector3(), em.mesh.quaternion, em.mesh.scale);
    const bb = g.boundingBox.clone().applyMatrix4(mat);
    const p = em.mesh.position;
    return { min: [bb.min.x + p.x, bb.min.y + p.y, bb.min.z + p.z], max: [bb.max.x + p.x, bb.max.y + p.y, bb.max.z + p.z] };
  }

  // --- magnetic snap (drag parts together) ----------------------------------
  // The dragged part's XY box relative to its own origin (rotation + scale baked
  // in), and the same for a fixed part but in absolute editGroup coordinates.
  _meshLocalBox(mesh) {
    const g = mesh.geometry; g.computeBoundingBox();
    const mat = new THREE.Matrix4().compose(new THREE.Vector3(), mesh.quaternion, mesh.scale);
    const bb = g.boundingBox.clone().applyMatrix4(mat);
    return { minX: bb.min.x, maxX: bb.max.x, minY: bb.min.y, maxY: bb.max.y };
  }

  _meshWorldBox(mesh) {
    const b = this._meshLocalBox(mesh);
    const p = mesh.position;
    return { minX: b.minX + p.x, maxX: b.maxX + p.x, minY: b.minY + p.y, maxY: b.maxY + p.y };
  }

  // Pull the dragged origin to the nearest edge/centre alignment with another
  // part, per axis, within magnetDist. Candidates per target: align min/centre/
  // max edges, or abut (our edge meets theirs so the parts touch). Returns the
  // adjusted x/y and the guide line(s) it locked onto.
  _applyMagnet(nx, ny) {
    const out = { x: nx, y: ny, guides: [] };
    if (!this.magnet || this._magnetSuppressed || !this._dragBox
        || !this._magnetTargets || !this._magnetTargets.length) return out;
    const db = this._dragBox, T = this.magnetDist;
    const r2 = (v) => Math.round(v * 100) / 100;
    for (const ax of ['X', 'Y']) {
      const lo0 = db['min' + ax], hi0 = db['max' + ax], c0 = (lo0 + hi0) / 2;
      const p = ax === 'X' ? nx : ny;
      let best = null;
      for (const t of this._magnetTargets) {
        const tlo = t['min' + ax], thi = t['max' + ax], tc = (tlo + thi) / 2;
        const cands = [
          [tlo - lo0, tlo], [thi - hi0, thi], [tc - c0, tc], // align min / max / centre
          [tlo - hi0, tlo], [thi - lo0, thi],                 // abut (touch)
        ];
        for (const [pos, at] of cands) {
          const d = Math.abs(pos - p);
          if (d <= T && (!best || d < best.d)) best = { d, pos, at, t };
        }
      }
      if (best) {
        if (ax === 'X') out.x = r2(best.pos); else out.y = r2(best.pos);
        out.guides.push({ axis: ax, at: best.at, t: best.t });
      }
    }
    return out;
  }

  _showSnapGuides(guides, z) {
    this._clearSnapGuides();
    if (!guides || !guides.length) return;
    const pts = [];
    for (const g of guides) {
      if (g.axis === 'X') { pts.push(g.at, g.t.minY - 10, z, g.at, g.t.maxY + 10, z); }
      else { pts.push(g.t.minX - 10, g.at, z, g.t.maxX + 10, g.at, z); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0xffb74d, transparent: true, opacity: 0.9, depthTest: false }));
    lines.renderOrder = 9;
    this.editGroup.add(lines);
    this._snapGuides = lines;
  }

  _clearSnapGuides() {
    if (!this._snapGuides) return;
    this.editGroup.remove(this._snapGuides);
    this._snapGuides.geometry.dispose();
    this._snapGuides.material.dispose();
    this._snapGuides = null;
  }

  // --- workplane (face-based placement frame) -------------------------------
  // Arm the next canvas click to pick a face. cb receives {origin, normal, rot}
  // in the language frame (rot = Euler ZYX degrees that aligns +Z to the face
  // normal) or null when the click misses every shape (= reset to ground).
  armWorkplanePick(cb) {
    this._planePick = cb;
    this.canvas.style.cursor = 'crosshair';
  }

  _doPlanePick(x, y) {
    const cb = this._planePick;
    this._planePick = null;
    this.canvas.style.cursor = '';
    this.editGroup.updateMatrixWorld(true); // ensure picks use current mesh transforms
    this._raycaster.setFromCamera(this._ndcFrom(x, y), this.camera);
    const hits = this._raycaster.intersectObjects(this.editMeshes.map((e) => e.mesh), false);
    if (!hits.length || !hits[0].face) { if (cb) cb(null); return; }
    const hit = hits[0];
    const pLocal = this.editGroup.worldToLocal(hit.point.clone());
    const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    const nWorld = hit.face.normal.clone().applyMatrix3(nm).normalize();
    const gq = this.editGroup.getWorldQuaternion(new THREE.Quaternion());
    const nLocal = nWorld.applyQuaternion(gq.invert()).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), nLocal);
    const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
    const D = 180 / Math.PI;
    const r = (v) => { const z = Math.round(v * D * 100) / 100; return z === 0 ? 0 : z; };
    if (cb) cb({
      origin: [pLocal.x, pLocal.y, pLocal.z].map((v) => Math.round(v * 100) / 100),
      normal: [nLocal.x, nLocal.y, nLocal.z],
      rot: [r(e.x), r(e.y), r(e.z)],
    });
  }

  // Show / hide the translucent workplane indicator (info in language frame).
  setWorkplane(info) {
    if (this._wpMesh) {
      this.editGroup.remove(this._wpMesh);
      this._wpMesh.geometry.dispose(); this._wpMesh.material.dispose();
      this._wpMesh = null;
    }
    if (!info) return;
    const geo = new THREE.PlaneGeometry(140, 140);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4dd0e1, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(info.normal[0], info.normal[1], info.normal[2]));
    mesh.position.set(info.origin[0], info.origin[1], info.origin[2]);
    mesh.renderOrder = 2;
    this.editGroup.add(mesh);
    this._wpMesh = mesh;
  }

  // --- code mode: one merged solid -----------------------------------------

  // Empty modelGroup, freeing geometries and any per-mesh (non-shared)
  // materials. Shared materials (model/overhang/edge) are kept — only the
  // unique ones made by setColoredModel/highlightSolid get disposed.
  _wipeModelGroup() {
    while (this.modelGroup.children.length) {
      const child = this.modelGroup.children.pop();
      child.geometry?.dispose();
      const m = child.material;
      if (m && m !== this.material && m !== this.overhangMaterial && m !== this.edgeMaterial) m.dispose();
      this.modelGroup.remove(child);
    }
  }

  setModel(manifold, { showEdges = true } = {}) {
    if (this._measure && this._measure.a) this._clearMeasure(); // points reference old geometry
    this.clearHighlight(); // its geometry/material are ours to free before the wipe
    this._wipeModelGroup();
    if (!manifold) return;

    const geom = manifoldToGeometry(manifold);
    geom.rotateX(-Math.PI / 2); // Manifold Z-up -> scene Y-up
    const mesh = new THREE.Mesh(geom, this.overhangView ? this.overhangMaterial : this.material);
    this.modelGroup.add(mesh);

    if (showEdges) {
      const edges = new THREE.LineSegments(edgesGeometry(geom), this.edgeMaterial);
      this.modelGroup.add(edges);
    }

    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    this.modelGroup.position.y = -bb.min.y; // drop onto the plate
  }

  // Like setModel, but draws each top-level part in its own colour (build
  // mode's result view) so toggling edit->result only cuts holes + locks the
  // parts, instead of flipping everything to one flat teal. Holes are already
  // subtracted per part. parts: [{ manifold, color }].
  setColoredModel(parts, { showEdges = true } = {}) {
    if (this._measure && this._measure.a) this._clearMeasure();
    this.clearHighlight();
    this._wipeModelGroup();
    if (!parts || !parts.length) return;

    let minY = Infinity;
    for (const [i, p] of parts.entries()) {
      if (!p || !p.manifold) continue;
      const geom = manifoldToGeometry(p.manifold);
      geom.rotateX(-Math.PI / 2); // Manifold Z-up -> scene Y-up
      const mat = this.overhangView
        ? this.overhangMaterial
        : new THREE.MeshStandardMaterial({
            color: p.color || COLORS.model, metalness: 0.1, roughness: 0.55,
          });
      // Parts can abut or overlap (e.g. a post resting on a slab). They are
      // drawn as separate solids, so their coincident faces z-fight into a
      // shimmering "uneven surface". A small per-part depth bias makes later
      // parts win those ties consistently instead of flickering. Purely visual —
      // geometry and exports are unchanged. (Overhang view shares one material.)
      if (!this.overhangView && i > 0) {
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = -i;
        mat.polygonOffsetUnits = -i;
      }
      this.modelGroup.add(new THREE.Mesh(geom, mat));
      if (showEdges) this.modelGroup.add(new THREE.LineSegments(edgesGeometry(geom), this.edgeMaterial));
      geom.computeBoundingBox();
      if (geom.boundingBox.min.y < minY) minY = geom.boundingBox.min.y;
    }
    this.modelGroup.position.y = Number.isFinite(minY) ? -minY : 0; // drop onto the plate
  }

  // A translucent overlay of the combined result, shown over the editable parts
  // (Option A). Lives in editGroup (language frame) so it lines up with the
  // parts — no rotate/drop, unlike setModel.
  setGhost(manifold) {
    if (this._ghostMesh) {
      this.editGroup.remove(this._ghostMesh);
      this._ghostMesh.geometry.dispose();
      this._ghostMesh.material.dispose();
      this._ghostMesh = null;
    }
    if (!manifold) return;
    const geom = manifoldToGeometry(manifold);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4dd0e1, transparent: true, opacity: 0.18, depthWrite: false,
      side: THREE.DoubleSide, roughness: 0.5, metalness: 0,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 4;
    this.editGroup.add(mesh);
    this._ghostMesh = mesh;
  }

  // Glow one shape inside the merged (code-mode) model: the object whose code
  // the caret is in. Added to modelGroup so it inherits the same drop offset as
  // the merged mesh; depthTest off so it shows through as an amber silhouette
  // even when the shape is buried inside (or subtracted from) the body.
  highlightSolid(manifold) {
    this.clearHighlight();
    if (!manifold) return;
    const geom = manifoldToGeometry(manifold);
    geom.rotateX(-Math.PI / 2); // match setModel's Z-up -> Y-up
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffb74d, emissive: 0xff9800, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.5, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide, roughness: 0.4, metalness: 0,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 10;
    this.modelGroup.add(mesh);
    this._hlMesh = mesh;
  }

  clearHighlight() {
    if (!this._hlMesh) return;
    this.modelGroup.remove(this._hlMesh);
    this._hlMesh.geometry.dispose();
    this._hlMesh.material.dispose();
    this._hlMesh = null;
  }

  // --- layer preview: slice the model into printed layers -------------------
  // Slices `model` every layerH and draws each layer's outline as a line loop,
  // so you can scrub through and watch the print build up. Returns the layer count.
  showLayers(model) {
    this.hideLayers();
    if (!model) return 0;
    let bb; try { bb = model.boundingBox(); } catch { return 0; }
    const minZ = bb.min[2], maxZ = bb.max[2], H = maxZ - minZ;
    if (H <= 0.01) return 0;
    let layerH = 0.4;
    if (H / layerH > 200) layerH = H / 200; // cap the layer count so slicing stays snappy
    const n = Math.max(1, Math.floor(H / layerH));

    const grp = new THREE.Group();
    grp.rotation.x = -Math.PI / 2;  // manifold Z-up -> scene Y-up (match setModel)
    grp.position.y = -minZ;         // drop the bottom layer onto the plate
    this._layerMat = new THREE.LineBasicMaterial({ color: COLORS.model });
    this._layerTop = new THREE.LineBasicMaterial({ color: 0xffb74d }); // current (top) layer
    this._layerObjs = [];

    for (let i = 0; i < n; i++) {
      const z = minZ + (i + 0.5) * layerH;
      let cs = null, polys = null;
      try { cs = model.slice(z); polys = cs.toPolygons(); } catch { /* skip */ }
      if (cs) { try { cs.delete(); } catch { /* freed */ } }
      const pts = [];
      if (polys) for (const poly of polys) {
        const k = poly.length;
        for (let j = 0; j < k; j++) {
          const a = poly[j], b = poly[(j + 1) % k];
          pts.push(a[0], a[1], z, b[0], b[1], z);
        }
      }
      if (!pts.length) { this._layerObjs.push(null); continue; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const line = new THREE.LineSegments(g, this._layerMat);
      grp.add(line);
      this._layerObjs.push(line);
    }

    this.scene.add(grp);
    this._layerGroup = grp;
    this.modelGroup.visible = false;
    this.editGroup.visible = false;
    if (this.gizmo) this.gizmo.detach();
    this.setLayerVisible(this._layerObjs.length - 1);
    return this._layerObjs.length;
  }

  setLayerVisible(n) {
    if (!this._layerObjs) return;
    this._layerObjs.forEach((o, i) => {
      if (!o) return;
      o.visible = i <= n;
      o.material = (i === n) ? this._layerTop : this._layerMat;
    });
  }

  hideLayers() {
    if (!this._layerGroup) return;
    this._layerGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.scene.remove(this._layerGroup);
    this._layerGroup = null; this._layerObjs = null;
    if (this._layerMat) { this._layerMat.dispose(); this._layerMat = null; }
    if (this._layerTop) { this._layerTop.dispose(); this._layerTop = null; }
  }

  // --- build mode: many selectable shapes -----------------------------------

  setEditMode(on) {
    this.editActive = on;
    this.editGroup.visible = on;
    this.modelGroup.visible = !on;
    // Leaving edit mode (result view or code mode): drop the outline AND detach
    // the transform gizmo, or its handles linger floating where the part was.
    if (!on) { this._clearOutline(); if (this.gizmo) this.gizmo.detach(); }
  }

  setEditShapes(items) {
    if (this._measure && this._measure.a) this._clearMeasure(); // points reference old geometry
    // free previous meshes/geometries
    for (const e of this.editMeshes) {
      this.editGroup.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh.material.dispose();
    }
    this.editMeshes = [];
    this._clearOutline();

    for (const it of items) {
      const isHole = it.op === 'hole';
      // DoubleSide so a mirrored (negative-scale) shape still renders lit.
      const mat = isHole
        ? new THREE.MeshStandardMaterial({
            color: COLORS.hole, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
            roughness: 0.6, metalness: 0, depthWrite: false, wireframe: this._wire })
        : new THREE.MeshStandardMaterial({
            color: it.color || COLORS.model, metalness: 0.1, roughness: 0.55,
            side: THREE.DoubleSide, wireframe: this._wire });
      const mesh = new THREE.Mesh(it.geometry, mat);
      mesh.position.set(it.pos[0], it.pos[1], it.pos[2]);
      const r = it.rot || [0, 0, 0];
      // Match manifold's rotate(x,y,z) (extrinsic X->Y->Z) so the preview and the
      // gizmo read-back agree with the compiled/exported solid. Extrinsic XYZ == three Euler 'ZYX'.
      mesh.rotation.order = 'ZYX';
      mesh.rotation.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180);
      const s = it.scale || [1, 1, 1];
      mesh.scale.set(s[0], s[1], s[2]);
      mesh.userData.index = it.index;
      mesh.renderOrder = isHole ? 1 : 0;
      this.editGroup.add(mesh);
      this.editMeshes.push({ index: it.index, mesh, op: it.op, lock: it.lock });
    }

    const valid = this.selectedSet.filter((i) => this.editMeshes.some((e) => e.index === i));
    this.setSelection(valid);
  }

  // Highlight a set of shapes; the LAST one is the primary (outline). Gizmo uses
  // transformSet (selection + group members) for rigid multi-part transforms.
  setSelection(indices, transformSet) {
    this.selectedSet = (indices || []).slice();
    this.transformSet = transformSet
      ? transformSet.slice()
      : (this.getTransformSet ? this.getTransformSet() : this.selectedSet);
    this.selectedIndex = this.selectedSet.length ? this.selectedSet[this.selectedSet.length - 1] : -1;
    this._clearOutline();
    for (const e of this.editMeshes) {
      const sel = this.transformSet.includes(e.index);
      const glow = e.op === 'hole' ? COLORS.glowHole : COLORS.glowSolid;
      e.mesh.material.emissive.setHex(sel ? glow : 0x000000);
    }
    const em = this.editMeshes.find((e) => e.index === this.selectedIndex);
    if (em) {
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(em.mesh.geometry, 20),
        new THREE.LineBasicMaterial({ color: 0xffffff }));
      line.position.copy(em.mesh.position);
      line.rotation.copy(em.mesh.rotation);
      line.scale.copy(em.mesh.scale);
      line.renderOrder = 2;
      this.editGroup.add(line);
      this._outline = line;
    }
    if (this.gizmo) {
      if (em && !em.lock && this.editActive) this._syncGroupGizmo();
      else this.gizmo.detach();
    }
  }

  selectIndex(i) { this.setSelection(i < 0 ? [] : [i]); }

  _clearOutline() {
    if (this._outline) {
      this.editGroup.remove(this._outline);
      this._outline.geometry.dispose();
      this._outline.material.dispose();
      this._outline = null;
    }
  }

  frameModel(sizeMm) {
    if (this._frameModel) this._frameModel(sizeMm);
  }

  // Fit the camera to whatever's currently shown (model in code mode, the
  // shapes group in build mode).
  fitView() {
    const box = new THREE.Box3();
    const group = this.editActive ? this.editGroup : this.modelGroup;
    group.traverse((o) => { if (o.isMesh) box.expandByObject(o); });
    const size = new THREE.Vector3();
    if (box.isEmpty()) size.set(60, 60, 60); else box.getSize(size);
    this.frameModel({ x: size.x, y: size.y, z: size.z });
  }

  setView(which) { if (this._setView) this._setView(which); }
  setViewDir(d) { if (this._setViewDir) this._setViewDir(d.x, d.y, d.z); }
  rotateView(dir) { if (this._rotateView) this._rotateView(dir); }
  homeView() {
    // Home fills the view with the whole build plate (or the model, if larger),
    // from the front-50 angle. The ⤢ Fit button is the one that zooms to the model.
    const plate = this._plateW || 220;
    const box = new THREE.Box3();
    const group = this.editActive ? this.editGroup : this.modelGroup;
    group.traverse((o) => { if (o.isMesh) box.expandByObject(o); });
    if (this._homePlate) this._homePlate(plate, box);
  }

  // --- navigation cube (FreeCAD-style) -------------------------------------
  // A small labelled cube in the corner that mirrors the camera orientation;
  // tap a face / edge / corner to snap to that orthographic or iso view.
  _setupNavCube() {
    const wrap = document.createElement('div');
    wrap.id = 'nav-widget';
    wrap.innerHTML =
      '<div id="nav-cube-wrap">'
      + '<button class="nav-arrow nav-up" data-rot="up" title="Tilt up">▴</button>'
      + '<button class="nav-arrow nav-down" data-rot="down" title="Tilt down">▾</button>'
      + '<button class="nav-arrow nav-left" data-rot="left" title="Turn left">◂</button>'
      + '<button class="nav-arrow nav-right" data-rot="right" title="Turn right">▸</button>'
      + '</div>'
      + '<canvas id="nav-axis" title="Tap an axis to look down it"></canvas>';
    (this.canvas.parentElement || document.body).appendChild(wrap);
    const cubeWrap = wrap.querySelector('#nav-cube-wrap');

    // --- the cube ---
    const SZ = 80;
    const cv = document.createElement('canvas');
    cv.id = 'nav-cube';
    cv.title = 'Tap a face / edge / corner to snap the view';
    cubeWrap.insertBefore(cv, cubeWrap.firstChild);
    this._navCanvas = cv;
    const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(SZ, SZ, false);
    this._navRenderer = r;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 0.55); key.position.set(2, 3, 4); scene.add(key);
    this._navScene = scene;
    // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z
    const labels = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'];
    const mats = labels.map((t) => new THREE.MeshLambertMaterial({ map: this._faceTexture(t) }));
    this._navMats = mats;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mats);
    cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0x4dd0e1, transparent: true, opacity: 0.55 })));
    scene.add(cube);
    this._navCube = cube;
    this._navCamera = new THREE.PerspectiveCamera(36, 1, 0.1, 20);
    this._navRay = new THREE.Raycaster();
    cv.addEventListener('pointermove', (e) => this._navHover(e.clientX, e.clientY));
    cv.addEventListener('pointerleave', () => this._highlightFace(-1));
    cv.addEventListener('click', (e) => { e.preventDefault(); this._navCubePick(e.clientX, e.clientY); });

    // --- rotate arrows + home ---
    wrap.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.rotateView(b.dataset.rot); }));
    // home now lives on the left rail (a single reframe button) — no nav-cube home

    // --- the axis gizmo (Blender-style) ---
    this._setupNavAxis(wrap.querySelector('#nav-axis'));
  }

  _faceTexture(text) {
    const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
    const x = c.getContext('2d');
    x.fillStyle = '#272c33'; x.fillRect(0, 0, s, s);
    x.strokeStyle = '#3a424b'; x.lineWidth = 6; x.strokeRect(4, 4, s - 8, s - 8);
    x.fillStyle = '#e8eaed'; x.font = 'bold 21px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, s / 2, s / 2);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
  }

  _renderNavCube() {
    if (!this._navRenderer || !this._target) return;
    const dir = this.camera.position.clone().sub(this._target);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize().multiplyScalar(2.6);
    this._navCamera.position.copy(dir);
    this._navCamera.up.copy(this.camera.up);
    this._navCamera.lookAt(0, 0, 0);
    this._navRenderer.render(this._navScene, this._navCamera);
  }

  // Tap on the cube → the clicked zone (face / edge / corner) → a snap direction.
  _navCubePick(clientX, clientY) {
    const rect = this._navCanvas.getBoundingClientRect();
    this._navRay.setFromCamera(new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ), this._navCamera);
    const hit = this._navRay.intersectObject(this._navCube, false)[0];
    if (!hit) return;
    const p = hit.point; // on a unit cube (±0.5)
    const comp = [p.x, p.y, p.z].map((v) => (Math.abs(v) > 0.31 ? Math.sign(v) : 0));
    if (comp.some(Boolean)) this.setViewDir({ x: comp[0], y: comp[1], z: comp[2] });
  }

  _navHover(clientX, clientY) {
    const rect = this._navCanvas.getBoundingClientRect();
    this._navRay.setFromCamera(new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ), this._navCamera);
    const hit = this._navRay.intersectObject(this._navCube, false)[0];
    this._highlightFace(hit && hit.face ? hit.face.materialIndex : -1);
  }

  _highlightFace(idx) {
    if (this._navMats) this._navMats.forEach((m, i) => m.emissive.setHex(i === idx ? 0x16424a : 0x000000));
  }

  // --- axis gizmo (Blender-style): red/green/blue X·Y·Z balls, tap to snap ---
  _setupNavAxis(cv) {
    const SZ = 56;
    this._axisCanvas = cv;
    const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(SZ, SZ, false);
    this._axisRenderer = r;
    const scene = new THREE.Scene(); this._axisScene = scene;
    const AX = [
      { dir: [1, 0, 0], col: 0xef5350 }, { dir: [-1, 0, 0], col: 0xef5350 },
      { dir: [0, 1, 0], col: 0x66bb6a }, { dir: [0, -1, 0], col: 0x66bb6a },
      { dir: [0, 0, 1], col: 0x4dd0e1 }, { dir: [0, 0, -1], col: 0x4dd0e1 },
    ];
    AX.filter((a) => a.dir.some((v) => v > 0)).forEach((a) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...a.dir)]);
      scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: a.col })));
    });
    this._axisBalls = [];
    AX.forEach((a) => {
      const pos = a.dir.some((v) => v > 0);
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(pos ? 0.22 : 0.15, 16, 12),
        new THREE.MeshBasicMaterial({ color: a.col, transparent: !pos, opacity: pos ? 1 : 0.35 }),
      );
      ball.position.set(...a.dir);
      ball.userData.dir = a.dir;
      scene.add(ball); this._axisBalls.push(ball);
    });
    this._axisCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
    this._axisRay = new THREE.Raycaster();
    cv.addEventListener('click', (e) => { e.preventDefault(); this._navAxisPick(e.clientX, e.clientY); });
  }

  _renderNavAxis() {
    if (!this._axisRenderer || !this._target) return;
    const dir = this.camera.position.clone().sub(this._target);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize().multiplyScalar(3.2);
    this._axisCamera.position.copy(dir);
    this._axisCamera.up.copy(this.camera.up);
    this._axisCamera.lookAt(0, 0, 0);
    this._axisRenderer.render(this._axisScene, this._axisCamera);
  }

  _navAxisPick(clientX, clientY) {
    const rect = this._axisCanvas.getBoundingClientRect();
    this._axisRay.setFromCamera(new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ), this._axisCamera);
    const hit = this._axisRay.intersectObjects(this._axisBalls, false)[0];
    if (hit) { const d = hit.object.userData.dir; this.setViewDir({ x: d[0], y: d[1], z: d[2] }); }
  }

  toggleGrid() {
    const v = !this.grid.visible;
    this.grid.visible = v;
    this.plate.visible = v;
    if (this.buildVolume) this.buildVolume.visible = v;
    if (this.fineGrid) this.fineGrid.visible = v && this._fineWanted;
    return v;
  }

  // The fine 1 mm grid (only shows while the main grid is on). While it's on,
  // the 10 mm (cm) lines turn blue so they read clearly over the fine mesh.
  toggleFineGrid() {
    this._fineWanted = !this._fineWanted;
    if (this.fineGrid) this.fineGrid.visible = this._fineWanted && this.grid.visible;
    this._setCmLinesBlue(this._fineWanted);
    return this._fineWanted;
  }

  _setCmLinesBlue(blue) {
    const m = this.grid && this.grid.material;
    if (!m) return;
    m.vertexColors = !blue;                                 // blue → uniform material colour on every cm line
    m.color.set(blue ? COLORS.gridCm : 0xffffff);           // white lets the baked grey vertex colours show again
    m.needsUpdate = true;
  }

  // Switch the whole 3D scene between dark and light. CSS themes the surrounding
  // UI; this themes everything drawn in WebGL. Edit-mode part meshes carry their
  // own per-part colours and are re-tinted by the caller via a recompile.
  setTheme(theme) {
    Object.assign(COLORS, theme === 'light' ? LIGHT : DARK);
    if (this.scene.background) this.scene.background.set(COLORS.bg);
    if (this.plate) this.plate.material.color.set(COLORS.plate);
    if (this.material) this.material.color.set(COLORS.model);
    if (this.overhangMaterial) this.overhangMaterial.color.set(COLORS.model);
    if (this.edgeMaterial) this.edgeMaterial.color.set(COLORS.edge);
    if (this.buildVolume) this.buildVolume.material.color.set(COLORS.buildVol);
    this._rebuildGrids();
  }

  // Recreate both grids with the active palette, preserving the user's grid-on
  // and mm-grid toggles (GridHelper colours are baked, so we rebuild to recolour).
  _rebuildGrids() {
    const vis = this.grid ? this.grid.visible : true;
    [this.grid, this.fineGrid].forEach((g) => {
      if (!g) return;
      this.scene.remove(g);
      g.geometry.dispose();
      g.material.dispose();
    });
    this._addGrids(this._plateW || 220);
    this.grid.visible = vis;
    this.fineGrid.visible = this._fineWanted && vis;
  }

  // Overhang analysis: recolour the result mesh so steep downward faces (which
  // need support) show amber -> red. Operates on the merged model mesh.
  setOverhangView(on) {
    this.overhangView = !!on;
    const m = this.overhangView ? this.overhangMaterial : this.material;
    for (const c of this.modelGroup.children) if (c.isMesh) c.material = m;
    return this.overhangView;
  }

  toggleWireframe() {
    this._wire = !this._wire;
    this.material.wireframe = this._wire;
    this.editMeshes.forEach((e) => { e.mesh.material.wireframe = this._wire; });
    return this._wire;
  }

  _resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this._resize();
    this._updateMeasureLabel();
    this._updateXformReadout();
    this.renderer.render(this.scene, this.camera);
    this._renderNavCube();
    this._renderNavAxis();
  }
}
