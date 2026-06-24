// Code-editor syntax highlighting + a tiny markdown renderer for the help modal.
// Pure string transforms, kept out of app.js.

// Tokenise the mini-language for a colour layer behind the textarea. Keeps
// comments + whitespace (the real tokenizer drops them), so it can't reuse it.
import { hlEscape } from './escape.js';
import { PRIMITIVE_FNS } from './primitives.js';

const HL_KEYWORDS = new Set(['param', 'true', 'false', 'PI']);
const HL_FUNCS = new Set([
  ...PRIMITIVE_FNS, 'cube', 'extrude', 'revolve', // primitive call names from the registry (+ aliases)
  'translate', 'rotate', 'scale', 'mirror', 'fillet', 'chamfer', 'bisect',
  'union', 'difference', 'intersection', 'hull',
  'sin', 'cos', 'tan', 'sqrt', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'pow',
]);

export function highlightCode(src) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|((?:\d[\d.]*(?:[eE][+-]?\d+)?(?:mm|cm|deg|rad)?)|\.\d+)|([A-Za-z_]\w*)|([+\-*/%=<>!]+)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += hlEscape(src.slice(last, m.index));
    const t = m[0];
    let cls = '';
    if (m[1]) cls = 'c';            // comment
    else if (m[2]) cls = 's';       // string
    else if (m[3]) cls = 'n';       // number
    else if (m[4]) cls = HL_KEYWORDS.has(t) ? 'k' : (HL_FUNCS.has(t) ? 'f' : ''); // keyword / function
    else if (m[5]) cls = 'o';       // operator
    out += cls ? `<span class="hl-${cls}">${hlEscape(t)}</span>` : hlEscape(t);
    last = m.index + t.length;
  }
  out += hlEscape(src.slice(last));
  return out;
}

// Tiny markdown -> HTML for the help modal (headings, lists, bold, `code`, hr).
export function mdToHtml(md) {
  const inline = (s) => hlEscape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  let html = '', list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, ''), t = line.trim();
    let m;
    if (/^---+$/.test(t)) { close(); html += '<hr>'; }
    else if ((m = t.match(/^(#{1,6})\s+(.*)/))) { close(); const l = m[1].length; html += `<h${l}>${inline(m[2])}</h${l}>`; }
    else if ((m = line.match(/^(\s*)\d+\.\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[2])}</li>`; }
    else if ((m = line.match(/^(\s*)[-*]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[2])}</li>`; }
    else if (t === '') { close(); }
    else { close(); html += `<p>${inline(t)}</p>`; }
  }
  close();
  return html;
}
