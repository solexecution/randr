import { describe, it, expect } from 'vitest';
import {
  partDisplayName,
  partListLabel,
  partKindLabel,
  groupBadgeText,
} from '../../src/ui/partNames.js';

describe('partNames', () => {
  it('uses custom name when set', () => {
    const n = { kind: 'box', name: 'Stand body' };
    expect(partDisplayName(n)).toBe('Stand body');
    expect(partListLabel(n)).toBe('Stand body · box');
  });

  it('falls back to kind label', () => {
    const n = { kind: 'roundedBox', name: '' };
    expect(partDisplayName(n)).toBe('rounded');
    expect(partListLabel(n)).toBe('rounded');
  });

  it('labels extrusion as sketch', () => {
    expect(partKindLabel({ kind: 'extrusion' })).toBe('sketch');
  });

  it('shows group mode on badge', () => {
    const n = { group: 1, groupLabel: 'Body', groupMode: 'union' };
    expect(groupBadgeText(n, 3)).toBe('Body ∪');
  });
});
