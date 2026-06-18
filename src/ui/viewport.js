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
  model: 0x4dd0e1,
  edge: 0x1a1d21,
  plate: 0x202428,
  hole: 0xef5350,
  glowSolid: 0x2a6b78,
  glowHole: 0x5a1a18,
};

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
    this.transformMode = 'translate';
    this._gizmoDragging = false;
    this.onSelect = null;          // (index | -1)
    this.onContext = null;         // (index | -1, clientX, clientY) — right-click
    this.onShapeMove = null;       // (index, [x,y,z]) — live during drag
    this.onShapeMoveEnd = null;    // (index, [x,y,z])
    this.onTransform = null;       // (index, {pos,rot,scale}) — live during gizmo drag
    this.onTransformEnd = null;    // (index)
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._outline = null;

    this._setupControls();
    this._setupGizmo();
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

    const grid = new THREE.GridHelper(w, w / 10, COLORS.gridMajor, COLORS.grid);
    this.scene.add(grid);
    this.grid = grid;
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

  _setupControls() {
    let dragging = false, panning = false, shapeDrag = false, downOnCanvas = false, downAdditive = false;
    let lastX = 0, lastY = 0, downX = 0, downY = 0, moved = 0;
    let theta = Math.PI / 4, phi = Math.PI / 4, radius = 200;
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
    const zoom = (delta) => { radius = Math.max(20, Math.min(1200, radius * (1 + delta * 0.001))); apply(); };

    const beginShapeDrag = (hit, additive) => {
      const idx = hit.object.userData.index;
      if (this.onSelect) this.onSelect(idx, additive);
      if (additive) return; // shift-click toggles selection, no drag
      const locked = this.editMeshes.find((e) => e.index === idx)?.lock;
      if (locked) return; // select only — don't move a locked shape
      shapeDrag = true;
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
        .filter((e) => !this.selectedSet.includes(e.index))
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
      if (this.selectedSet.length > 1) {
        for (const e of this.editMeshes) {
          if (e === em || !this.selectedSet.includes(e.index)) continue;
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
      downOnCanvas = true; downAdditive = additive;
      downX = x; downY = y; moved = 0;
      const hit = pan ? null : this._pickShape(x, y);
      if (hit) beginShapeDrag(hit, additive);
      else startOrbit(x, y, pan);
    };
    const onMove = (x, y) => {
      moved = Math.max(moved, Math.hypot(x - downX, y - downY));
      if (shapeDrag) moveShape(x, y);
      else if (dragging) moveOrbit(x, y);
    };
    const onUp = () => {
      if (!downOnCanvas) return; // ignore mouseups that didn't start on the canvas (e.g. panel clicks)
      downOnCanvas = false;
      if (shapeDrag) {
        const em = this.editMeshes.find((e) => e.index === this.selectedIndex);
        if (em && this.onShapeMoveEnd) this.onShapeMoveEnd(this.selectedIndex,
          [em.mesh.position.x, em.mesh.position.y, em.mesh.position.z]);
        shapeDrag = false;
        this._clearSnapGuides();
        this._magnetTargets = null; this._dragBox = null;
      } else if (this.editActive && moved < 4 && !downAdditive) {
        // a click on empty space clears the selection
        if (!this._pickShape(downX, downY) && this.onSelect) this.onSelect(-1, false);
      }
      dragging = false; panning = false;
    };

    const c = this.canvas;
    c.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY, e.button === 2, e.shiftKey || this.multiSelect));
    window.addEventListener('mousemove', (e) => { if (dragging || shapeDrag) { this._magnetSuppressed = e.altKey; onMove(e.clientX, e.clientY); } });
    window.addEventListener('mouseup', onUp);
    c.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY); }, { passive: false });
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
        zoom((pinchDist - d) * 2);
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
  }

  // --- transform gizmo (build mode) ----------------------------------------

  _setupGizmo() {
    const g = new TransformControls(this.camera, this.renderer.domElement);
    g.setSize(0.82);
    g.setSpace('world');
    g.addEventListener('dragging-changed', (e) => {
      this._gizmoDragging = e.value;
      if (!e.value && this.onTransformEnd && this.selectedIndex >= 0) this.onTransformEnd(this.selectedIndex);
    });
    g.addEventListener('objectChange', () => {
      const em = this.editMeshes.find((m) => m.index === this.selectedIndex);
      if (!em || !this.onTransform) return;
      const m = em.mesh, D = 180 / Math.PI;
      if (this._outline) { this._outline.position.copy(m.position); this._outline.rotation.copy(m.rotation); this._outline.scale.copy(m.scale); }
      this.onTransform(this.selectedIndex, {
        pos: [m.position.x, m.position.y, m.position.z],
        rot: [m.rotation.x * D, m.rotation.y * D, m.rotation.z * D],
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
      if (!this.selectedSet.includes(e.index)) continue;
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

  setModel(manifold, { showEdges = true } = {}) {
    this.clearHighlight(); // its geometry/material are ours to free before the wipe
    while (this.modelGroup.children.length) {
      const child = this.modelGroup.children.pop();
      child.geometry?.dispose();
      this.modelGroup.remove(child);
    }
    if (!manifold) return;

    const geom = manifoldToGeometry(manifold);
    geom.rotateX(-Math.PI / 2); // Manifold Z-up -> scene Y-up
    const mesh = new THREE.Mesh(geom, this.material);
    this.modelGroup.add(mesh);

    if (showEdges) {
      const edges = new THREE.LineSegments(edgesGeometry(geom), this.edgeMaterial);
      this.modelGroup.add(edges);
    }

    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    this.modelGroup.position.y = -bb.min.y; // drop onto the plate
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

  // Highlight a set of shapes; the LAST one is the primary (gizmo + outline).
  setSelection(indices) {
    this.selectedSet = (indices || []).slice();
    this.selectedIndex = this.selectedSet.length ? this.selectedSet[this.selectedSet.length - 1] : -1;
    this._clearOutline();
    for (const e of this.editMeshes) {
      const sel = this.selectedSet.includes(e.index);
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
      // Only show the gizmo while actually editing parts — never in result view
      // or code mode, even if a part stays selected (e.g. picked from the list).
      if (em && !em.lock && this.editActive) { this.gizmo.attach(em.mesh); this.gizmo.setMode(this.transformMode); }
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

  toggleGrid() {
    const v = !this.grid.visible;
    this.grid.visible = v;
    this.plate.visible = v;
    return v;
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
    this.renderer.render(this.scene, this.camera);
  }
}
