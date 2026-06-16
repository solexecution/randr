// Tokenizer for the Forge mini-language.
// The language is small on purpose: numbers with units, identifiers, the
// arithmetic operators, calls, blocks, and a handful of punctuation. Keeping
// the grammar tight is what lets the evaluator stay trustworthy.

const TWO_CHAR = ['<=', '>=', '==', '!=', '&&', '||'];
const SINGLE = '(){}[],;=+-*/%<>.:';

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type, value) => tokens.push({ type, value, line, col });
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  };

  while (i < src.length) {
    const c = src[i];

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }

    // Line comments
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance();
      continue;
    }
    // Block comments
    if (c === '/' && src[i + 1] === '*') {
      advance(2);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) advance();
      advance(2);
      continue;
    }

    // Numbers (with optional decimal and optional 'mm'/'deg' unit suffix)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      let num = '';
      while (i < src.length && /[0-9.]/.test(src[i])) { num += src[i]; advance(); }
      // optional scientific-notation exponent: e / E, optional sign, digits
      if ((src[i] === 'e' || src[i] === 'E') && /[0-9+-]/.test(src[i + 1] || '')) {
        num += src[i]; advance();
        if (src[i] === '+' || src[i] === '-') { num += src[i]; advance(); }
        while (i < src.length && /[0-9]/.test(src[i])) { num += src[i]; advance(); }
      }
      let unit = null;
      const rest = src.slice(i);
      const m = rest.match(/^(mm|cm|deg|rad)/);
      if (m) { unit = m[1]; advance(m[1].length); }
      push('number', { value: parseFloat(num), unit });
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_]/.test(c)) {
      let id = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { id += src[i]; advance(); }
      push('ident', id);
      continue;
    }

    // Two-char operators
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) { push('op', two); advance(2); continue; }

    // Single-char punctuation/operators
    if (SINGLE.includes(c)) { push('punct', c); advance(); continue; }

    throw new ForgeError(`Unexpected character '${c}'`, line, col);
  }

  push('eof', null);
  return tokens;
}

export class ForgeError extends Error {
  constructor(message, line, col) {
    super(line != null ? `Line ${line}:${col} — ${message}` : message);
    this.name = 'ForgeError';
    this.line = line;
    this.col = col;
  }
}
