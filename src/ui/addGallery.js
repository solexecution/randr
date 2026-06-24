// The Add-gallery markup. Primitive tiles come straight from the registry (label
// / title live there; the picture key is just the kind); the bespoke tiles —
// draw, engrave, ready-made templates, import — are hand-written and interleave
// with them. Each tile carries one of add (data-add primitive), tpl (data-tpl
// template), or id (special action). Categories keep their data-cat values so
// gallery search keeps working.
import { esc } from './escape.js';
import { shapeArt } from './shapeart.js';
import { PRIMITIVES, ADDABLE_KINDS } from './primitives.js';

const _t = (tpl, art, label) => ({ tpl, label: label || tpl, art });
const _prim = (kind) => ({ add: kind, label: PRIMITIVES[kind].label || kind, art: kind, title: PRIMITIVES[kind].title });
const _prims = (cat) => ADDABLE_KINDS.filter((k) => PRIMITIVES[k].cat === cat).map(_prim);

const ADD_GALLERY = [
  ['draw', 'Draw', [{ id: 'add-sketch', art: 'sketch', label: 'sketch & extrude', title: 'Draw a 2D outline on the plate and pull it into 3D' }]],
  ['basic', 'Basic shapes', _prims('basic')],
  ['rounded', 'Rounded & chamfered', _prims('rounded')],
  ['text', 'Text', [..._prims('text'), { id: 'engrave-text', art: 'engrave', label: 'on a face…' }]],
  ['fasteners', 'Fasteners', _prims('fasteners')],
  ['ready', 'Ready-made · adjustable', [
    _t('soap dish', 'soapDish'), _t('pen cup', 'penCup'), _t('coaster', 'coaster'),
    _t('stacking bin', 'stackingBin'), _t('bolt & nut', 'bolt_nut'), _t('washer', 'washer'),
    _t('L-bracket', 'lBracket'), _t('knob', 'knob'), _t('fit test', 'fitTest'),
  ]],
  ['import', 'Import', [{ id: 'modal-import', art: 'import', label: 'STL / OBJ / 3MF…' }]],
];

function _addTile(it) {
  const attr = it.add ? ` data-add="${it.add}"` : it.tpl ? ` data-tpl="${esc(it.tpl)}"` : it.id ? ` id="${it.id}"` : '';
  const title = it.title ? ` title="${esc(it.title)}"` : '';
  return `<button class="add-tile"${attr}${title}><span class="tile-art">${shapeArt(it.art)}</span><span class="tile-lab">${esc(it.label)}</span></button>`;
}

export function addGalleryHTML() {
  return ADD_GALLERY.map(([cat, title, items]) =>
    `<section class="cat" data-cat="${cat}"><h4>${esc(title)}</h4><div class="cat-grid">${items.map(_addTile).join('')}</div></section>`,
  ).join('');
}
