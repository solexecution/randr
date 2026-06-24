import { describe, it, expect } from 'vitest';
import { migrateToolbar, TOOLBAR_VERSION } from '../../src/ui/toolbar.js';

// migrateToolbar is the most fragile piece of the toolbar subsystem and the one
// most likely to break when the default layout changes — every version bump adds
// a step. It's a pure function (no DOM), so we exercise the upgrade paths here;
// the e2e suite covers the rendered result of a happy-path load.

const has = (layout, id) =>
  layout.some((e) => (e.type === 'group' ? (e.items || []).includes(id) : e.id === id));

describe('migrateToolbar', () => {
  it('returns the default layout for null / garbage input', () => {
    for (const bad of [null, undefined, {}, { layout: 'nope' }, { layout: [] }, 42]) {
      const tb = migrateToolbar(bad);
      expect(tb.version).toBe(TOOLBAR_VERSION);
      expect(tb.dock).toBe('left');
      expect(Array.isArray(tb.layout)).toBe(true);
      expect(has(tb.layout, 'rail-home')).toBe(true);     // a stock tool is present
      expect(has(tb.layout, 'v-quality')).toBe(true);
    }
  });

  it('upgrades a pre-versioned (v1) blob by surfacing every tool added since', () => {
    const saved = { dock: 'left', x: 80, y: 110, layout: [{ type: 'tool', id: 'rail-home' }] };
    const tb = migrateToolbar(saved); // no version field → treated as v1
    expect(has(tb.layout, 'v-quality')).toBe(true);     // v3 step
    expect(tb.version).toBe(TOOLBAR_VERSION);
  });

  it('upgrades a v2 blob by surfacing the v3 tool, preserving placement', () => {
    const saved = { version: 2, dock: 'right', x: 5, y: 5, layout: [{ type: 'tool', id: 'rail-home' }] };
    const tb = migrateToolbar(saved);
    expect(has(tb.layout, 'v-quality')).toBe(true);
    expect(tb.dock).toBe('right');                       // saved placement preserved
  });

  it('prunes the removed mode/view/panel toggles from an older saved layout', () => {
    // v4 dropped view-mode-toggle + mode-toggle; v5 dropped panel-toggle (all now on
    // the top-bar control). A blob that still lists them must come back without them.
    const saved = { version: 3, layout: [
      { type: 'tool', id: 'rail-home' },
      { type: 'tool', id: 'view-mode-toggle' },
      { type: 'tool', id: 'panel-toggle' },
      { type: 'group', gid: 'g', label: 'More', glyph: '⋯', items: ['v-cut', 'mode-toggle'] },
    ] };
    const tb = migrateToolbar(saved);
    expect(has(tb.layout, 'view-mode-toggle')).toBe(false);
    expect(has(tb.layout, 'mode-toggle')).toBe(false);
    expect(has(tb.layout, 'panel-toggle')).toBe(false);
    expect(has(tb.layout, 'rail-home')).toBe(true);      // real tools survive
    expect(has(tb.layout, 'v-cut')).toBe(true);
  });

  it('prunes entries (top-level and in groups) for tools that no longer exist', () => {
    const saved = { version: TOOLBAR_VERSION, layout: [
      { type: 'tool', id: 'rail-home' },
      { type: 'tool', id: 'ghost-tool' },                               // unknown top-level
      { type: 'group', gid: 'g', label: 'X', glyph: '⋯', items: ['v-grid', 'also-gone'] },
    ] };
    const tb = migrateToolbar(saved);
    expect(has(tb.layout, 'ghost-tool')).toBe(false);
    const group = tb.layout.find((e) => e.type === 'group');
    expect(group.items).toEqual(['v-grid']);            // unknown id dropped, real one kept
  });

  it('keeps a deliberately-removed tool removed on a current-version blob', () => {
    // user turned v-theme off and saved at the current version → no version step
    // re-runs, so it must stay off
    const layout = [
      { type: 'tool', id: 'rail-home' },
      { type: 'tool', id: 'v-grid' },
      { type: 'tool', id: 'v-quality' },
      { type: 'tool', id: 'v-snap' },
    ];
    const tb = migrateToolbar({ version: TOOLBAR_VERSION, layout });
    expect(has(tb.layout, 'v-theme')).toBe(false);
  });
});
