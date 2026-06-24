import { esc } from './escape.js';
import { isFastener, METRIC_SIZES, currentMetricSize, supportsClearance, isShellable, supportsFillet, setNodeKind, applyMetricSize } from './buildtree.js';

// App's build-pane renderers (the part-editor tree + the compact parts list),
// split out of app.js. Authored as class methods so they move verbatim and
// `this` stays the App instance; installBuildPane() copies them onto
// App.prototype (app.js calls it once, after the class).
class BuildPaneRenderers {
  // Object count + a short, touch-aware contextual line in the card header.
  _updatePartsHeader() {
    const nodes = this.buildTree.nodes || [];
    const total = nodes.length;
    const holes = nodes.filter((n) => n.op === 'hole').length;
    const solids = total - holes;
    const countEl = this.root.querySelector('#parts-count');
    if (countEl) countEl.textContent = total
      ? `Parts · ${total}  (${solids} solid · ${holes} hole${holes === 1 ? '' : 's'})`
      : 'Parts';
    const hintEl = this.root.querySelector('#parts-hint');
    if (hintEl) {
      const sel = this.selectedNodes ? this.selectedNodes.length : 0;
      if (sel >= 2) hintEl.textContent = `${sel} parts selected — align / group / array below`;
      else if (sel === 1) {
        const n = nodes[this.selectedNodes[0]];
        const name = n ? (n.kind === 'imported' ? (n.meshName || 'mesh') : (n.kind || 'part')) : 'part';
        hintEl.textContent = `Editing ${name} — change anything below`;
      } else hintEl.textContent = total ? 'Tap a part to edit · long-press to multi-select' : 'Tap + to add your first part';
    }
    const clearEl = this.root.querySelector('#clear-canvas');
    if (clearEl) {
      clearEl.hidden = !total; // only offer Clear when there's something to clear
      if (!total) { clearEl.classList.remove('confirm'); clearEl.textContent = 'Clear'; }
    }
  }

