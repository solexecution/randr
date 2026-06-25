// Project lifecycle: save / save-as / open / delete / rename, the recent + back
// navigation, the autosave + work timer, and the manager list. Sits on top of
// projects.js (the localStorage layer). Project *state* stays on App
// (app.project, app._workSeconds, app._prevProjectId, …); this owns the methods
// and operates on `app`. App keeps thin delegators (_saveCurrent, _openProject,
// …) so events.js, the command palette, and boot call the same names as before.
import * as Projects from './projects.js';

export class ProjectStore {
  constructor(app) { this.app = app; }

  // Write the current design into the open project (+ metadata). No-op if none.
  saveCurrent() {
    const app = this.app;
    if (!app.project) return null;
    app.project.modified = Date.now();
    app.project.seconds = app._workSeconds;
    const entry = Projects.saveProject(app.project, app._serializeDesign());
    Projects.setCurrentId(app.project.id);
    return entry;
  }

  scheduleAutosave() {
    const app = this.app;
    if (!app.project || app._restoring) return;
    clearTimeout(app._autosaveTimer);
    app._autosaveTimer = setTimeout(() => app._saveCurrent(), 1500);
  }

  newProject() {
    const app = this.app;
    if (app.project) { app._prevProjectId = app.project.id; app._saveCurrent(); }
    const meta = { id: Projects.newId(), name: app._uniqueName('Untitled'), created: Date.now(), modified: Date.now(), seconds: 0 };
    app.project = meta;
    app._workSeconds = 0;
    app._applyDesign({ v: 1, mode: 'build', source: '', viewMode: 'edit', nodes: [], meshes: {} });
    app._saveCurrent();
    app._updateProjectName();
    app._toast(`New project · ${meta.name}`);
  }

  saveProject() {
    const app = this.app;
    if (!app.project) { app._promptName('Save project as', '', (name) => app._doSaveAs(name)); return; }
    const entry = app._saveCurrent();
    app._updateProjectName();
    app._toast(entry ? `Saved “${app.project.name}”` : 'Save failed — local storage full');
  }

  doSaveAs(name) {
    const app = this.app;
    const clean = (name || '').trim();
    if (!clean) return;
    if (app.project) { app._prevProjectId = app.project.id; app._saveCurrent(); } // checkpoint the source project first
    const meta = { id: Projects.newId(), name: app._uniqueName(clean), created: Date.now(), modified: Date.now(), seconds: app._workSeconds };
    app.project = meta;
    const entry = Projects.saveProject(meta, app._serializeDesign());
    Projects.setCurrentId(meta.id);
    app._updateProjectName();
    app._toast(entry ? `Saved as “${meta.name}”` : 'Save failed — local storage full');
  }

  openProject(id) {
    const app = this.app;
    const meta = Projects.listProjects().find((p) => p.id === id);
    const data = Projects.loadProject(id);
    if (!meta || !data) { app._toast('Could not open that project'); return; }
    if (app.project && app.project.id !== id) { app._prevProjectId = app.project.id; app._saveCurrent(); }
    app.project = { id: meta.id, name: meta.name, created: meta.created, modified: meta.modified, seconds: meta.seconds || 0 };
    app._workSeconds = meta.seconds || 0;
    app._applyDesign(data);
    Projects.setCurrentId(id);
    app._updateProjectName();
    app._closeModal('#proj-modal');
    app._toast(`Opened “${meta.name}”`);
  }

  deleteProject(id) {
    const app = this.app;
    Projects.deleteProject(id);
    if (app.project && app.project.id === id) {
      // Deleted the OPEN project. Drop it from memory and cancel any pending
      // autosave FIRST — otherwise the fallback below (_openProject / _newProject
      // both checkpoint the *current* project) re-saves the just-deleted one and
      // it reappears in the list.
      clearTimeout(app._autosaveTimer);
      app.project = null;
      const next = Projects.listProjects().sort((a, b) => b.modified - a.modified)[0];
      if (next) app._openProject(next.id); else app._newProject();
    }
    app._renderProjectList();
    app._updateProjectName();
  }

  renameCurrentProject(name) {
    const app = this.app;
    const clean = (name || '').trim();
    if (!clean || !app.project) return;
    app.project.name = app._uniqueName(clean, app.project.id);
    Projects.renameProject(app.project.id, app.project.name, Date.now());
    app._updateProjectName();
    app._renderProjectList();
  }

