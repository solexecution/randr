// Every app feature for the Help modal: icon, shortcut, one-line description.
// Single source of truth — add new tools here when you add them to the UI.
import { esc } from './escape.js';

/** @typedef {{ icon: string, key: string, desc: string }} FeatureRow */
/** @typedef {{ title: string, items: FeatureRow[] }} FeatureSection */

/** @type {FeatureSection[]} */
export const FEATURE_SECTIONS = [
  {
    title: 'Workspace',
    items: [
      { icon: 'Code', key: '—', desc: 'Write the model as parametric source text and edit with sliders.' },
      { icon: 'Build', key: '—', desc: 'Place and edit shapes visually on the build plate.' },
      { icon: 'Result', key: '—', desc: 'Preview the merged solid with holes cut and groups applied.' },
      { icon: '◨', key: '—', desc: 'Show or hide the code editor side panel.' },
      { icon: '⌕', key: 'Ctrl+K', desc: 'Open the command palette to search every action.' },
      { icon: '＋', key: '—', desc: 'Open the Add gallery for shapes, templates, sketch, and import.' },
      { icon: 'Esc', key: 'Esc', desc: 'Close the topmost modal, context menu, or cancel sketch.' },
    ],
  },
  {
    title: 'Project',
    items: [
      { icon: '☰', key: '—', desc: 'Open the app menu for project, templates, export, import, and help.' },
      { icon: 'New project', key: '—', desc: 'Start a blank design and save it as a new project.' },
      { icon: 'Save', key: 'Ctrl+S', desc: 'Save the current project to browser storage.' },
      { icon: 'Save as…', key: '—', desc: 'Duplicate the project under a new name.' },
      { icon: 'Open / manage…', key: '—', desc: 'Browse, open, rename, or delete saved projects.' },
      { icon: '↩ Back', key: '—', desc: 'Return to the previous project you were editing.' },
      { icon: 'Untitled', key: '—', desc: 'Click the project name in the top bar to rename inline.' },
      { icon: 'Import…', key: '—', desc: 'Load an STL, OBJ, or 3MF mesh into the build.' },
      { icon: 'Templates ▸', key: '—', desc: 'Insert a ready-made adjustable design from the menu.' },
    ],
  },
  {
    title: 'History',
    items: [
      { icon: '↶', key: 'Ctrl+Z', desc: 'Undo the last change to code or build tree.' },
      { icon: '↷', key: 'Ctrl+Y', desc: 'Redo a change you undid.' },
    ],
  },
  {
    title: 'View & display',
    items: [
      { icon: '⌂', key: '—', desc: 'Frame the whole build plate from the front.' },
      { icon: '▦', key: 'G', desc: 'Toggle the 10 mm grid on the plate.' },
      { icon: '⊞', key: '—', desc: 'Toggle the fine 1 mm grid overlay.' },
      { icon: '⌗', key: '—', desc: 'Snap moves and transforms to a 1 mm grid.' },
      { icon: '◐', key: '—', desc: 'Switch between dark and light interface themes.' },
      { icon: '◇', key: '—', desc: 'Show the model as a wireframe overlay.' },
      { icon: '◕', key: '—', desc: 'Cycle curve quality (Draft → Ultra) for round shapes.' },
      { icon: 'F', key: 'F', desc: 'Fit the camera to the current model.' },
      { icon: '⌄', key: '—', desc: 'Expand or collapse the size/volume HUD readout.' },
      { icon: '✎', key: '—', desc: 'Customize which tools appear on the floating toolbar.' },
      { icon: '⠿', key: '—', desc: 'Drag the toolbar grip to float or dock it on an edge.' },
      { icon: '⟷', key: '—', desc: 'Switch the parts card between side panel and bottom bar layout.' },
      { icon: 'Nav cube', key: '—', desc: 'Click faces on the view cube to jump to standard views.' },
      { icon: 'Scroll', key: '—', desc: 'Zoom the view; pinch or scroll wheel on the canvas.' },
      { icon: 'Drag', key: '—', desc: 'Orbit the camera; right-drag or two-finger drag to pan.' },
    ],
  },
  {
    title: 'Inspect & print prep',
    items: [
      { icon: '📏', key: '—', desc: 'Measure distance between two clicked points; double-click to clear pins.' },
      { icon: '≣', key: '—', desc: 'Preview slice layers with a slider through the model height.' },
      { icon: '◣', key: '—', desc: 'Highlight downward faces that need support when printing.' },
      { icon: '⤓', key: '—', desc: 'Auto-rotate the model to minimize overhang for printing.' },
      { icon: '⤡', key: '—', desc: 'Uniformly scale the model to fit the 180 mm build plate.' },
      { icon: '✂', key: '—', desc: 'Cut the model in half with a gap for gluing two print pieces.' },
    ],
  },
  {
    title: 'Add & sketch',
    items: [
      { icon: '✎ sketch', key: '—', desc: 'Draw a closed 2D outline on the plate and extrude or revolve it.' },
      { icon: '▤ extrude', key: '—', desc: 'Pull a sketched profile straight up into a solid.' },
      { icon: '⟳ revolve', key: '—', desc: 'Spin a sketched profile around the axis (vases, knobs).' },
      { icon: '↶ point', key: '—', desc: 'Remove the last point while sketching.' },
      { icon: 'Finish ✓', key: '—', desc: 'Close the sketch and create an extrusion or revolution part.' },
      { icon: 'Cancel', key: 'Esc', desc: 'Discard the current sketch without adding a part.' },
      { icon: 'on a face…', key: '—', desc: 'Engrave text onto a selected face of an existing part.' },
      { icon: 'STL / OBJ / 3MF', key: '—', desc: 'Import an external mesh as an editable imported part.' },
      { icon: 'Ready-made', key: '—', desc: 'Drop in adjustable templates like soap dishes, brackets, and fit tests.' },
    ],
  },
  {
    title: 'Parts card & selection',
    items: [
      { icon: '⠿', key: '—', desc: 'Drag the parts card header to float it or snap to left/right.' },
      { icon: '▣', key: '—', desc: 'Snap the parts card to the opposite screen edge.' },
      { icon: '«', key: '—', desc: 'Collapse the parts card; use the edge tab to reopen it.' },
      { icon: 'Tap part', key: '—', desc: 'Select a part in the scene or list to edit its fields.' },
      { icon: '⊹ multi', key: '—', desc: 'Sticky multi-select: tap parts to add; tap empty space to finish.' },
      { icon: 'Long-press', key: '—', desc: 'Long-press a part in the scene to arm multi-select mode.' },
      { icon: 'Right-click', key: '—', desc: 'Open the full action menu for the clicked part.' },
      { icon: 'Gizmo', key: '—', desc: 'Drag the move/rotate/scale handles on a selected part.' },
      { icon: 'Alt+drag', key: 'Alt', desc: 'Hold Alt while dragging to disable magnetic snap to other parts.' },
      { icon: 'Clear', key: '—', desc: 'Remove every part from the build plate (confirm on second click).' },
    ],
  },
  {
    title: 'Transform (build mode)',
    items: [
      { icon: '↔ move', key: 'W', desc: 'Switch the gizmo to translate mode.' },
      { icon: '⟳ turn', key: 'E', desc: 'Switch the gizmo to rotate mode.' },
      { icon: '⤢ size', key: 'R', desc: 'Switch the gizmo to scale mode.' },
      { icon: 'Arrows', key: '←↑→↓', desc: 'Nudge the selection 1 mm on X/Y; hold Shift for 10 mm.' },
      { icon: 'PgUp/Dn', key: 'PgUp/Dn', desc: 'Nudge the selection 1 mm on Z; hold Shift for 10 mm.' },
    ],
  },
  {
    title: 'Place & mirror',
    items: [
      { icon: '⤓ base', key: 'B', desc: 'Drop the selection so its bottom sits on the plate.' },
      { icon: '⊹ center', key: 'C', desc: 'Center the selection on the build plate in X and Y.' },
      { icon: '⟲ level', key: 'Shift+E', desc: 'Reset rotation to upright on the plate.' },
      { icon: '1:1', key: 'Shift+R', desc: 'Reset scale back to 1×1×1.' },
      { icon: '↥ stack', key: 'S', desc: 'Rest the last-selected part on top of the others.' },
      { icon: '⊞ on face', key: '—', desc: 'Pick a face to use as the custom workplane for new parts.' },
      { icon: '⊞ ground', key: '—', desc: 'Reset the workplane back to the ground plate.' },
      { icon: '⇋X/Y/Z', key: 'X / Y / Z', desc: 'Mirror the selection across the chosen axis.' },
      { icon: 'Onto a face…', key: '—', desc: 'Drop the selected part onto a face you click in the scene.' },
    ],
  },
  {
    title: 'Edit part properties',
    items: [
      { icon: 'solid/hole', key: 'H', desc: 'Toggle whether the part adds material or cuts a hole.' },
      { icon: '🔒', key: 'L', desc: 'Lock or unlock the part so it cannot be moved.' },
      { icon: '👁', key: 'Shift+H', desc: 'Hide or show the part in the scene without deleting it.' },
      { icon: '⧉', key: 'Ctrl+D', desc: 'Duplicate the selected part(s).' },
      { icon: '✕', key: 'Del', desc: 'Delete the selected part(s) from the build.' },
      { icon: 'Break apart', key: 'Shift+B', desc: 'Split one mesh into separate movable connected pieces.' },
      { icon: 'Kind ▾', key: '—', desc: 'Change the primitive type and reset its default dimensions.' },
      { icon: 'Colour', key: '—', desc: 'Pick a part colour used in build view and multi-colour 3MF export.' },
      { icon: 'Clearance', key: '—', desc: 'Add press-fit clearance on holes or shrink solids for fits.' },
      { icon: 'Shell', key: '—', desc: 'Hollow a solid into a walled shell with adjustable thickness.' },
      { icon: 'Fillet', key: '—', desc: 'Round or chamfer convex edges on supported primitives.' },
    ],
  },
  {
    title: 'Align, array & group',
    items: [
      { icon: 'Align ⊣┼⊢', key: '—', desc: 'Align two or more parts along X, Y, or Z (min/center/max).' },
      { icon: '↔ X / ↕ Y', key: '—', desc: 'Create a row of copies along X or Y with count and gap.' },
      { icon: '⟳ ring', key: '—', desc: 'Array copies in a ring around the selection centre.' },
      { icon: '▣ group', key: 'Ctrl+G', desc: 'Group selected parts so they combine and share hole scope.' },
      { icon: '▢ ungroup', key: 'Ctrl+Shift+G', desc: 'Remove grouping from the selected parts.' },
      { icon: '∪', key: '—', desc: 'Join grouped solids with a boolean union.' },
      { icon: '∖', key: '—', desc: 'Subtract later group members from the first solid.' },
      { icon: '∩', key: '—', desc: 'Keep only the overlapping volume of grouped solids.' },
      { icon: '⬭', key: '—', desc: 'Hull grouped solids into one smooth blended shape.' },
    ],
  },
  {
    title: 'Export',
    items: [
      { icon: '🟢 3MF', key: '—', desc: 'Export for Bambu Studio with units and per-part colour.' },
      { icon: 'STL', key: '—', desc: 'Export a single mesh for any slicer.' },
      { icon: '3MF', key: '—', desc: 'Export 3MF with millimetre units and colour metadata.' },
      { icon: 'OBJ', key: '—', desc: 'Export a triangle mesh in OBJ format.' },
    ],
  },
  {
    title: 'Code mode',
    items: [
      { icon: 'param', key: '—', desc: 'Declare `param name = value;` in source to get live sliders.' },
      { icon: 'Editor', key: '—', desc: 'Type or paste Forge source; the model rebuilds as you edit.' },
      { icon: 'Syntax colours', key: '—', desc: 'Keywords, functions, numbers, and comments are highlighted behind the editor.' },
      { icon: 'Caret glow', key: '—', desc: 'The shape under the text cursor glows in the viewport while editing.' },
    ],
  },
];

export function featuresHelpHTML() {
  return FEATURE_SECTIONS.map((sec) => `
    <section class="feat-sec">
      <h3 class="feat-sec-title">${esc(sec.title)}</h3>
      <table class="feat-table" aria-label="${esc(sec.title)} features">
        <thead><tr><th scope="col">Feature</th><th scope="col">Shortcut</th><th scope="col">What it does</th></tr></thead>
        <tbody>
          ${sec.items.map((row) => `
            <tr>
              <td class="feat-icon">${esc(row.icon)}</td>
              <td class="feat-key">${esc(row.key)}</td>
              <td class="feat-desc">${esc(row.desc)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </section>`).join('');
}