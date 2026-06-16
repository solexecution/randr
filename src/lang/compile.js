// Top-level compile step the UI calls. Source string in, solid + params out,
// with errors caught and returned (never thrown) so a typo in the editor never
// takes the whole app down.

import { tokenize, ForgeError } from './tokenizer.js';
import { parse } from './parser.js';
import { evaluate } from './evaluator.js';

export function compile(source, overrides = {}) {
  try {
    const tokens = tokenize(source);
    const ast = parse(tokens);
    const { result, params } = evaluate(ast, overrides);
    return { result, params, error: null };
  } catch (e) {
    const message = e instanceof ForgeError ? e.message : `${e.name}: ${e.message}`;
    return { result: null, params: [], error: message };
  }
}

export { ForgeError };
