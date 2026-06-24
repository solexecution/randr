// The Ctrl+K command palette: a searchable index of every tool/op, built fresh
// each open so it reflects current state. Owns its own modal/search state and
// reuses App's handlers (and a few button .click()s) so each action keeps one
// source of truth. App delegates _openCmd/_renderCmd/_cmdMove/_runCmd here.
import { exportSTL, exportOBJ, triggerDownload } from '../kernel/export.js';
import { TEMPLATES } from './templates.js';
import { QUALITY_LEVELS } from './toolbar.js';
import { ADDABLE_KINDS } from './primitives.js';
import { esc } from './escape.js';

export class CommandPalette {
  constructor(app) { this.app = app; this._all = []; this._shown = []; this._active = 0; }

  // Build the index fresh against current state. Reuses App handlers (A._foo)
  // and a few button .click()s so each action has one source of truth.
  build() {
    const A = this.app;
    const c = [];
    const add = (label, hint, group, run) => c.push({ label, hint, group, run });
    const clickBtn = (sel) => { const b = A.root.querySelector(sel); if (b) b.click(); };
    ADDABLE_KINDS.forEach((k) => add(`Add ${k}`, 'shape', 'Add', () => A._addShape(k)));
    Object.keys(TEMPLATES).forEach((k) => add(`Insert ${k}`, 'ready-made', 'Add', () => A._loadTemplate(k)));
    add('Draw a sketch (extrude / revolve)', 'polygon → 3D', 'Add', () => A._startSketch());
    add('Fit to view', 'F', 'View', () => A.viewport.fitView());
    add('Toggle grid', 'G', 'View', () => clickBtn('#v-grid'));
    add('Toggle mm grid', '', 'View', () => clickBtn('#v-mmgrid'));
    add('Toggle light / dark theme', '', 'View', () => clickBtn('#v-theme'));
    add('Switch layout (side / bottom)', '', 'View', () => A._toggleLayout());
    add('Toggle wireframe', '', 'View', () => clickBtn('#v-wire'));
    add('Auto-orient for printing', 'least support', 'Prep', () => A._autoOrient());
    add('Scale to fit the plate', '', 'Prep', () => A._scaleToFit());
    add('Cut in half', 'two glue-able pieces', 'Prep', () => clickBtn('#v-cut'));
    add('Overhang check', 'red = needs support', 'Prep', () => clickBtn('#v-overhang'));
    add('Measure distance', 'click two points', 'Tools', () => clickBtn('#v-measure'));
    add('Undo', 'Ctrl+Z', 'Edit', () => A._undo());
    add('Redo', 'Ctrl+Y', 'Edit', () => A._redo());
    add('Group selection', 'Ctrl+G', 'Edit', () => A._group());
    add('Ungroup', '', 'Edit', () => A._ungroup());
    add('Clear canvas', 'remove all parts', 'Edit', () => A._clearCanvas());
    add('Export STL', 'for slicing', 'Export', () => { if (A.currentModel) triggerDownload(exportSTL(A.currentModel), 'part.stl'); });
    add('Export for Bambu Studio', '3MF', 'Export', () => { if (A.currentModel) { triggerDownload(A._build3MF(), 'model.3mf'); A._toast('Saved model.3mf — open it in Bambu Studio'); } });
    add('Export 3MF', 'units + colour', 'Export', () => { if (A.currentModel) triggerDownload(A._build3MF(), 'part.3mf'); });
    add('Export OBJ', 'mesh', 'Export', () => { if (A.currentModel) triggerDownload(exportOBJ(A.currentModel), 'part.obj'); });
    QUALITY_LEVELS.forEach((q) =>
      add(`Quality: ${q.name}`, 'curve smoothness', 'Quality', () => A._setQuality(q.v)));
    add('New project', '', 'Project', () => A._newProject());
    add('Save project', 'Ctrl+S', 'Project', () => A._saveProject());
    add('Save project as…', '', 'Project', () => A._promptName('Save project as', A.project ? A.project.name : '', (n) => A._doSaveAs(n)));
    add('Open / manage projects…', '', 'Project', () => { A._renderProjectList(); A._openModal('#proj-modal'); });
    return c;
  }

  open() {
    this._all = this.build();
    this.app._openModal('#cmd-modal');
    const input = this.app.root.querySelector('#cmd-input');
    input.value = '';
    this.render('');
    setTimeout(() => { input.focus(); }, 20);
  }

  render(query) {
    const q = (query || '').trim().toLowerCase();
    let items = this._all || [];
    if (q) {
      items = items
        .map((cmd) => {
          const l = cmd.label.toLowerCase();
          let score = -1;
          if (l.startsWith(q)) score = 0;
          else if (l.includes(q)) score = 1;
          else if (`${cmd.group} ${cmd.hint || ''}`.toLowerCase().includes(q)) score = 2;
          return { cmd, score };
        })
        .filter((x) => x.score >= 0)
        .sort((a, b) => a.score - b.score)
        .map((x) => x.cmd);
    }
    items = items.slice(0, 40);
    this._shown = items;
    this._active = 0;
    const list = this.app.root.querySelector('#cmd-list');
    if (!items.length) { list.innerHTML = '<div class="cmd-empty">No matching command</div>'; return; }
    list.innerHTML = items.map((cmd, i) => `
      <div class="cmd-item${i === 0 ? ' active' : ''}" data-i="${i}" role="option">
        <span class="cmd-grp">${esc(cmd.group)}</span>
        <span class="cmd-label">${esc(cmd.label)}</span>
        ${cmd.hint ? `<span class="cmd-hint">${esc(cmd.hint)}</span>` : ''}
      </div>`).join('');
  }

  move(d) {
    if (!this._shown || !this._shown.length) return;
    this._active = (this._active + d + this._shown.length) % this._shown.length;
    const list = this.app.root.querySelector('#cmd-list');
    list.querySelectorAll('.cmd-item').forEach((el, i) => el.classList.toggle('active', i === this._active));
    list.querySelector('.cmd-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  run(i) {
    const idx = i != null ? i : this._active;
    const cmd = this._shown && this._shown[idx];
    this.app._closeModal('#cmd-modal');
    if (cmd) { try { cmd.run(); } catch { this.app._toast('Could not run that command'); } }
  }
}
