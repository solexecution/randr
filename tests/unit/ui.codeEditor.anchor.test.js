import { describe, it, expect } from 'vitest';
import {
  clampEditorPaneH,
  clampParamsH,
  paramsHForEditorPane,
  loadEditorAnchor,
  MIN_EDITOR_H,
  MIN_PARAMS_H,
} from '../../src/ui/codeEditor.js';

describe('params editor anchor', () => {
  const ws = { getBoundingClientRect: () => ({ height: 600 }) };

  it('clamps editor height when the workspace is shorter than the saved anchor', () => {
    expect(clampEditorPaneH(ws, 946, 12)).toBe(600 - 12 - MIN_PARAMS_H);
  });

  it('derives params height from a clamped editor anchor', () => {
    const ed = clampEditorPaneH(ws, 946, 12);
    expect(paramsHForEditorPane(ws, ed, 12)).toBe(MIN_PARAMS_H);
    expect(ed + 12 + MIN_PARAMS_H).toBe(600);
  });

  it('loads a consistent saved editor+params pair', () => {
    const storage = {
      'randr.codeEditorPaneH': '318',
      'randr.paramsPaneH': '270',
    };
    const orig = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k) => storage[k] ?? null,
      setItem: () => {},
    };
    try {
      const ed = loadEditorAnchor(ws, 168, 12);
      expect(ed).toBe(318);
      expect(paramsHForEditorPane(ws, ed, 12)).toBe(270);
    } finally {
      globalThis.localStorage = orig;
    }
  });

  it('prefers saved params height when only params were persisted', () => {
    const storage = {
      'randr.codeEditorPaneH': null,
      'randr.paramsPaneH': '200',
    };
    const orig = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k) => storage[k] ?? null,
      setItem: () => {},
    };
    try {
      const ed = loadEditorAnchor(ws, 168, 12);
      expect(paramsHForEditorPane(ws, ed, 12)).toBe(200);
      expect(ed).toBeGreaterThanOrEqual(MIN_EDITOR_H);
    } finally {
      globalThis.localStorage = orig;
    }
  });

  it('keeps params within workspace bounds', () => {
    expect(clampParamsH(ws, 999)).toBe(600 - MIN_EDITOR_H);
    expect(clampParamsH(ws, 10)).toBe(MIN_PARAMS_H);
  });
});
