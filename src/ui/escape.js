// One HTML-escaper for every module that builds markup as strings. It escapes
// the four characters that matter in both text content and double-quoted
// attributes, so the same function is safe in either context — no per-call-site
// variants to drift apart. `&` must be replaced first so the entities it adds
// aren't re-escaped.
export const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Variant for syntax-highlighted code / markdown rendering: it deliberately
// omits the `"` escape because its output only ever lands in element text
// content (never an attribute), so quotes are safe and left intact.
export const hlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
