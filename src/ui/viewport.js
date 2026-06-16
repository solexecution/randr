// The 3D viewport. Owns the three.js scene, a build-plate grid sized like a
// real printer bed, orbit controls, the merged "current model" mesh (code
// mode), and a group of individually-selectable per-shape meshes (build mode)
// you can click and drag straight on the workplane — the Tinkercad interaction,
// done without any extra dependencies.

import * as THREE from 'three';
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
    this.editMeshes = [];          // [{ index, mesh, op }]
    this.selectedIndex = -1;
    this.onSelect = null;          // (index | -1)
    this.onShapeMove = null;       // (index, [x,y,z]) — live during drag
    this.onShapeMoveEnd = null;    // (index, [x,y,z])
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._outline = null;

    this._setupControls();
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
    let dragging = false, panning = false, shapeDrag = false;
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

    const beginShapeDrag = (hit) => {
      shapeDrag = true;
      const idx = hit.object.userData.index;
      this.selectIndex(idx);
      if (this.onSelect) this.onSelect(idx);
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
    };
    const moveShape = (x, y) => {
      this._raycaster.setFromCamera(this._ndcFrom(x, y), this.camera);
      if (!this._raycaster.ray.intersectPlane(dragPlane, hitV)) return;
      const em = this.editMeshes.find((e) => e.index === this.selectedIndex);
      if (!em) return;
      const local = this.editGroup.worldToLocal(hitV.clone());
      em.mesh.position.x = snapV(local.x + dragOffset.x);  // language X
      em.mesh.position.y = snapV(local.y + dragOffset.y);  // language Y (workplane)
      if (this._outline) this._outline.position.copy(em.mesh.position);
      if (this.onShapeMove) this.onShapeMove(this.selectedIndex,
        [em.mesh.position.x, em.mesh.position.y, em.mesh.position.z]);
    };

    const onDown = (x, y, pan) => {
      downX = x; downY = y; moved = 0;
      const hit = pan ? null : this._pickShape(x, y);
      if (hit) beginShapeDrag(hit);
      else startOrbit(x, y, pan);
    };
    const onMove = (x, y) => {
      moved = Math.max(moved, Math.hypot(x - downX, y - downY));
      if (shapeDrag) moveShape(x, y);
      else if (dragging) moveOrbit(x, y);
    };
    const onUp = () => {
      if (shapeDrag) {
        const em = this.editMeshes.find((e) => e.index === this.selectedIndex);
        if (em && this.onShapeMoveEnd) this.onShapeMoveEnd(this.selectedIndex,
          [em.mesh.position.x, em.mesh.position.y, em.mesh.position.z]);
        shapeDrag = false;
      } else if (this.editActive && moved < 4) {
        // a click on empty space clears the selection
        if (!this._pickShape(downX, downY)) {
          this.selectIndex(-1);
          if (this.onSelect) this.onSelect(-1);
        }
      }
      dragging = false; panning = false;
    };

    const c = this.canvas;
    c.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY, e.button === 2 || e.shiftKey));
    window.addEventListener('mousemove', (e) => { if (dragging || shapeDrag) onMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', onUp);
    c.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY); }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch: one finger = drag a shape (or orbit on empty), two = pinch-zoom + pan.
    let pinchDist = 0;
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) onDown(e.touches[0].clientX, e.touches[0].clientY, false);
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

  // --- code mode: one merged solid -----------------------------------------

  setModel(manifold, { showEdges = true } = {}) {
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

  // --- build mode: many selectable shapes -----------------------------------

  setEditMode(on) {
    this.editActive = on;
    this.editGroup.visible = on;
    this.modelGroup.visible = !on;
    if (!on) { this._clearOutline(); }
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
      const mat = isHole
        ? new THREE.MeshStandardMaterial({
            color: COLORS.hole, transparent: true, opacity: 0.4,
            roughness: 0.6, metalness: 0, depthWrite: false, wireframe: this._wire })
        : new THREE.MeshStandardMaterial({
            color: it.color || COLORS.model, metalness: 0.1, roughness: 0.55, wireframe: this._wire });
      const mesh = new THREE.Mesh(it.geometry, mat);
      mesh.position.set(it.pos[0], it.pos[1], it.pos[2]);
      const r = it.rot || [0, 0, 0];
      mesh.rotation.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180);
      mesh.userData.index = it.index;
      mesh.renderOrder = isHole ? 1 : 0;
      this.editGroup.add(mesh);
      this.editMeshes.push({ index: it.index, mesh, op: it.op });
    }

    if (this.selectedIndex >= 0 && this.editMeshes.some((e) => e.index === this.selectedIndex)) {
      this.selectIndex(this.selectedIndex);
    } else {
      this.selectedIndex = -1;
    }
  }

  selectIndex(i) {
    this.selectedIndex = i;
    this._clearOutline();
    for (const e of this.editMeshes) {
      const sel = e.index === i;
      const glow = e.op === 'hole' ? COLORS.glowHole : COLORS.glowSolid;
      e.mesh.material.emissive.setHex(sel ? glow : 0x000000);
    }
    const em = this.editMeshes.find((e) => e.index === i);
    if (em) {
      const line = new THREE.LineSegments(
        new THREE.EdgesGeometry(em.mesh.geometry, 20),
        new THREE.LineBasicMaterial({ color: 0xffffff }));
      line.position.copy(em.mesh.position);
      line.rotation.copy(em.mesh.rotation);
      line.renderOrder = 2;
      this.editGroup.add(line);
      this._outline = line;
    }
  }

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
