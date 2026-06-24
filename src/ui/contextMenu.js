// The right-click context menu — the full per-part action hub. Builds + positions
// the menu for the clicked node and dispatches each action back to App, which
// owns the actual operations (so the menu, keyboard, and palette share one source
// of truth). App delegates _showContextMenu / _ctxAction here.
export class ContextMenu {
  constructor(app) { this.app = app; }

  show(i, x, y) {
    const app = this.app;
    const menu = app.root.querySelector('#ctx-menu');
    if (!menu) return;
    if (i < 0) { menu.classList.add('hidden'); return; }
    if (!app.selectedNodes.includes(i)) app._selectNode(i, false); // act on what was clicked
    const nodes = app.buildTree.nodes, n = nodes[i];
    if (!n) { menu.classList.add('hidden'); return; }
    const can2 = app.selectedNodes.length >= 2;
    const hasGroup = app.selectedNodes.some((j) => nodes[j] && nodes[j].group != null);

    const keys = {
      dup: 'Ctrl+D', op: 'H', lock: 'L', hide: '⇧H', del: 'Del', explode: '⇧B',
      group: 'Ctrl+G', ungroup: '⇧Ctrl+G',
      'xf:translate': 'W', 'xf:rotate': 'E', 'xf:scale': 'R',
      'place:drop': 'B', 'place:center': 'C', 'place:level': '⇧E', 'place:scale': '⇧R', 'place:stack': 'S',
      'flip:x': 'X', 'flip:y': 'Y', 'flip:z': 'Z',
    };
    const btn = (act, label, danger) => `<button data-act="${act}" class="ctx-it${danger ? ' ctx-danger' : ''}"><span>${label}</span>${keys[act] ? `<span class="ctx-key">${keys[act]}</span>` : ''}</button>`;
    const sub = (label, items) => `<div class="ctx-it ctx-has-sub"><span>${label}</span><span class="ctx-arr">▸</span><div class="ctx-sub">${items.map(([a, l]) => btn(a, l)).join('')}</div></div>`;
    const sep = '<div class="ctx-sep"></div>';

    let h = '';
    h += btn('dup', 'Duplicate');
    h += btn('op', n.op === 'hole' ? 'Make solid' : 'Make hole');
    h += btn('lock', n.locked ? 'Unlock' : 'Lock');
    h += btn('hide', n.hidden ? 'Show' : 'Hide');
    h += sep;
    h += sub('Transform', [['xf:translate', 'Move'], ['xf:rotate', 'Turn'], ['xf:scale', 'Size']]);
    h += sub('Place', [['place:drop', 'Drop to base'], ['place:center', 'Center on plate'], ['place:level', 'Level (reset turn)'], ['place:scale', 'Reset size'], ['place:stack', 'Stack on top'], ['placeface', 'Onto a face…'], ['flip:x', 'Mirror X'], ['flip:y', 'Mirror Y'], ['flip:z', 'Mirror Z']]);
    if (can2) h += sub('Align', [['align:x:min', 'X — left'], ['align:x:center', 'X — center'], ['align:x:max', 'X — right'], ['align:y:min', 'Y — front'], ['align:y:center', 'Y — center'], ['align:y:max', 'Y — back'], ['align:z:min', 'Z — down'], ['align:z:center', 'Z — center'], ['align:z:max', 'Z — up']]);
    h += sub('Array', [['arr:x', 'Row along X'], ['arr:y', 'Row along Y'], ['arr:polar', 'Ring']]);
    if (can2) h += btn('group', 'Group');
    if (hasGroup) { h += btn('ungroup', 'Ungroup'); h += sub('Combine', [['gmode:union', 'Join (∪)'], ['gmode:subtract', 'Subtract (∖)'], ['gmode:intersect', 'Intersect (∩)'], ['gmode:hull', 'Hull / blend (⬭)']]); }
    h += sep;
    h += btn('explode', 'Break apart');
    h += btn('del', 'Delete', true);
    menu.innerHTML = h;

    menu.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => {
      menu.classList.add('hidden');
      this.act(b.dataset.act, i);
    }));

    // Submenus expand on tap (touch has no hover, so hover-only needed a priming
    // tap). Toggle .open, one open at a time; taps on an actual item fall through.
    menu.querySelectorAll('.ctx-has-sub').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('button[data-act]')) return; // a submenu item — let it run
      e.stopPropagation();
      const open = el.classList.contains('open');
      menu.querySelectorAll('.ctx-has-sub.open').forEach((o) => { if (o !== el) o.classList.remove('open'); });
      el.classList.toggle('open', !open);
    }));

    menu.classList.remove('hidden', 'ctx-left');
    const mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 320;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - mh - 8))}px`;
    if (x > window.innerWidth * 0.55) menu.classList.add('ctx-left'); // flyouts open leftward near the right edge
  }

  act(action, i) {
    const app = this.app;
    switch (action) {
      case 'dup': return app._duplicateSelected();
      case 'del': return app._deleteSelected();
      case 'op': return app._toggleHole([i]);
      case 'lock': return app._toggleLock([i]);
      case 'hide': return app._toggleHide([i]);
      case 'group': return app._group();
      case 'ungroup': return app._ungroup();
      case 'explode': return app._explodeNode(i);
      case 'placeface': return app._placeOnFace();
    }
    const c = action.indexOf(':');
    if (c < 0) return;
    const pre = action.slice(0, c), arg = action.slice(c + 1);
    if (pre === 'xf') app._setXform(arg);
    else if (pre === 'place') app._placeOp(arg);
    else if (pre === 'flip') app._flip(arg);
    else if (pre === 'align') app._align(arg);
    else if (pre === 'arr') app._arrayOp(arg);
    else if (pre === 'gmode') app._setGroupMode(arg);
  }
}
