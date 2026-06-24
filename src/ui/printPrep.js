// Print-prep source wrapping: orientation (rotate), scale-to-fit (scale), and
// cut-in-half (bisect), wrapped around a model's source in that order. One
// definition so _effectiveSource (all three) and _scaleToFit (rotation only,
// while it measures a replacement scale) can't drift apart. No-op at defaults
// or on empty source.
export function wrapPrintPrep(source, { rot, scale, cut } = {}) {
  if (!source || !source.trim()) return source;
  if (rot && (rot[0] || rot[1] || rot[2])) source = `rotate([${rot[0]}, ${rot[1]}, ${rot[2]}]) {\n${source}\n}`;
  if (scale && scale !== 1) source = `scale([${scale}, ${scale}, ${scale}]) {\n${source}\n}`;
  if (cut && cut > 0) source = `bisect(${cut}) {\n${source}\n}`;
  return source;
}
