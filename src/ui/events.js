import { toggleMenu } from './toolbar.js';
import { installCodeEditor } from './codeEditor.js';
import { exportSTL, exportOBJ, triggerDownload } from '../kernel/export.js';
import * as Projects from './projects.js';

// App's event wiring, split out of app.js to slim the controller. Authored as
// class methods so they move verbatim and `this` stays the App instance;
// installEvents() copies them onto App.prototype (app.js calls it once, after
// the class). No behaviour change — same methods, same `this`.
class EventBindings {
  _bindEvents() {
    const $ = (s) => this.root.querySelector(s);

    // editor
    const editor = $('#editor');
    editor.value = this.source;
    this._highlightEditor();
    editor.addEventListener('input', () => {
      this.source = editor.value;
      this.overrides = {}; // editing code resets param overrides
      this._codeMirror = null; // code edited by hand — no longer a clean mirror of the build tree
      this._highlightEditor();
      this._scheduleRecompile();
    });
    installCodeEditor(this);
    // glow the shape the caret is in (caret-move events; typing re-runs it via
    // recompile). The glow persists when focus leaves the editor so you can
    // orbit the model while it stays lit.
    ['keyup', 'click', 'mouseup'].forEach((ev) =>
      editor.addEventListener(ev, () => this._scheduleCursorHighlight()));

    // sketch → extrude / revolve
    $('#add-sketch')?.addEventListener('click', () => this._startSketch());
    $('#sketch-finish')?.addEventListener('click', () => this._finishSketchUI());
    $('#sketch-cancel')?.addEventListener('click', () => this._cancelSketchUI());
    $('#sketch-undo')?.addEventListener('click', () => this.viewport.sketchUndoPoint());
    this.root.querySelectorAll('#sketch-modes [data-smode]').forEach((b) =>
      b.addEventListener('click', () => this._setSketchMode(b.dataset.smode)));

    // view & tools modal (tucks the display / inspect / print-prep buttons away)
    $('#view-open')?.addEventListener('click', () => this._openModal('#view-modal'));
    const viewModal = $('#view-modal');
    if (viewModal) {
      $('#view-close')?.addEventListener('click', () => this._closeModal('#view-modal'));
      viewModal.addEventListener('mousedown', (e) => { if (e.target === viewModal) this._closeModal('#view-modal'); });
    }

    // command palette (Ctrl+K, or the ⌕ button)
    $('#cmd-open')?.addEventListener('click', () => this._openCmd());
    const cmdModal = $('#cmd-modal');
    const cmdInput = $('#cmd-input');
    if (cmdModal && cmdInput) {
      cmdInput.addEventListener('input', () => this._renderCmd(cmdInput.value));
      cmdInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this._cmdMove(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this._cmdMove(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); this._runCmd(); }
      });
      cmdModal.addEventListener('mousedown', (e) => { if (e.target === cmdModal) this._closeModal('#cmd-modal'); });
      // mousedown (not click) so it beats the input losing focus
      $('#cmd-list').addEventListener('mousedown', (e) => {
        const it = e.target.closest('.cmd-item');
        if (it) { e.preventDefault(); this._runCmd(+it.dataset.i); }
      });
    }

    // top-bar menu: ☰ app menu (project / templates / export). Open it; any
    // click elsewhere closes it.
    const appMenu = $('#app-menu');
    $('#app-btn').addEventListener('click', (e) => { e.stopPropagation(); this.root.querySelectorAll('.menu-fly.open').forEach((f) => f.classList.remove('open')); this._renderRecentMenu(); toggleMenu(this.root, appMenu); });
    document.addEventListener('click', () => this.root.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')));
    // Templates / Export fly-out submenus inside the app menu (tap to open on touch)
    this.root.querySelectorAll('.menu-fly-btn').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const fly = b.closest('.menu-fly');
      const wasOpen = fly.classList.contains('open');
      this.root.querySelectorAll('.menu-fly.open').forEach((f) => f.classList.remove('open'));
      if (!wasOpen) fly.classList.add('open');
    }));
    // click the project name (next to the logo) to rename the project
    // rename the project inline — click the name, edit in place, Enter/blur saves
    const projName = $('#proj-name');
    if (projName) {
      projName.addEventListener('click', () => {
        if (projName.getAttribute('contenteditable') === 'true') return;
        projName.setAttribute('contenteditable', 'true'); projName.spellcheck = false; projName.focus();
        const r = document.createRange(); r.selectNodeContents(projName);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      });
      projName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); projName.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); projName.textContent = this.project ? this.project.name : 'Untitled'; projName.blur(); }
      });
      projName.addEventListener('blur', () => {
        projName.setAttribute('contenteditable', 'false');
        const name = (projName.textContent || '').trim();
        if (name && this.project && name !== this.project.name) this._renameCurrentProject(name);
        else projName.textContent = this.project ? this.project.name : 'Untitled';
      });
    }

    // project actions (in the app menu)
    $('#proj-new').addEventListener('click', () => this._newProject());
    $('#proj-back').addEventListener('click', () => this._goToPrevious());
    $('#proj-save').addEventListener('click', () => this._saveProject());
    $('#proj-saveas').addEventListener('click', () => this._promptName('Save project as', this.project ? this.project.name : '', (n) => this._doSaveAs(n)));
    $('#proj-open').addEventListener('click', () => { this._renderProjectList(); this._openModal('#proj-modal'); });
    $('#proj-recent').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-switch]');
      if (b) this._openProject(b.dataset.switch);
    });

    // templates (in the app menu)
    this.root.querySelectorAll('[data-tpl]').forEach((b) =>
      b.addEventListener('click', () => { this._loadTemplate(b.dataset.tpl); appMenu.classList.remove('open'); }));

    // export (in the app menu)
    const out = (fn, name) => { if (this.currentModel) triggerDownload(fn(this.currentModel), name); appMenu.classList.remove('open'); };
    $('#btn-stl').addEventListener('click', () => out(exportSTL, 'part.stl'));
    $('#btn-3mf').addEventListener('click', () => { if (this.currentModel) triggerDownload(this._build3MF(), 'part.3mf'); appMenu.classList.remove('open'); });
    $('#btn-bambu').addEventListener('click', () => {
      appMenu.classList.remove('open');
      if (!this.currentModel) { this._toast('Nothing to export yet'); return; }
      const name = ((this.project && this.project.name) || 'model').replace(/[^\w.-]+/g, '_') || 'model';
      triggerDownload(this._build3MF(), name + '.3mf'); // 3MF is Bambu's native format (units + per-part colour)
      this._toast('Saved ' + name + '.3mf — open it in Bambu Studio (tip: set .3mf to open with Bambu Studio)');
    });
    $('#btn-obj').addEventListener('click', () => out(exportOBJ, 'part.obj'));

    // projects manager modal
    const pm = $('#proj-modal');
    $('#proj-modal-close').addEventListener('click', () => this._closeModal('#proj-modal'));
    pm.addEventListener('click', (e) => { if (e.target === pm) this._closeModal('#proj-modal'); });
    $('#proj-list').addEventListener('click', (e) => {
      const open = e.target.closest('[data-open]');
      const ren = e.target.closest('[data-rename]');
      const del = e.target.closest('[data-del]');
      if (open) { this._openProject(open.dataset.open); return; }
      if (ren) { const id = ren.dataset.rename; const cur = Projects.listProjects().find((p) => p.id === id); this._promptName('Rename project', cur ? cur.name : '', (n) => { if (this.project && this.project.id === id) this._renameCurrentProject(n); else { Projects.renameProject(id, this._uniqueName((n || '').trim(), id), Date.now()); this._renderProjectList(); } }); return; }
      if (del) {
        const id = del.dataset.del;
        if (del.dataset.confirm) { this._deleteProject(id); return; } // second click confirms
        del.dataset.confirm = '1'; del.textContent = 'sure?'; del.classList.add('confirm');
        setTimeout(() => { if (del.isConnected) { del.textContent = '✕'; del.classList.remove('confirm'); delete del.dataset.confirm; } }, 2600);
      }
    });

    // name-input modal (Save as / Rename)
    const nameModal = $('#name-modal');
    const nameInput = $('#name-input');
    const nameOk = () => { const cb = this._nameCb; this._nameCb = null; this._closeModal('#name-modal'); if (cb) cb(nameInput.value); };
    $('#name-ok').addEventListener('click', nameOk);
    $('#name-cancel').addEventListener('click', () => { this._nameCb = null; this._closeModal('#name-modal'); });
    nameModal.addEventListener('click', (e) => { if (e.target === nameModal) { this._nameCb = null; this._closeModal('#name-modal'); } });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameOk(); } });

    // undo / redo + snap
    $('#v-undo').addEventListener('click', () => this._undo());
    $('#v-redo').addEventListener('click', () => this._redo());
    $('#v-snap').addEventListener('click', (e) => e.currentTarget.classList.toggle('on', this.viewport.setSnap(!this.viewport.snap)));
    this._updateHistoryButtons();

    // view controls
    $('#rail-home')?.addEventListener('click', () => this.viewport.homeView());
    $('#card-layout')?.addEventListener('click', () => this._toggleLayout());
    $('#v-grid').addEventListener('click', (e) => e.currentTarget.classList.toggle('on', this.viewport.toggleGrid()));
    $('#v-mmgrid')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('on', this.viewport.toggleFineGrid()));
    $('#v-theme')?.addEventListener('click', () => this._setTheme(!this._lightTheme));
    $('#v-wire').addEventListener('click', (e) => e.currentTarget.classList.toggle('on', this.viewport.toggleWireframe()));

    // HUD collapse
    $('#hud-toggle').addEventListener('click', () => $('#hud').classList.toggle('collapsed'));

    // transform-mode toolbar (gizmo)
    this.root.querySelectorAll('[data-xform]').forEach((b) =>
      b.addEventListener('click', () => this._setXform(b.dataset.xform)));

    // floating part card: drag the header to move; it snaps to either edge or
    // floats. Position persists in localStorage (randr.cardDock).
    const card = this.root.querySelector('#part-card');
    const cardHead = this.root.querySelector('#card-head');
    if (card && cardHead) {
      const applyDock = (mode) => {
        const side = mode === 'right' ? 'right' : 'left';
        card.classList.remove('dock-left', 'dock-right', 'float');
        card.classList.add(side === 'right' ? 'dock-right' : 'dock-left');
        card.style.left = card.style.top = card.style.right = card.style.bottom = '';
        this._cardDock = side;
        this._applyCardLayout();
        this._saveCardDock();
      };
      // the parts list is a docked sidebar — left by default; drag the header (or
      // the ▣ button) to snap it to the other edge. Older 'float' state → left.
      let savedDock = null;
      try { savedDock = JSON.parse(localStorage.getItem('randr.cardDock')); } catch { /* ignore */ }
      applyDock(savedDock?.mode === 'left' ? 'left' : 'right'); // editing docks right by default
      this._setCardCollapsed(!!savedDock?.collapsed);

      let sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
      const onMove = (e) => {
        moved = true;
        card.classList.remove('dock-left', 'dock-right'); card.classList.add('float');
        const r = card.getBoundingClientRect();
        const x = Math.max(6, Math.min(ox + e.clientX - sx, window.innerWidth - r.width - 6));
        const y = Math.max(50, Math.min(oy + e.clientY - sy, window.innerHeight - 44));
        card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.right = 'auto'; card.style.bottom = 'auto';
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (!moved) return;
        const r = card.getBoundingClientRect();
        applyDock(r.left + r.width / 2 < window.innerWidth / 2 ? 'left' : 'right');
      };
      cardHead.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return; // let the head buttons work
        const r = card.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; moved = false;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        e.preventDefault();
      });

      // snap button toggles the sidebar between the left and right edge
      this.root.querySelector('#card-snap')?.addEventListener('click', () => {
        applyDock(this._cardDock === 'left' ? 'right' : 'left');
      });
      this.root.querySelector('#card-min')?.addEventListener('click', () => this._toggleSidebar());
    }

    // ── unified panel: fold the Add gallery + settings into their tabs ──
    // (move the existing markup so all ids / handlers keep working)
    // panel tabs (Parts · Shapes · Settings · Edit)
    this.root.querySelectorAll('.ptab').forEach((b) => b.addEventListener('click', () => this._setPanelTab(b.dataset.ptab)));

    this.root.querySelectorAll('.edit-tool-tab').forEach((b) => b.addEventListener('click', () => {
      if (!b.hidden) this._setEditToolTab(b.dataset.ttab);
    }));

    // multi-select toggle: a sticky additive mode so a tap (no Shift) adds to the
    // selection. Long-pressing a part in the scene arms the same mode (see
    // viewport.js → onMultiArm); both share this._setMultiSelect.
    this.root.querySelectorAll('.js-multi').forEach((multiBtn) => multiBtn.addEventListener('click', () => {
      this._setMultiSelect(!this.multiSelect);
      this._toast(this.multiSelect ? 'Multi-select on — tap parts to add · tap empty to finish' : 'Multi-select off');
    }));

    // dismiss the right-click context menu on any click outside it
    window.addEventListener('mousedown', (e) => {
      const menu = this.root.querySelector('#ctx-menu');
      if (menu && !menu.classList.contains('hidden') && !e.target.closest('#ctx-menu')) menu.classList.add('hidden');
    });

    // help modal — Features reference + G-code guide
    const helpModal = this.root.querySelector('#help-modal');
    const helpBtn = this.root.querySelector('#help-btn');
    if (helpBtn && helpModal) {
      const showHelpTab = (tab) => {
        this.root.querySelectorAll('.help-tab').forEach((b) => {
          const on = b.dataset.helpTab === tab;
          b.classList.toggle('on', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        const feat = this.root.querySelector('#help-features');
        const gcode = this.root.querySelector('#help-gcode');
        if (feat) feat.classList.toggle('hidden', tab !== 'features');
        if (gcode) gcode.classList.toggle('hidden', tab !== 'gcode');
      };
      helpBtn.addEventListener('click', () => { showHelpTab('features'); helpModal.classList.remove('hidden'); });
      this.root.querySelectorAll('.help-tab').forEach((b) =>
        b.addEventListener('click', () => showHelpTab(b.dataset.helpTab)));
      const hc = this.root.querySelector('#help-close');
      if (hc) hc.addEventListener('click', () => helpModal.classList.add('hidden'));
      helpModal.addEventListener('mousedown', (e) => { if (e.target === helpModal) helpModal.classList.add('hidden'); });
    }

    // layer preview: toggle + scrub
    const layerBtn = this.root.querySelector('#v-layers');
    if (layerBtn) layerBtn.addEventListener('click', () => this._toggleLayers());
    const layerRange = this.root.querySelector('#layer-range');
    if (layerRange) layerRange.addEventListener('input', () => {
      const i = +layerRange.value;
      this.viewport.setLayerVisible(i);
      this._updateLayerLabel(i);
    });

    // measure tool: toggle + floating distance label fed by the viewport
    const measLabel = this.root.querySelector('#measure-label');
    this.viewport.measureLabel = measLabel;
    this.viewport.xformReadout = this.root.querySelector('#xform-readout');
    this.viewport.onMeasure = (info) => {
      if (info && measLabel) measLabel.innerHTML =
        `<b>${info.dist.toFixed(1)} mm</b><span>X ${info.x.toFixed(1)} · Y ${info.y.toFixed(1)} · Z ${info.z.toFixed(1)} · tap to pin</span>`;
    };
    // tap the floating label to pin the measurement as a persistent annotation
    if (measLabel) measLabel.addEventListener('click', () => {
      if (this.viewport.pinCurrentMeasure()) this._toast('Dimension pinned — double-click 📏 to clear');
    });
    const measBtn = this.root.querySelector('#v-measure');
    if (measBtn) {
      measBtn.addEventListener('click', () => {
        this.measureMode = !this.measureMode;
        this.viewport.setMeasureMode(this.measureMode);
        measBtn.classList.toggle('on', this.measureMode);
      });
      measBtn.addEventListener('dblclick', () => { this.viewport.clearPins(); this._toast('Pinned dimensions cleared'); });
    }

    // print-prep cluster: a 🛠 toggle that reveals overhang/orient/fit/cut, so
    // the toolbar stays uncluttered (the buttons themselves are unchanged).
    const prepToggle = this.root.querySelector('#prep-toggle');
    const prepGrp = this.root.querySelector('#prep-grp');
    if (prepToggle && prepGrp) prepToggle.addEventListener('click', () => {
      prepToggle.classList.toggle('on', prepGrp.classList.toggle('open'));
    });

    // overhang analysis: tint downward faces that need support (uses the merged
    // result mesh, so switch a build-mode edit view over to result first)
    const ohBtn = this.root.querySelector('#v-overhang');
    if (ohBtn) ohBtn.addEventListener('click', () => {
      this.overhangMode = !this.overhangMode;
      this._syncPrepView(); // result while checking overhangs; back to parts when off
      const on = this.viewport.setOverhangView(this.overhangMode);
      ohBtn.classList.toggle('on', on);
    });

    const orientBtn = this.root.querySelector('#v-orient');
    if (orientBtn) orientBtn.addEventListener('click', () => this._autoOrient());

    const fitBtn = this.root.querySelector('#v-fit-plate');
    if (fitBtn) fitBtn.addEventListener('click', () => this._scaleToFit());

    const cutBtn = this.root.querySelector('#v-cut');
    if (cutBtn) cutBtn.addEventListener('click', () => {
      this.printCut = this.printCut > 0 ? 0 : 4; // toggle; 4 mm gap between halves
      cutBtn.classList.toggle('on', this.printCut > 0);
      this._syncPrepView(); // result while cut; back to editable parts when removed
      this.recompile();
      this._pushHistory();
      this._toast(this.printCut > 0
        ? 'Cut in half — showing the result. Tap Build to keep moving parts.'
        : 'Cut removed — back to editing.');
    });

    $('#workspace-toggle')?.addEventListener('click', () => this._toggleSidebar());

    $('#card-mode-seg')?.addEventListener('click', (e) => {
      const opt = e.target.closest('.card-mode-opt');
      if (opt?.dataset.mode) this._setAuthoringMode(opt.dataset.mode);
    });

    // align toolbar (appears when 2+ shapes are selected)
    this.root.querySelectorAll('[data-align]').forEach((b) =>
      b.addEventListener('click', () => this._align(b.dataset.align)));

    // place toolbar (drop to base, center, level, reset scale)
    this.root.querySelectorAll('[data-op-act]').forEach((b) =>
      b.addEventListener('click', () => this._placeOp(b.dataset.opAct)));

    // cut selection in half along X / Y / Z
    this.root.querySelectorAll('[data-cut-half]').forEach((b) =>
      b.addEventListener('click', () => this._splitHalf(b.dataset.cutHalf)));

    // movable laser-cut plane
    this.root.querySelectorAll('[data-cut-plane]').forEach((b) =>
      b.addEventListener('click', () => {
        const act = b.dataset.cutPlane;
        if (act === 'toggle') this._toggleCutPlane();
        else if (act === 'apply') this._applyCutPlane();
        else if (act === 'reset') this._resetCutPlane();
        else if (act === 'check') this._checkSeamGap();
      }));

    // group / ungroup toolbar + boolean mode
    this.root.querySelectorAll('[data-group]').forEach((b) =>
      b.addEventListener('click', () => (b.dataset.group === 'group' ? this._group() : this._ungroup())));
    this.root.querySelectorAll('[data-gmode]').forEach((b) =>
      b.addEventListener('click', () => this._setGroupMode(b.dataset.gmode)));

    // workplane toolbar
    this.root.querySelectorAll('[data-wp]').forEach((b) =>
      b.addEventListener('click', () => (b.dataset.wp === 'face' ? this._pickWorkplane() : this._resetWorkplane())));

    // mirror / flip + array toolbars
    this.root.querySelectorAll('[data-flip]').forEach((b) =>
      b.addEventListener('click', () => this._flip(b.dataset.flip)));
    this.root.querySelectorAll('[data-arr]').forEach((b) =>
      b.addEventListener('click', () => this._arrayOp(b.dataset.arr)));

    // build pane
    this._bindBuildPane();

    // keep the Add popover stuck under its button on resize
    window.addEventListener('resize', () => {
      const m = this.root.querySelector('#add-modal');
      if (m && !m.classList.contains('hidden')) this._positionAddModal();
    });

    // keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      // Save works anywhere, even with a field focused
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); this._saveProject(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); this._openCmd(); return; }
      if (e.key === 'Escape') {
        const ctx = this.root.querySelector('#ctx-menu');
        if (ctx && !ctx.classList.contains('hidden')) { e.preventDefault(); ctx.classList.add('hidden'); return; }
        if (this.viewport && this.viewport._sketch?.on) { e.preventDefault(); this._cancelSketchUI(); return; }
        for (const sel of ['#part-modal', '#cmd-modal', '#view-modal', '#settings-modal', '#name-modal', '#proj-modal', '#add-modal', '#help-modal']) {
          const m = this.root.querySelector(sel);
          if (m && !m.classList.contains('hidden')) { e.preventDefault(); if (sel === '#name-modal') this._nameCb = null; m.classList.add('hidden'); return; }
        }
      }
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); this._undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this._redo(); return; }
      if (k === 'f') { this.viewport.fitView(); return; }
      if (k === 'g') { $('#v-grid').classList.toggle('on', this.viewport.toggleGrid()); return; }
      if (this.mode === 'build' && 'wer'.includes(k) && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        this._setXform({ w: 'translate', e: 'rotate', r: 'scale' }[k]); return;
      }
      // single-key tool shortcuts (build mode, something selected) — mirror the
      // right-click menu's accelerators
      if (this.mode === 'build' && !e.ctrlKey && !e.metaKey && this.selectedNodes.length) {
        const sel = this.selectedNodes;
        if (e.shiftKey) {
          if (k === 'e') { this._placeOp('level'); return; }
          if (k === 'r') { this._placeOp('scale'); return; }
          if (k === 'h') { this._toggleHide(sel); return; }
          if (k === 'b') { this._explodeNode(this.selectedNode); return; }
        } else {
          if (k === 'h') { this._toggleHole(sel); return; }
          if (k === 'l') { this._toggleLock(sel); return; }
          if (k === 'b') { this._placeOp('drop'); return; }
          if (k === 'c') { this._placeOp('center'); return; }
          if (k === 's') { this._placeOp('stack'); return; }
          if (k === 'x' || k === 'y' || k === 'z') { this._flip(k); return; }
        }
      }
      if (this.mode === 'build' && (e.ctrlKey || e.metaKey) && k === 'g') {
        e.preventDefault(); if (e.shiftKey) this._ungroup(); else this._group(); return;
      }
      if (this.mode === 'build' && this.selectedNodes.length && !e.ctrlKey && !e.metaKey) {
        const s = e.shiftKey ? 10 : 1;
        const nudge = { ArrowLeft: [-s, 0, 0], ArrowRight: [s, 0, 0], ArrowUp: [0, s, 0], ArrowDown: [0, -s, 0], PageUp: [0, 0, s], PageDown: [0, 0, -s] };
        if (nudge[e.key]) { e.preventDefault(); this._nudge(nudge[e.key]); return; }
      }
      if (this.mode === 'build' && this.selectedNodes.length) {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this._deleteSelected(); }
        else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this._duplicateSelected(); }
      }
    });
  }
}

export function installEvents(App) {
  for (const name of Object.getOwnPropertyNames(EventBindings.prototype)) {
    if (name !== 'constructor') App.prototype[name] = EventBindings.prototype[name];
  }
}
