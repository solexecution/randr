import { describe, it, expect } from 'vitest';
import { FEATURE_SECTIONS, featuresHelpHTML } from '../../src/ui/featuresHelp.js';

describe('featuresHelp', () => {
  it('lists every section with icon, key, and description', () => {
    expect(FEATURE_SECTIONS.length).toBeGreaterThan(5);
    for (const sec of FEATURE_SECTIONS) {
      expect(sec.title).toBeTruthy();
      expect(sec.items.length).toBeGreaterThan(0);
      for (const row of sec.items) {
        expect(row.icon).toBeTruthy();
        expect(row.key).toBeDefined();
        expect(row.desc.length).toBeGreaterThan(10);
      }
    }
  });

  it('renders an HTML table per section', () => {
    const html = featuresHelpHTML();
    expect(html).toContain('feat-table');
    expect(html).toContain('Workspace');
    expect(html).toContain('Ctrl+K');
    expect(html).not.toContain('<script');
  });
});