  // Make a name unique within the index (append " 2", " 3", …).
  uniqueName(base, exceptId) {
    const taken = new Set(Projects.listProjects().filter((p) => p.id !== exceptId).map((p) => p.name));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  updateProjectName() {
    const app = this.app;
    const el = app.root.querySelector('#proj-name');
    if (el) el.textContent = app.project ? app.project.name : 'Untitled';
    app._updateProjBackBtn();
  }

  // Show the one-click "back" button only when there's a still-existing project
  // to return to (and it isn't the one already open). Switching keeps flipping
  // _prevProjectId, so the button toggles between the two most recent projects.
  updateProjBackBtn() {
    const app = this.app;
    const btn = app.root.querySelector('#proj-back');
    if (!btn) return;
    const curId = app.project && app.project.id;
    const prev = app._prevProjectId && app._prevProjectId !== curId
      ? Projects.listProjects().find((p) => p.id === app._prevProjectId)
      : null;
    btn.hidden = !prev;
    if (prev) { btn.title = `Back to “${prev.name}”`; btn.textContent = `↩ Back to “${prev.name}”`; }
  }

  // One-click jump to the project we were on before this one.
  goToPrevious() {
    const app = this.app;
    const id = app._prevProjectId;
    if (!id || (app.project && id === app.project.id)) return;
    if (!Projects.listProjects().some((p) => p.id === id)) { app._prevProjectId = null; app._updateProjBackBtn(); return; }
    app._openProject(id); // sets _prevProjectId to the project we're leaving, so back toggles
  }

  // Recent-projects list inside the project dropdown (excludes the open one), so
  // any background project is one click away without opening the manager.
  renderRecentMenu() {
    const app = this.app;
    const host = app.root.querySelector('#proj-recent');
    const sep = app.root.querySelector('#proj-recent-sep');
    const lab = app.root.querySelector('#proj-recent-lab');
    if (!host) return;
    const curId = app.project && app.project.id;
    const list = Projects.listProjects()
      .filter((p) => p.id !== curId)
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 6);
    if (sep) sep.hidden = !list.length;
    if (lab) lab.hidden = !list.length;
    host.innerHTML = list
      .map((p) => `<button data-switch="${p.id}">${String(p.name).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</button>`)
      .join('');
  }

  // Count visible (engaged) seconds for the current project; flush periodically.
  setupWorkTimer() {
    const app = this.app;
    let ticks = 0;
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !app.project) return;
      app._workSeconds += 5;
      if (++ticks % 6 === 0) Projects.touchSeconds(app.project.id, app._workSeconds); // flush ~every 30s
    }, 5000);
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && app.project) Projects.touchSeconds(app.project.id, app._workSeconds);
    });
  }

  // On boot: restore the last project, else adopt the most recent, else create
  // the first one from the current starter design.
  initProjects() {
    const app = this.app;
    app._setupWorkTimer();
    const cur = Projects.getCurrentId();
    const list = Projects.listProjects();
    const meta = (cur && list.find((p) => p.id === cur)) || list.sort((a, b) => b.modified - a.modified)[0];
    if (meta) app._openProject(meta.id);
    else app._doSaveAs('Untitled'); // first run — save the starter as project #1
  }

  fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
  }

  fmtWork(sec) {
    if (!sec || sec < 60) return '< 1 min';
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m} min`;
  }

  fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', '
      + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  renderProjectList() {
    const app = this.app;
    const host = app.root.querySelector('#proj-list');
    if (!host) return;
    const list = Projects.listProjects().sort((a, b) => b.modified - a.modified);
    if (!list.length) { host.innerHTML = '<p class="muted">No saved projects yet.</p>'; return; }
    host.innerHTML = list.map((p) => `
      <div class="proj-row${app.project && p.id === app.project.id ? ' current' : ''}" data-pid="${p.id}">
        <div class="proj-main" data-open="${p.id}">
          <div class="proj-name">${String(p.name).replace(/</g, '&lt;')}${app.project && p.id === app.project.id ? ' ·<span class="proj-cur"> open</span>' : ''}</div>
          <div class="proj-meta">${app._fmtSize(p.size || 0)} · ${app._fmtWork(p.seconds)} worked · created ${app._fmtDate(p.created)} · edited ${app._fmtDate(p.modified)}</div>
        </div>
        <div class="proj-acts">
          <button data-open="${p.id}" title="Open">Open</button>
          <button data-rename="${p.id}" title="Rename">✎</button>
          <button data-del="${p.id}" title="Delete" class="proj-del">✕</button>
        </div>
      </div>`).join('');
  }
}
