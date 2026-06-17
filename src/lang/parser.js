// Recursive-descent parser. Produces an AST the evaluator walks.
//
// Grammar (informal):
//   program    := statement*
//   statement  := assignment | exprStmt
//   assignment := 'param'? ident '=' expr ';'
//   exprStmt   := expr ';'
//   expr       := equality
//   equality   := comparison (('==' | '!=') comparison)*
//   comparison := term (('<' | '>' | '<=' | '>=') term)*
//   term       := factor (('+' | '-') factor)*
//   factor     := unary (('*' | '/' | '%') unary)*
//   unary      := ('-' | '!') unary | postfix
//   postfix    := primary ('.' ident)*
//   primary    := number | ident | call | '(' expr ')' | '[' list ']' | block
//   call       := ident '(' args ')' block?
//   block      := '{' statement* '}'
//
// A call may take a trailing block (the children), which is how transforms and
// Booleans wrap the shapes they act on — same shape as OpenSCAD.

import { ForgeError } from './tokenizer.js';

export function parse(tokens) {
  let pos = 0;

  const peek = (k = 0) => tokens[pos + k];
  const next = () => tokens[pos++];
  const at = (type, value) => {
    const t = peek();
    if (t.type !== type) return false;
    if (value != null && t.value !== value) return false;
    return true;
  };
  const eat = (type, value) => {
    if (!at(type, value)) {
      const t = peek();
      throw new ForgeError(
        `Expected ${value ?? type} but found ${t.value ?? t.type}`, t.line, t.col);
    }
    return next();
  };

  function program() {
    const body = [];
    while (!at('eof')) body.push(statement());
    return { type: 'Program', body };
  }

  function statement() {
    // param declaration
    if (at('ident', 'param')) {
      next();
      const name = eat('ident').value;
      eat('punct', '=');
      const value = expr();
      eat('punct', ';');
      return { type: 'Param', name, value };
    }
    // assignment:  ident = expr ;
    if (at('ident') && peek(1).type === 'punct' && peek(1).value === '=') {
      const name = next().value;
      eat('punct', '=');
      const value = expr();
      eat('punct', ';');
      return { type: 'Assign', name, value };
    }
    // expression statement (usually a shape-producing call)
    const e = expr();
    if (at('punct', ';')) next();
    return { type: 'ExprStmt', expr: e };
  }

  function block() {
    eat('punct', '{');
    const body = [];
    while (!at('punct', '}')) body.push(statement());
    eat('punct', '}');
    return { type: 'Block', body };
  }

  function expr() { return equality(); }

  function binary(sub, ops) {
    let left = sub();
    while ((at('op') || at('punct')) && ops.includes(peek().value)) {
      const op = next().value;
      const right = sub();
      left = { type: 'Binary', op, left, right };
    }
    return left;
  }

  const equality = () => binary(comparison, ['==', '!=']);
  const comparison = () => binary(term, ['<', '>', '<=', '>=']);
  const term = () => binary(factor, ['+', '-']);
  const factor = () => binary(unary, ['*', '/', '%']);

  function unary() {
    if ((at('punct', '-') || at('punct', '!'))) {
      const op = next().value;
      return { type: 'Unary', op, operand: unary() };
    }
    return postfix();
  }

  function postfix() {
    let node = primary();
    while (at('punct', '.')) {
      next();
      const prop = eat('ident').value;
      node = { type: 'Member', object: node, property: prop };
    }
    return node;
  }

  function primary() {
    const t = peek();

    if (t.type === 'number') { next(); return { type: 'Number', ...t.value }; }

    if (t.type === 'string') { next(); return { type: 'Str', value: t.value }; }

    if (t.type === 'punct' && t.value === '(') {
      next();
      const e = expr();
      eat('punct', ')');
      return e;
    }

    if (t.type === 'punct' && t.value === '[') {
      next();
      const items = [];
      while (!at('punct', ']')) {
        items.push(expr());
        if (at('punct', ',')) next();
      }
      eat('punct', ']');
      return { type: 'List', items };
    }

    if (t.type === 'punct' && t.value === '{') return block();

    if (t.type === 'ident') {
      next();
      // call?
      if (at('punct', '(')) {
        const start = t.start; // span the whole call (incl. trailing block/child)
        next();
        const args = [];
        const named = {};
        while (!at('punct', ')')) {
          // named arg:  name = expr
          if (at('ident') && peek(1).type === 'punct' && peek(1).value === '=') {
            const key = next().value;
            next();
            named[key] = expr();
          } else {
            args.push(expr());
          }
          if (at('punct', ',')) next();
        }
        eat('punct', ')');
        // Children: either a { ... } block, or a single brace-less child
        // statement — OpenSCAD-style `translate([...]) cube(10);`. Without this,
        // a transform with no braces silently drops its child (so the shape
        // ends up untransformed). Only a following call can be a child; a ';'
        // ends the statement and means "no child".
        let children = null;
        if (at('punct', '{')) {
          children = block();
        } else if (at('ident') && peek(1).type === 'punct' && peek(1).value === '(') {
          children = { type: 'Block', body: [statement()] };
        }
        const end = tokens[pos - 1].end; // end of the last token we consumed
        return { type: 'Call', name: t.value, args, named, children, start, end };
      }
      return { type: 'Ident', name: t.value };
    }

    throw new ForgeError(`Unexpected ${t.value ?? t.type}`, t.line, t.col);
  }

  return program();
}
