// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  newId,
  listProjects,
  loadProject,
  saveProject,
  deleteProject,
  renameProject,
  touchSeconds,
  getCurrentId,
  setCurrentId,
} from '../../src/ui/projects.js';

// Persistence layer for the Projects manager. Backed by localStorage under the
// `randr.*` namespace: `randr.index` (metadata list), `randr.current` (open id),
// and one blob per project at `randr.project.<id>`. These tests assert against
// those exact keys so the on-disk format itself is covered, not just the API.
const INDEX_KEY = 'randr.index';
const CURRENT_KEY = 'randr.current';
const dataKey = (id) => `randr.project.${id}`;

const meta = (over = {}) => ({
  id: 'p1',
  name: 'Widget',
  created: 1000,
  modified: 2000,
  seconds: 42,
  ...over,
});

const design = (over = {}) => ({
  nodes: [{ op: 'box', size: [10, 20, 30] }],
  version: 1,
  ...over,
});

describe('ui/projects localStorage persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('newId', () => {
    it('returns a p-prefixed string and is unique across calls', () => {
      const a = newId();
      const b = newId();
      expect(typeof a).toBe('string');
      expect(a.startsWith('p')).toBe(true);
      expect(a).not.toBe(b);
    });
  });

  describe('saveProject', () => {
    it('writes the design blob under randr.project.<id>', () => {
      const data = design();
      saveProject(meta(), data);

      const raw = localStorage.getItem(dataKey('p1'));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw)).toEqual(data);
    });

    it('registers an index entry under randr.index with computed size', () => {
      const data = design();
      const json = JSON.stringify(data);
      const entry = saveProject(meta(), data);

      const index = JSON.parse(localStorage.getItem(INDEX_KEY));
      expect(Array.isArray(index)).toBe(true);
      expect(index).toHaveLength(1);
      expect(index[0]).toEqual({
        id: 'p1',
        name: 'Widget',
        created: 1000,
        modified: 2000,
        seconds: 42,
        size: json.length,
      });
      // returned entry mirrors what was indexed.
      expect(entry).toEqual(index[0]);
    });

    it('round-trips: saved data loads back as equivalent data', () => {
      const data = design({ nested: { a: [1, 2, 3], b: 'x' } });
      saveProject(meta(), data);

      expect(loadProject('p1')).toEqual(data);
    });

    it('defaults missing seconds to 0 in the index entry', () => {
      const m = meta();
      delete m.seconds;
      const entry = saveProject(m, design());

      expect(entry.seconds).toBe(0);
      expect(listProjects()[0].seconds).toBe(0);
    });

    it('updates the existing index entry in place on re-save (no duplicate)', () => {
      saveProject(meta(), design());
      saveProject(meta({ name: 'Widget v2', modified: 9999 }), design({ version: 2 }));

      const index = listProjects();
      expect(index).toHaveLength(1);
      expect(index[0].name).toBe('Widget v2');
      expect(index[0].modified).toBe(9999);
      // blob reflects the latest write.
      expect(loadProject('p1')).toEqual(design({ version: 2 }));
    });

    it('tracks multiple distinct projects in the index', () => {
      saveProject(meta({ id: 'p1', name: 'A' }), design());
      saveProject(meta({ id: 'p2', name: 'B' }), design());

      const ids = listProjects().map((p) => p.id);
      expect(ids).toEqual(['p1', 'p2']);
      expect(localStorage.getItem(dataKey('p1'))).not.toBeNull();
      expect(localStorage.getItem(dataKey('p2'))).not.toBeNull();
    });
  });

  describe('listProjects', () => {
    it('returns an empty array when nothing has been saved', () => {
      expect(listProjects()).toEqual([]);
    });

    it('returns an empty array when the index is malformed JSON', () => {
      localStorage.setItem(INDEX_KEY, 'not-json{');
      expect(listProjects()).toEqual([]);
    });

    it('returns saved project metadata', () => {
      saveProject(meta(), design());
      const list = listProjects();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('p1');
      expect(list[0].name).toBe('Widget');
    });
  });

  describe('loadProject', () => {
    it('returns null for an unknown id (does not throw)', () => {
      expect(loadProject('does-not-exist')).toBeNull();
    });

    it('returns null when the stored blob is malformed JSON (does not throw)', () => {
      localStorage.setItem(dataKey('p1'), '{broken');
      expect(() => loadProject('p1')).not.toThrow();
      expect(loadProject('p1')).toBeNull();
    });
  });

  describe('current-project pointer', () => {
    it('returns null when no current id is set', () => {
      expect(getCurrentId()).toBeNull();
    });

    it('sets and reads the current id via randr.current', () => {
      setCurrentId('p1');
      expect(localStorage.getItem(CURRENT_KEY)).toBe('p1');
      expect(getCurrentId()).toBe('p1');
    });

    it('clears the current id when passed a falsy value', () => {
      setCurrentId('p1');
      setCurrentId(null);
      expect(localStorage.getItem(CURRENT_KEY)).toBeNull();
      expect(getCurrentId()).toBeNull();
    });
  });

  describe('deleteProject', () => {
    it('removes both the blob and the index record', () => {
      saveProject(meta(), design());
      expect(localStorage.getItem(dataKey('p1'))).not.toBeNull();
      expect(listProjects()).toHaveLength(1);

      deleteProject('p1');

      expect(localStorage.getItem(dataKey('p1'))).toBeNull();
      expect(listProjects()).toEqual([]);
      expect(loadProject('p1')).toBeNull();
    });

    it('only removes the targeted project, leaving others intact', () => {
      saveProject(meta({ id: 'p1', name: 'A' }), design());
      saveProject(meta({ id: 'p2', name: 'B' }), design());

      deleteProject('p1');

      const list = listProjects();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('p2');
      expect(localStorage.getItem(dataKey('p1'))).toBeNull();
      expect(localStorage.getItem(dataKey('p2'))).not.toBeNull();
    });

    it('is a no-op for an unknown id (does not throw)', () => {
      saveProject(meta(), design());
      expect(() => deleteProject('nope')).not.toThrow();
      expect(listProjects()).toHaveLength(1);
    });
  });

  describe('renameProject', () => {
    it('updates the name and modified time in the index without touching the blob', () => {
      saveProject(meta(), design());
      renameProject('p1', 'Renamed', 5555);

      const entry = listProjects()[0];
      expect(entry.name).toBe('Renamed');
      expect(entry.modified).toBe(5555);
      // blob is untouched by a rename.
      expect(loadProject('p1')).toEqual(design());
    });

    it('leaves modified unchanged when no modified time is supplied', () => {
      saveProject(meta(), design());
      renameProject('p1', 'Renamed');

      const entry = listProjects()[0];
      expect(entry.name).toBe('Renamed');
      expect(entry.modified).toBe(2000);
    });

    it('is a no-op for an unknown id', () => {
      saveProject(meta(), design());
      renameProject('ghost', 'X', 1);
      expect(listProjects()[0].name).toBe('Widget');
    });
  });

  describe('touchSeconds', () => {
    it('updates only the accumulated seconds in the index', () => {
      saveProject(meta({ seconds: 10 }), design());
      touchSeconds('p1', 999);

      const entry = listProjects()[0];
      expect(entry.seconds).toBe(999);
      // other fields are unaffected.
      expect(entry.name).toBe('Widget');
      expect(entry.modified).toBe(2000);
    });

    it('is a no-op for an unknown id', () => {
      saveProject(meta({ seconds: 10 }), design());
      touchSeconds('ghost', 999);
      expect(listProjects()[0].seconds).toBe(10);
    });
  });
});