  _renderBuildTree() {
    this._renderPartsList(); // compact roster: select · name · hole · remove
    this._updatePartsHeader();
    const host = this.root.querySelector('#part-modal-fields'); // the detail editor lives in the modal
    if (!host) return; // modal not in the DOM yet (e.g. an early call during boot)
    host.innerHTML = '';
    if (this.selectedNodes.length >= 2) {
      host.innerHTML = `<p class="muted">${this.selectedNodes.length} parts selected — use the tools below to align, group, array or place them.</p>`;
      this._renderAlignBar();
      return;
    }
    if (this.selectedNode < 0 || !this.buildTree.nodes[this.selectedNode]) {
      host.innerHTML = '<p class="muted">Pick a part from the list to edit its size, position, colour and options.</p>';
      this._renderAlignBar();
      return;
    }
    const mEl = this.root.querySelector('#part-modal-metrics');
    const mb = this.viewport.shapeBounds ? this.viewport.shapeBounds(this.selectedNode) : null;
    if (mEl) mEl.textContent = mb ? `${(mb.max[0] - mb.min[0]).toFixed(1)} × ${(mb.max[1] - mb.min[1]).toFixed(1)} × ${(mb.max[2] - mb.min[2]).toFixed(1)} mm` : '—';
    const KINDS = ['box', 'cylinder', 'sphere', 'cone', 'pyramid', 'torus', 'wedge', 'dome', 'slot', 'star', 'roundedBox', 'roundedCylinder', 'chamferedBox', 'chamferedCylinder', 'tube', 'prism', 'gear', 'counterbore', 'countersink', 'insertHole', 'nutTrap', 'keyhole', 'text', 'thread', 'bolt', 'nut'];
    const KIND_LABEL = { roundedBox: 'rounded', roundedCylinder: 'r-cyl', chamferedBox: 'cham-box', chamferedCylinder: 'cham-cyl', thread: 'rod' };
    const COUNT_KEYS = new Set(['sides', 'segments', 'n', 'count', 'teeth', 'points']);
    const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    [this.selectedNode].forEach((idx) => {
      const node = this.buildTree.nodes[idx];
      const row = document.createElement('div');
      row.className = 'build-node sel'
        + (node.op === 'hole' ? ' is-hole' : '')
        + (node.hidden ? ' is-hidden' : '');
      row.dataset.node = idx;
      const dims = node.fields.map((f) => {
        if (f.type === 'text') {
          return `<label class="bn-text">${f.label}<input type="text" value="${esc(f.value)}" data-field="${idx}:${f.key}" spellcheck="false"></label>`;
        }
        const isCount = COUNT_KEYS.has(f.key);
        return `<label${isCount ? '' : ' data-unit="mm"'}>${f.label}<input type="number" step="${isCount ? 1 : 0.5}" value="${f.value}" data-field="${idx}:${f.key}"></label>`;
      }).join('');
      row.innerHTML = `
        <div class="bn-head">
          <button class="bn-collapse" data-collapse="${idx}" title="${node.collapsed ? 'Expand' : 'Collapse'}">${node.collapsed ? '▸' : '▾'}</button>
          ${node.group != null ? `<span class="bn-grp" title="Group ${node.group}">G${node.group}</span>` : ''}
          ${node.kind === 'imported'
            ? `<span class="bn-type bn-imported" title="Imported mesh">⬇ ${esc(node.meshName || 'mesh')}</span>`
            : node.kind === 'extrusion'
            ? `<span class="bn-type bn-imported" title="Extruded sketch — ${(node.points || []).length} points">✎ sketch (${(node.points || []).length} pts)</span>`
            : node.kind === 'revolution'
            ? `<span class="bn-type bn-imported" title="Revolved sketch — ${(node.points || []).length} points">⟳ lathe (${(node.points || []).length} pts)</span>`
            : `<select class="bn-type" data-type="${idx}" title="Shape type">
            ${KINDS.map((k) => `<option value="${k}" ${k === node.kind ? 'selected' : ''}>${KIND_LABEL[k] || k}</option>`).join('')}
          </select>`}
          <span class="bn-color-wrap">
            <input type="color" class="bn-swatch" data-color="${idx}" value="${hex(node.color)}" title="Pick colour" ${node.op === 'hole' ? 'disabled' : ''}>
            <input type="text" class="bn-hex" data-hex="${idx}" value="${hex(node.color)}" maxlength="7" spellcheck="false" title="Hex colour" ${node.op === 'hole' ? 'disabled' : ''}>
          </span>
        </div>
        <div class="bn-toolbar">
          <button class="bn-op ${node.op}" data-op="${idx}" title="Toggle solid / hole">${node.op}</button>
          <div class="bn-actions">
            <button class="bn-ic ${node.locked ? 'on' : ''}" data-lock="${idx}" title="Lock position">${node.locked ? '🔒' : '🔓'}</button>
            <button class="bn-ic" data-hide="${idx}" title="${node.hidden ? 'Show' : 'Hide'}">${node.hidden ? '🚫' : '👁'}</button>
            <button class="bn-ic" data-clone="${idx}" title="Duplicate (Ctrl+D)">⧉</button>
            <button class="bn-ic bn-del" data-del="${idx}" title="Delete">✕</button>
          </div>
        </div>
        ${isFastener(node.kind) ? `<div class="bn-size">
          <label>standard size<select data-size="${idx}">
            <option value="">custom</option>
            ${METRIC_SIZES.map((s) => `<option value="${s.key}" ${currentMetricSize(node) === s.key ? 'selected' : ''}>${s.key}</option>`).join('')}
          </select></label>
          <span class="bn-size-hint">sets Ø + pitch${node.kind === 'thread' ? '' : ' + hex'}</span>
        </div>` : ''}
        <div class="bn-fields">${dims}</div>
        <div class="bn-fields bn-xyz">
          <label data-unit="mm">x<input type="number" step="0.5" value="${node.pos[0]}" data-pos="${idx}:0"></label>
          <label data-unit="mm">y<input type="number" step="0.5" value="${node.pos[1]}" data-pos="${idx}:1"></label>
          <label data-unit="mm">z<input type="number" step="0.5" value="${node.pos[2]}" data-pos="${idx}:2"></label>
          <label data-unit="°">rx<input type="number" step="15" value="${node.rot[0]}" data-rot="${idx}:0"></label>
          <label data-unit="°">ry<input type="number" step="15" value="${node.rot[1]}" data-rot="${idx}:1"></label>
          <label data-unit="°">rz<input type="number" step="15" value="${node.rot[2]}" data-rot="${idx}:2"></label>
        </div>
        ${(supportsClearance(node.kind) || isShellable(node.kind)) ? `<div class="bn-clear">
          ${supportsClearance(node.kind) ? `<label>fit clearance<input type="number" step="0.05" value="${node.clearance || 0}" data-clear="${idx}"></label>` : ''}
          ${isShellable(node.kind) ? `<label>wall (hollow)<input type="number" step="0.2" value="${node.hollow || 0}" data-hollow="${idx}"></label>` : ''}
          <span class="bn-clear-hint">mm · press-fit / hollow shell</span>
        </div>` : ''}
        ${supportsFillet(node.kind) ? `<div class="bn-clear">
          <label>edge fillet<input type="number" step="0.5" min="0" value="${node.fillet || 0}" data-fillet="${idx}"></label>
          <label class="bn-bevel-lab"><input type="checkbox" data-bevel="${idx}" ${node.bevel ? 'checked' : ''}> bevel</label>
          <span class="bn-clear-hint">mm · rounds edges (✓ = chamfer)</span>
        </div>` : ''}`;
      row.addEventListener('mousedown', (e) => {
        if (e.target.closest('input, button, select')) return;
        this._selectNode(idx, e.shiftKey || this.multiSelect);
      });
      host.appendChild(row);
    });

    const nodes = this.buildTree.nodes;
    host.querySelectorAll('[data-type]').forEach((el) => el.addEventListener('change', () => {
      setNodeKind(nodes[+el.dataset.type], el.value); this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-color]').forEach((el) => el.addEventListener('input', () => {
      const i = +el.dataset.color;
      nodes[i].color = parseInt(el.value.slice(1), 16);
      const hx = host.querySelector(`[data-hex="${i}"]`); if (hx) hx.value = el.value;
      this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-hex]').forEach((el) => el.addEventListener('input', () => {
      let v = el.value.trim(); if (v[0] !== '#') v = '#' + v;
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) return; // hold until it's a complete hex
      const i = +el.dataset.hex;
      nodes[i].color = parseInt(v.slice(1), 16);
      const sw = host.querySelector(`[data-color="${i}"]`); if (sw) sw.value = v;
      this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-op]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.op]; n.op = n.op === 'hole' ? 'solid' : 'hole'; this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-lock]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.lock]; n.locked = !n.locked; this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-hide]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.hide]; n.hidden = !n.hidden; this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-collapse]').forEach((el) => el.addEventListener('click', () => {
      const n = nodes[+el.dataset.collapse]; n.collapsed = !n.collapsed;
      el.closest('.build-node').classList.toggle('collapsed', n.collapsed);
      el.textContent = n.collapsed ? '▸' : '▾';
      el.title = n.collapsed ? 'Expand' : 'Collapse';
      this._updateCollapseAllLabel();
    }));
    host.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => this._deleteNode(+el.dataset.del)));
    host.querySelectorAll('[data-clone]').forEach((el) => el.addEventListener('click', () => {
      this._selectNode(+el.dataset.clone, false); this._duplicateSelected();
    }));
    host.querySelectorAll('[data-field]').forEach((el) => el.addEventListener('input', () => {
      const [i, key] = el.dataset.field.split(':');
      const f = nodes[+i].fields.find((x) => x.key === key);
      f.value = f.type === 'text' ? el.value : parseFloat(el.value);
      this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-pos]').forEach((el) => el.addEventListener('input', () => {
      const [i, a] = el.dataset.pos.split(':'); nodes[+i].pos[+a] = parseFloat(el.value); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-rot]').forEach((el) => el.addEventListener('input', () => {
      const [i, a] = el.dataset.rot.split(':'); nodes[+i].rot[+a] = parseFloat(el.value); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-clear]').forEach((el) => el.addEventListener('input', () => {
      nodes[+el.dataset.clear].clearance = parseFloat(el.value) || 0; this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-hollow]').forEach((el) => el.addEventListener('input', () => {
      nodes[+el.dataset.hollow].hollow = Math.max(0, parseFloat(el.value) || 0); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-fillet]').forEach((el) => el.addEventListener('input', () => {
      nodes[+el.dataset.fillet].fillet = Math.max(0, parseFloat(el.value) || 0); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-bevel]').forEach((el) => el.addEventListener('change', () => {
      nodes[+el.dataset.bevel].bevel = el.checked; this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-size]').forEach((el) => el.addEventListener('change', () => {
      if (!el.value) return;
      applyMetricSize(nodes[+el.dataset.size], el.value);
      this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    this._renderAlignBar();
  }

  // The compact parts roster: one row per part with just the essentials —
  // (multi)select · name (tap to edit) · solid/hole · remove. Deep editing
  // happens in the part modal (#part-modal).
  _renderPartsList() {
    const host = this.root.querySelector('#build-list');
    if (!host) return;
    const nodes = this.buildTree.nodes;
    host.innerHTML = '';
    if (!nodes.length) {
      host.innerHTML = '<p class="muted">Tap + to add your first part, then mark each one solid or hole.</p>';
      return;
    }
    const KIND_LABEL = { roundedBox: 'rounded', roundedCylinder: 'r-cyl', chamferedBox: 'cham-box', chamferedCylinder: 'cham-cyl', thread: 'rod' };
    // small type glyph per shape — mirrors the Add gallery so they read the same
    const KIND_ICON = {
      box: '□', cylinder: '▮', sphere: '●', cone: '▲', pyramid: '◭', prism: '⬡',
      gear: '⚙', wedge: '◣', torus: '◍', dome: '◗', slot: '▭', star: '★',
      roundedBox: '▢', roundedCylinder: '▯', chamferedBox: '◇', chamferedCylinder: '⬢', tube: '◎',
      text: 'T', bolt: '🔩', nut: '⬢', thread: '▎',
      counterbore: '⌽', countersink: '⌵', insertHole: '◎', nutTrap: '⬡', keyhole: '🔑',
      imported: '⬚', extrusion: '✎', revolution: '◓',
    };
    const iconOf = (n) => KIND_ICON[n.kind] || '◆';
    const nameOf = (n) => n.kind === 'imported' ? (n.meshName || 'mesh')
      : n.kind === 'extrusion' ? 'sketch' : n.kind === 'revolution' ? 'lathe'
      : (KIND_LABEL[n.kind] || n.kind);
    const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    const sel = new Set(this.selectedNodes);
    nodes.forEach((node, idx) => {
      const on = sel.has(idx);
      const row = document.createElement('div');
      row.className = 'pl-row' + (on ? ' sel' : '') + (node.op === 'hole' ? ' is-hole' : '') + (node.hidden ? ' is-hidden' : '');
      row.dataset.node = idx;
      row.innerHTML = `
        <button class="pl-sel${on ? ' on' : ''}" data-sel="${idx}" title="Add to / remove from selection" aria-pressed="${on}">${on ? '◉' : '◯'}</button>
        <input type="color" class="pl-color" data-rcolor="${idx}" value="${hex(node.color)}" title="Colour" ${node.op === 'hole' ? 'disabled' : ''}>
        <button class="pl-name" data-edit="${idx}" title="Edit this part"><span class="pl-ico" aria-hidden="true">${iconOf(node)}</span>${esc(nameOf(node))}</button>
        ${node.group != null ? `<span class="pl-grp" title="Group ${node.group}">G${node.group}</span>` : ''}
        <button class="pl-op ${node.op}" data-op="${idx}" title="Toggle solid / hole">${node.op}</button>
        <button class="pl-ic${node.locked ? ' on' : ''}" data-rlock="${idx}" title="Lock position">${node.locked ? '🔒' : '🔓'}</button>
        <button class="pl-ic" data-rhide="${idx}" title="${node.hidden ? 'Show' : 'Hide'}">${node.hidden ? '🚫' : '👁'}</button>
        <button class="pl-ic" data-rdup="${idx}" title="Duplicate">⧉</button>
        <button class="pl-del" data-del="${idx}" title="Remove">✕</button>`;
      host.appendChild(row);
    });
    host.querySelectorAll('[data-sel]').forEach((el) => el.addEventListener('click', () => this._selectNode(+el.dataset.sel, true)));
    host.querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.edit;
      const rect = el.getBoundingClientRect(); // capture before the list re-renders
      if (this.selectedNodes.length <= 1 || !this.selectedNodes.includes(i)) this._selectNode(i, false);
      this._openPartModal(rect);
    }));
    host.querySelectorAll('[data-op]').forEach((el) => el.addEventListener('click', () => {
      const n = this.buildTree.nodes[+el.dataset.op]; n.op = n.op === 'hole' ? 'solid' : 'hole';
      this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => this._deleteNode(+el.dataset.del)));
    host.querySelectorAll('[data-rcolor]').forEach((el) => el.addEventListener('input', () => {
      this.buildTree.nodes[+el.dataset.rcolor].color = parseInt(el.value.slice(1), 16); this._scheduleRecompile();
    }));
    host.querySelectorAll('[data-rlock]').forEach((el) => el.addEventListener('click', () => {
      const n = this.buildTree.nodes[+el.dataset.rlock]; n.locked = !n.locked; this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-rhide]').forEach((el) => el.addEventListener('click', () => {
      const n = this.buildTree.nodes[+el.dataset.rhide]; n.hidden = !n.hidden; this._renderBuildTree(); this.recompile(); this._pushHistory();
    }));
    host.querySelectorAll('[data-rdup]').forEach((el) => el.addEventListener('click', () => this._duplicateNode(+el.dataset.rdup)));
  }
}

export function installBuildPane(App) {
  for (const name of Object.getOwnPropertyNames(BuildPaneRenderers.prototype)) {
    if (name !== 'constructor') App.prototype[name] = BuildPaneRenderers.prototype[name];
  }
}
