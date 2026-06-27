// The app shell markup, generated as one string. Kept out of app.js so the
// controller stays logic rather than a ~290-line template. The App passes the
// Add-gallery and g-code-help HTML in; the toolbar seed comes from its registry.
import { toolbarSeedHTML } from './toolbar.js';
import { TEMPLATES } from './templates.js';
import { esc } from './escape.js';

// ☰ Templates▸ flyout — generated from TEMPLATES so the menu never drifts from
// templates.js / the add gallery / command palette.
function templatesMenuHTML() {
  return Object.keys(TEMPLATES)
    .map((key) => {
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      return `<button data-tpl="${esc(key)}">${esc(label)}</button>`;
    })
    .join('\n                  ');
}

export function appHTML({ addGallery, featuresHtml, gcodeHtml }) {
  return `
        <div id="boot" aria-hidden="false"><div class="boot-inner"><span class="boot-mark">◆</span><p>loading kernel…</p></div></div>

      <div class="stage">
        <canvas id="viewport-canvas"></canvas>

        <nav class="rail" id="rail" aria-label="Tools">
          <div class="rail-left">
          <div class="menu" id="app-menu">
            <button class="rail-btn" id="app-btn" title="Project · templates · export" aria-label="Menu">☰</button>
            <div class="menu-pop">
              <div class="menu-lab">Project</div>
              <button id="proj-new">New project</button>
              <button id="proj-back" hidden>↩ Back to previous</button>
              <button id="proj-save">Save <span class="kbd">Ctrl+S</span></button>
              <button id="proj-saveas">Save as…</button>
              <button id="proj-open">Open / manage…</button>
              <div class="menu-sep" id="proj-recent-sep" hidden></div>
              <div class="menu-lab" id="proj-recent-lab" hidden>Recent — switch</div>
              <div id="proj-recent"></div>
              <div class="menu-sep"></div>
              <div class="menu-fly" id="tpl-fly">
                <button class="menu-fly-btn">Templates<span class="fly-arr">▸</span></button>
                <div class="menu-sub">
                  ${templatesMenuHTML()}
                </div>
              </div>
              <div class="menu-fly" id="export-fly">
                <button class="menu-fly-btn">Export<span class="fly-arr">▸</span></button>
                <div class="menu-sub">
                  <button id="btn-bambu">🟢 Bambu Studio · 3MF</button>
                  <button id="btn-stl">STL — for slicing</button>
                  <button id="btn-3mf">3MF — units, colour</button>
                  <button id="btn-obj">OBJ — mesh</button>
                </div>
              </div>
              <button id="menu-import">Import…</button>
              <div class="menu-sep"></div>
              <button id="help-btn">Help</button>
            </div>
          </div>
          <div class="rail-sep"></div>
          <button class="rail-btn" id="v-undo" title="Undo (Ctrl+Z)">↶</button>
          <button class="rail-btn" id="v-redo" title="Redo (Ctrl+Y)">↷</button>
          </div>

          <div class="rail-center">
            <span class="bar-proj" id="proj-name" title="Current project — tap to rename">Untitled</span>
            <div class="hud collapsed" id="hud">
              <div class="hud-head">
                <span class="hud-headline">
                  <span id="status-dot" class="status-dot state-empty"></span>
                  <span id="status-label">empty</span>
                  <span class="hud-title">readout</span>
                </span>
                <button class="hud-x" id="hud-toggle" title="Show readout">⌄</button>
              </div>
              <div class="hud-body">
                <div class="hud-row"><span class="hud-key">size</span><span id="hud-dims">—</span></div>
                <div class="hud-row hidden" id="hud-sel-row"><span class="hud-key">select</span><span id="hud-sel">—</span></div>
                <div class="hud-row"><span class="hud-key">volume</span><span id="hud-vol">—</span></div>
                <div class="hud-row"><span class="hud-key">mesh</span><span id="hud-tris">—</span></div>
                <div class="hud-row"><span class="hud-key">state</span><span id="hud-watertight" class="hud-ok">—</span></div>
                <div class="hud-row"><span class="hud-key">fit</span><span id="hud-fit" class="hud-ok">—</span></div>
                <div class="hud-row"><span class="hud-key">filament</span><span id="hud-filament" title="Solid PLA at 1.24 g/cm³ on 1.75 mm filament — sparse infill prints use less">—</span></div>
              </div>
            </div>
          </div>

          <div class="rail-right">
          <button class="rail-btn workspace-toggle" id="workspace-toggle" type="button" aria-pressed="true" title="Preview result (hide panel)" aria-label="Preview result (hide panel)"></button>
          <div class="rail-sep"></div>
          <button class="rail-btn" id="cmd-open" title="Find a command (Ctrl+K)">⌕</button>
          <button class="rail-btn add-round" id="add-open" title="Add a shape, part, or ready-made object">＋</button>
          </div>
        </nav>

        <nav class="toolbar" id="tools" aria-label="View and build tools">
          <div class="toolbar-grip" id="tools-grip" title="Drag to move the toolbar">
            <span class="grip-dots" aria-hidden="true">⠿</span>
            <button type="button" class="toolbar-edit" id="tools-display" title="Icons only — tap for icons + labels">▣</button>
            <button type="button" class="toolbar-edit" id="tools-edit" title="Customize toolbar — add or group tools">✎</button>
          </div>
          <!-- tool buttons are generated from the TOOLBAR_TOOLS registry; the
               toolbar then parks them and lays out the bar per the saved/default
               layout (see toolbar.js) — so this seed is just a flat parking lot -->
          <div class="toolbar-body" id="tools-body">
          ${toolbarSeedHTML()}
          </div>
        </nav>

        <!-- one draggable/dockable card hosts BOTH authoring surfaces: the model
             -source editor (code mode) and the parts inspector (build mode). The
             active mode's content shows; the other is hidden (see _syncCardDomain
             + .part-card.dom-code in styles.css). Result hides the whole card. -->
        <div id="part-card" class="part-card dock-right hidden" role="region" aria-label="Editor and parts">
          <div id="card-resize" class="card-resize" title="Drag to resize · double-click for full width" aria-hidden="true"></div>
          <div class="card-head" id="card-head">
            <span class="card-grip" title="Drag to move · snaps to either edge">⠿</span>
            <div class="card-mode-seg" id="card-mode-seg" role="group" aria-label="Code or Build">
              <button type="button" class="card-mode-opt" id="card-mode-code" data-mode="code" aria-pressed="false" title="Write the model as source code">Code</button>
              <button type="button" class="card-mode-opt" id="card-mode-build" data-mode="build" aria-pressed="false" title="Edit parts on the plate">Build</button>
            </div>
            <span class="card-head-acts">
              <button id="card-layout" class="card-ic" title="Side panel / bottom bar">⟷</button>
              <button id="card-snap" class="card-ic" title="Dock left / right">▣</button>
              <button id="card-min" class="card-ic" title="Collapse">«</button>
            </span>
          </div>
          <div class="pcols" id="pcols">
            <!-- code mode: model-source editor (.hidden in build; the build columns
                 below are hidden in code via .part-card.dom-code) -->
            <section id="pane-code" class="pane pane-code">
              <div class="code-workspace" id="code-workspace">
                <div class="code-main">
                  <div class="code-toolbar">
                    <span class="code-file-tab on" title="Model source">model source</span>
                    <div class="code-toolbar-acts">
                      <span class="code-kbd-hint" title="Editor shortcuts">Tab · Ctrl+/ comment · Ctrl+D dup · Ctrl+Enter run</span>
                      <button type="button" class="code-tb-btn" id="editor-wrap-toggle" title="Toggle line wrap">wrap</button>
                      <button type="button" class="code-tb-btn" id="strip-comments" title="Remove all // comments from the source">strip //</button>
                      <button type="button" class="code-tb-btn" id="params-show" title="Show parameters (Ctrl+\\)" hidden>params</button>
                    </div>
                  </div>
                  <div class="editor-shell">
                    <div class="editor-gutter" id="editor-gutter" aria-hidden="true">
                      <pre class="editor-ln" id="editor-ln"></pre>
                    </div>
                    <div class="editor-wrap">
                      <div class="editor-active-line" id="editor-active-line" aria-hidden="true"></div>
                      <pre class="editor-hl" aria-hidden="true"><code id="editor-code"></code></pre>
                      <textarea id="editor" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" aria-label="Model source code" wrap="off"></textarea>
                    </div>
                  </div>
                  <div id="error" class="error" role="alert" tabindex="0" aria-live="polite"></div>
                </div>
                <div class="code-splitter" id="code-splitter" title="Drag to resize parameters panel" aria-hidden="true"></div>
                <aside class="code-params-pane" id="code-params-pane" aria-label="Parameters">
                  <div class="code-params-head">
                    <span class="pane-title">parameters</span>
                    <button type="button" class="code-tb-btn sm" id="params-hide" title="Hide parameters (Ctrl+\\)">▾</button>
                  </div>
                  <div id="params" class="params"></div>
                </aside>
              </div>
            </section>
            <div class="pcol-main">
              <input type="file" id="stl-file" accept=".stl,.obj,.3mf,model/stl,application/sla" hidden>
              <div class="ppane" data-pane="parts">
                <div class="parts-head">
                  <p class="hint" id="parts-hint">Tap a part to edit · tap ⊹ multi to pick several</p>
                  <div class="parts-head-acts">
                    <button class="mini-btn js-multi" id="multi-head" title="Multi-select: tap this, then tap parts in the scene to add them (tap again to finish)" hidden>⊹ multi</button>
                    <button class="mini-btn" id="clear-canvas" title="Remove all parts from the plate" hidden>Clear</button>
                  </div>
                </div>
                <div id="build-list" class="build-list"></div>
              </div>
            </div>
            <div class="pcol-edit hidden" id="pcol-edit">
              <div class="pedit-head">
                <span class="pedit-label">Size</span>
                <span id="part-modal-metrics" class="pm-metrics">—</span>
              </div>
              <div id="part-modal-fields"></div>
              <div class="print-prep-strip" id="print-prep-strip">
                <span class="print-prep-title">Print prep</span>
                <button type="button" data-op-act="drop" class="prep-chip" title="Seat selection on the build plate">⤓ on bed</button>
                <button type="button" data-op-act="center" class="prep-chip" title="Centre selection on plate origin (0,0)">⊹ centre</button>
                <button type="button" data-print-ready class="prep-chip prep-go" title="Centre, drop, and check fit">✓ print ready</button>
                <button type="button" data-prep-group class="prep-chip" title="Group selected parts">▣ group</button>
              </div>
              <div class="edit-tools" id="edit-tools">
                <div class="edit-tool-tabs" role="tablist" aria-label="Part tools">
                  <button type="button" class="edit-tool-tab on" data-ttab="move" role="tab" aria-selected="true">Move</button>
                  <button type="button" class="edit-tool-tab" data-ttab="place" role="tab" aria-selected="false">Place</button>
                  <button type="button" class="edit-tool-tab" data-ttab="multi" role="tab" aria-selected="false" hidden>Multi</button>
                </div>
                <div class="edit-tool-pane on" data-ttab="move" role="tabpanel">
                  <div class="xform" id="xform">
                    <button data-xform="translate" class="on" title="Move (W)">↔ move</button>
                    <button data-xform="rotate" title="Rotate (E)">⟳ turn</button>
                    <button data-xform="scale" title="Scale (R)">⤢ size</button>
                    <button id="multi-toggle" class="js-multi" title="Multi-select — or long-press a part in the scene. Tap parts to add; tap empty to finish.">⊹ multi</button>
                  </div>
                  <div class="xform xform-sub" id="wpbar">
                    <span class="xform-label">workplane</span>
                    <button data-wp="face" title="Click a face to build on it">⊞ on face</button>
                    <button data-wp="ground" title="Reset the workplane to the ground">⊞ ground</button>
                  </div>
                </div>
                <div class="edit-tool-pane" data-ttab="place" role="tabpanel">
                  <p class="edit-tool-hint">Seat, centre, mirror, or cut the selected part (or group) on the plate.</p>
                  <div class="edit-tool-block">
                    <span class="edit-tool-block-title">Laser cut</span>
                    <p class="edit-tool-hint cut-plane-hint" id="cut-plane-hint" hidden>Move/turn the red plane with ↔ move / ⟳ turn, then <strong>cut here</strong>. Point: <span id="cut-plane-readout">—</span></p>
                    <p class="edit-tool-hint seam-hint">Seam gap (2 parts): <span id="seam-readout">—</span> · a dark line is often just edge outlines, not a gap</p>
                    <div class="tool-chip-grid" id="cutbar">
                      <button data-cut-plane="toggle" title="Show a movable cut plane across the plate">⚡ laser</button>
                      <button data-cut-plane="apply" title="Split the part along the plane">✂ cut here</button>
                      <button data-cut-plane="reset" title="Level the plane through the selection centre">⟲ level plane</button>
                      <button data-cut-plane="check" title="Measure closest distance between two selected parts">📏 check seam</button>
                    </div>
                  </div>
                  <div class="tool-chip-grid" id="opsbar">
                    <button data-op-act="drop" title="Drop onto the plate">⤓ on base</button>
                    <button data-op-act="center" title="Center on the plate">⊹ centre</button>
                    <button data-op-act="level" title="Reset rotation">⟲ level</button>
                    <button data-op-act="scale" title="Reset scale to 1:1">1:1 scale</button>
                    <button data-op-act="stack" title="Rest on top of other parts">↥ stack</button>
                    <button data-flip="x" title="Mirror across X">⇋ X</button>
                    <button data-flip="y" title="Mirror across Y">⇋ Y</button>
                    <button data-flip="z" title="Mirror across Z">⇋ Z</button>
                    <button data-cut-half="z" title="Quick cut: top / bottom at centre">✂ top/bottom</button>
                    <button data-cut-half="x" title="Quick cut: left / right at centre">✂ left/right</button>
                    <button data-cut-half="y" title="Quick cut: front / back at centre">✂ front/back</button>
                  </div>
                </div>
                <div class="edit-tool-pane" data-ttab="multi" role="tabpanel">
                  <p class="edit-tool-hint">Pick 2+ parts. <strong>Group</strong> links them for move/rotate. <strong>Combine</strong> sets how their solids merge.</p>
                  <div class="edit-tool-block">
                    <span class="edit-tool-block-title">Align</span>
                    <div class="align-grid" id="alignbar">
                      <span class="ag-ax">X</span>
                      <button data-align="x:min" title="Align left (X min)">⊣</button>
                      <button data-align="x:center" title="Center on X">┼</button>
                      <button data-align="x:max" title="Align right (X max)">⊢</button>
                      <span class="ag-ax">Y</span>
                      <button data-align="y:min" title="Align front (Y min)">⊣</button>
                      <button data-align="y:center" title="Center on Y">┼</button>
                      <button data-align="y:max" title="Align back (Y max)">⊢</button>
                      <span class="ag-ax">Z</span>
                      <button data-align="z:min" title="Align down (Z min)">⊣</button>
                      <button data-align="z:center" title="Center on Z">┼</button>
                      <button data-align="z:max" title="Align up (Z max)">⊢</button>
                    </div>
                  </div>
                  <div class="edit-tool-block">
                    <span class="edit-tool-block-title">Group &amp; combine</span>
                    <div class="tool-chip-grid" id="groupbar">
                      <button data-group="group" title="Link parts — move, rotate, duplicate and delete as one (Ctrl+G)">▣ group</button>
                      <button data-group="ungroup" title="Split grouped parts back into separate pieces (Ctrl+Shift+G)">▢ ungroup</button>
                      <button data-gmode="union" title="Combine mode: join into one solid (default)">∪ union</button>
                      <button data-gmode="subtract" title="Combine mode: first selected part cuts the rest away">∖ subtract</button>
                      <button data-gmode="intersect" title="Combine mode: keep only where parts overlap">∩ intersect</button>
                      <button data-gmode="hull" title="Combine mode: smooth convex wrap around all parts">⬭ hull</button>
                    </div>
                  </div>
                  <div class="edit-tool-block">
                    <span class="edit-tool-block-title">Array</span>
                    <div class="tool-chip-grid" id="arraybar">
                      <label class="arr-f">×<input type="number" id="arr-n" value="4" min="2" max="64" step="1"></label>
                      <label class="arr-f">gap mm<input type="number" id="arr-gap" value="25" step="1"></label>
                      <button data-arr="x" title="Row along X">↔ row X</button>
                      <button data-arr="y" title="Row along Y">↕ row Y</button>
                      <button data-arr="polar" title="Ring around the centre">⟳ ring</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="layer-bar" class="layer-bar hidden">
          <span id="layer-label" class="layer-label">layer</span>
          <input type="range" id="layer-range" min="0" max="0" value="0" step="1" aria-label="Layer">
        </div>

        <div id="sketch-bar" class="sketch-bar hidden">
          <div class="sketch-modes" id="sketch-modes">
            <button data-smode="extrude" class="on" title="Pull the outline straight up">▤ extrude</button>
            <button data-smode="revolve" title="Spin the profile around the axis (vases, knobs)">⟳ revolve</button>
          </div>
          <span class="sketch-hint" id="sketch-hint">tap points · tap the first dot to close</span>
          <label class="sketch-h" id="sketch-h-lab">height<input type="number" id="sketch-h" value="10" min="0.4" step="1"></label>
          <label class="sketch-h" title="Round the corners (0 = sharp)">round<input type="number" id="sketch-round" value="0" min="0" step="0.5"></label>
          <button id="sketch-undo" title="Remove the last point">↶ point</button>
          <button id="sketch-finish" class="sketch-go" title="Close the shape and build it">Finish ✓</button>
          <button id="sketch-cancel" title="Discard">Cancel</button>
        </div>

        <div id="ctx-menu" class="ctx-menu hidden" role="menu"></div>

        <div id="help-modal" class="modal-overlay center hidden" role="dialog" aria-modal="true" aria-labelledby="help-modal-title" aria-hidden="true">
          <div class="modal-panel help-panel">
            <div class="modal-head">
              <span class="modal-title" id="help-modal-title">Help</span>
              <button class="modal-x" id="help-close" aria-label="Close">✕</button>
            </div>
            <div class="help-tabs" role="tablist" aria-label="Help sections">
              <button type="button" class="help-tab on" data-help-tab="features" role="tab" aria-selected="true">Features</button>
              <button type="button" class="help-tab" data-help-tab="gcode" role="tab" aria-selected="false">G-code guide</button>
            </div>
            <div class="modal-body help-body">
              <div id="help-features" class="help-pane" role="tabpanel">${featuresHtml}</div>
              <div id="help-gcode" class="help-pane hidden" role="tabpanel">${gcodeHtml}</div>
            </div>
          </div>
        </div>

        <div id="proj-modal" class="modal-overlay center hidden">
          <div class="modal-panel">
            <div class="modal-head">
              <span class="modal-title">Projects</span>
              <button class="modal-x" id="proj-modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body">
              <div id="proj-list" class="proj-list"></div>
            </div>
          </div>
        </div>

        <div id="name-modal" class="modal-overlay center hidden">
          <div class="modal-panel name-panel">
            <div class="modal-head">
              <span class="modal-title" id="name-title">Name</span>
              <button class="modal-x" id="name-cancel" aria-label="Cancel">✕</button>
            </div>
            <div class="modal-body">
              <input type="text" id="name-input" class="name-input" placeholder="Project name" spellcheck="false" maxlength="60">
              <div class="name-actions"><button id="name-ok" class="add-open-btn">Save</button></div>
            </div>
          </div>
        </div>

        <div id="toolbar-modal" class="modal-overlay center hidden">
          <div class="modal-panel toolbar-panel" role="dialog" aria-label="Customize toolbar">
            <div class="modal-head">
              <span class="modal-title">Customize toolbar</span>
              <button type="button" class="tbm-reset" id="toolbar-reset" title="Restore the default toolbar">Reset</button>
              <button class="modal-x" id="toolbar-modal-close" aria-label="Close">✕</button>
            </div>
            <div class="modal-body" id="toolbar-edit-body"></div>
          </div>
        </div>

        <div id="cmd-modal" class="modal-overlay center hidden">
          <div class="modal-panel cmd-panel" role="dialog" aria-label="Command palette">
            <input id="cmd-input" class="cmd-input" type="text" spellcheck="false" autocomplete="off"
                   placeholder="Type a command…  e.g. add box · export STL · auto-orient · simple">
            <div id="cmd-list" class="cmd-list" role="listbox"></div>
          </div>
        </div>

        <div id="add-modal" class="modal-overlay hidden">
          <div class="modal-panel" role="dialog" aria-label="Add to scene">
            <div class="modal-head">
              <span class="modal-title">Add to scene</span>
              <button class="modal-x" id="add-close" title="Close (Esc)">✕</button>
            </div>
            <div class="modal-body">
              <input id="add-search" class="add-search" type="text" placeholder="🔍 Search shapes, parts, fasteners…" spellcheck="false" autocomplete="off">
              <div id="add-empty" class="add-empty-msg hidden">No matches</div>
              ${addGallery}
            </div>
          </div>
        </div>

        <div class="measure-label" id="measure-label"></div>
        <div class="xform-readout" id="xform-readout"></div>
      </div>`;
}
