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
      <div id="boot"><div class="boot-inner"><span class="boot-mark">◆</span><p>loading kernel…</p></div></div>

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
          <div class="modeseg" id="mode-seg" role="group" aria-label="Workspace — code, build, result, and the source panel">
            <button class="modeseg-opt" id="seg-code" type="button" data-view="code" aria-pressed="false" title="Code — write the model as text">Code</button>
            <button class="modeseg-opt" id="seg-build" type="button" data-view="build" aria-pressed="false" title="Build — edit the parts visually">Build</button>
            <button class="modeseg-opt" id="seg-result" type="button" data-view="result" aria-pressed="false" title="Result — preview the finished solid">Result</button>
            <span class="modeseg-div" aria-hidden="true"></span>
            <button class="modeseg-opt pane" id="seg-panel" type="button" data-action="panel" aria-pressed="false" aria-label="Show or hide the side panel" title="Show / hide the side panel"></button>
          </div>
          <div class="rail-sep"></div>
          <button class="rail-btn" id="cmd-open" title="Find a command (Ctrl+K)">⌕</button>
          <button class="rail-btn add-round" id="add-open" title="Add a shape, part, or ready-made object">＋</button>
          </div>
        </nav>

        <nav class="toolbar dock-left" id="tools" aria-label="View and build tools">
          <div class="toolbar-grip" id="tools-grip" title="Drag to move the toolbar">
            <span class="grip-dots" aria-hidden="true">⠿</span>
            <button class="toolbar-edit" id="tools-edit" title="Customize toolbar — add or group tools">✎</button>
          </div>
          <!-- tool buttons are generated from the TOOLBAR_TOOLS registry; the
               toolbar then parks them and lays out the bar per the saved/default
               layout (see toolbar.js) — so this seed is just a flat parking lot -->
          <div class="toolbar-body" id="tools-body">
          ${toolbarSeedHTML()}
          </div>
        </nav>

        <aside class="panel" id="panel">
          <section id="pane-code" class="pane">
            <div class="pane-title">model source</div>
            <div class="editor-wrap">
              <pre class="editor-hl" aria-hidden="true"><code id="editor-code"></code></pre>
              <textarea id="editor" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"></textarea>
            </div>
            <div id="error" class="error"></div>
            <div class="pane-title">parameters</div>
            <div id="params" class="params"></div>
          </section>

          <!-- build editing now lives in the floating #part-card; this stub keeps
               mode-toggle code that references #pane-build working -->
          <section id="pane-build" class="pane hidden"></section>
        </aside>
        <div id="panel-resize" title="Drag to resize the panel"></div>

        <div id="part-card" class="part-card dock-right hidden" role="region" aria-label="Parts and tools">
          <div class="card-head" id="card-head">
            <span class="card-grip" title="Drag to move · snaps to either edge">⠿</span>
            <span class="card-title" id="parts-count">Parts</span>
            <span class="card-head-acts">
              <button id="card-layout" class="card-ic" title="Side panel / bottom bar">⟷</button>
              <button id="card-snap" class="card-ic" title="Dock left / right">▣</button>
              <button id="card-min" class="card-ic" title="Collapse">«</button>
            </span>
          </div>
          <div class="pcols" id="pcols">
            <div class="pcol-main">
              <input type="file" id="stl-file" accept=".stl,.obj,.3mf,model/stl,application/sla" hidden>
              <div class="ppane" data-pane="parts">
                <div class="parts-head">
                  <p class="hint" id="parts-hint">Tap a part to edit · long-press to multi-select</p>
                  <button class="mini-btn" id="clear-canvas" title="Remove all parts from the plate" hidden>Clear</button>
                </div>
                <div id="build-list" class="build-list"></div>
              </div>
            </div>
            <div class="pcol-edit hidden" id="pcol-edit">
              <div class="pedit-head">Edit <span id="part-modal-metrics" class="pm-metrics">—</span></div>
              <div id="part-modal-fields"></div>
              <div class="card-tools">
            <div class="xform" id="xform">
              <button data-xform="translate" class="on" title="Move (W)">↔ move</button>
              <button data-xform="rotate" title="Rotate (E)">⟳ turn</button>
              <button data-xform="scale" title="Scale (R)">⤢ size</button>
              <button id="multi-toggle" title="Multi-select — or long-press a part in the scene. Tap parts to add; tap empty to finish.">⊹ multi</button>
            </div>
            <div class="xform" id="wpbar">
              <span class="xform-label">plane</span>
              <button data-wp="face" title="Click a face to build on it">⊞ on face</button>
              <button data-wp="ground" title="Reset the workplane to the ground">⊞ ground</button>
            </div>
            <div class="xform hidden" id="opsbar">
              <span class="xform-label">place</span>
              <button data-op-act="drop" title="Drop onto the plate">⤓ base</button>
              <button data-op-act="center" title="Center on the plate">⊹ center</button>
              <button data-op-act="level" title="Reset rotation">⟲ level</button>
              <button data-op-act="scale" title="Reset scale to 1:1">1:1</button>
              <button data-op-act="stack" title="Rest the last-selected part on top of the others">↥ stack</button>
              <button data-flip="x" title="Mirror across X">⇋X</button>
              <button data-flip="y" title="Mirror across Y">⇋Y</button>
              <button data-flip="z" title="Mirror across Z">⇋Z</button>
            </div>
            <div class="xform hidden" id="arraybar">
              <span class="xform-label">array</span>
              <label class="arr-f">×<input type="number" id="arr-n" value="4" min="2" max="64" step="1"></label>
              <label class="arr-f">gap<input type="number" id="arr-gap" value="25" step="1"></label>
              <button data-arr="x" title="Row along X">↔ X</button>
              <button data-arr="y" title="Row along Y">↕ Y</button>
              <button data-arr="polar" title="Ring around the centre">⟳ ring</button>
            </div>
            <div class="xform hidden" id="alignbar">
              <span class="xform-label">align</span>
              <div class="align-grid">
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
            <div class="xform hidden" id="groupbar">
              <span class="xform-label">group</span>
              <button data-group="group" title="Group selection (Ctrl+G)">▣ group</button>
              <button data-group="ungroup" title="Ungroup (Ctrl+Shift+G)">▢ ungroup</button>
              <button data-gmode="union" title="Join (union)">∪</button>
              <button data-gmode="subtract" title="Subtract — first part minus the rest">∖</button>
              <button data-gmode="intersect" title="Keep only the overlap (intersection)">∩</button>
              <button data-gmode="hull" title="Hull — smooth blend / loft across the parts">⬭</button>
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

        <div id="help-modal" class="modal-overlay center hidden">
          <div class="modal-panel help-panel">
            <div class="modal-head">
              <span class="modal-title">Help</span>
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
