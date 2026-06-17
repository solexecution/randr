// Local project store (localStorage). A lightweight index of metadata plus one
// blob per project holding the full serialized design. The index is what the
// Projects manager lists; the blob is loaded only when a project is opened.

const INDEX_KEY = 'randr.index';
const CURRENT_KEY = 'randr.current';
const dataKey = (id) => `randr.project.${id}`;

export function newId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function listProjects() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]'); } catch { return []; }
}

function writeIndex(list) {
  try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch { /* quota — ignore */ }
}

export function loadProject(id) {
  try { return JSON.parse(localStorage.getItem(dataKey(id))); } catch { return null; }
}

// meta: {id,name,created,modified,seconds}; data: the design object. Writes the
// blob and updates the index entry with the computed size. Returns the entry,
// or null if storage rejected it (e.g. quota exceeded).
export function saveProject(meta, data) {
  const json = JSON.stringify(data);
  try { localStorage.setItem(dataKey(meta.id), json); } catch { return null; }
  const entry = {
    id: meta.id, name: meta.name, created: meta.created,
    modified: meta.modified, seconds: meta.seconds || 0, size: json.length,
  };
  const list = listProjects();
  const i = list.findIndex((p) => p.id === meta.id);
  if (i >= 0) list[i] = entry; else list.push(entry);
  writeIndex(list);
  return entry;
}

export function deleteProject(id) {
  localStorage.removeItem(dataKey(id));
  writeIndex(listProjects().filter((p) => p.id !== id));
}

export function renameProject(id, name, modified) {
  const list = listProjects();
  const e = list.find((p) => p.id === id);
  if (e) { e.name = name; if (modified) e.modified = modified; writeIndex(list); }
}

// Cheap update of just the accumulated work seconds (no blob rewrite).
export function touchSeconds(id, seconds) {
  const list = listProjects();
  const e = list.find((p) => p.id === id);
  if (e) { e.seconds = seconds; writeIndex(list); }
}

export function getCurrentId() { return localStorage.getItem(CURRENT_KEY); }
export function setCurrentId(id) {
  if (id) localStorage.setItem(CURRENT_KEY, id);
  else localStorage.removeItem(CURRENT_KEY);
}
