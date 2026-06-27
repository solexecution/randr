// Human-readable part / group labels for the build roster and editor.
export const KIND_LABEL = {
  roundedBox: 'rounded',
  roundedCylinder: 'r-cyl',
  chamferedBox: 'cham-box',
  chamferedCylinder: 'cham-cyl',
  thread: 'rod',
  insertHole: 'insert',
  counterbore: "c'bore",
  countersink: "c'sink",
  nutTrap: 'nut trap',
};

export const GROUP_MODE_SHORT = { union: '∪', subtract: '∖', intersect: '∩', hull: '⬭' };

export function partKindLabel(node) {
  if (!node) return 'part';
  if (node.kind === 'imported') return node.meshName || 'mesh';
  if (node.kind === 'extrusion') return 'sketch';
  if (node.kind === 'revolution') return 'lathe';
  return KIND_LABEL[node.kind] || node.kind;
}

/** Primary label — custom name when set, otherwise the kind. */
export function partDisplayName(node) {
  const custom = (node?.name || '').trim();
  return custom || partKindLabel(node);
}

/** Roster line: "Stand body · sketch" when named, else just the kind. */
export function partListLabel(node) {
  const kind = partKindLabel(node);
  const custom = (node?.name || '').trim();
  if (custom && custom.toLowerCase() !== kind.toLowerCase()) return `${custom} · ${kind}`;
  return kind;
}

export function groupBadgeText(node, memberCount) {
  const label = (node.groupLabel || '').trim();
  const mode = GROUP_MODE_SHORT[node.groupMode] || '∪';
  const base = label || `G${node.group}`;
  return memberCount > 1 ? `${base} ${mode}` : `${base} ${mode}`;
}

export function groupBadgeTitle(node, memberCount) {
  const label = (node.groupLabel || '').trim() || `Group ${node.group}`;
  const mode = node.groupMode || 'union';
  return `${label} (${memberCount} part${memberCount === 1 ? '' : 's'}) · combine: ${mode}`;
}
