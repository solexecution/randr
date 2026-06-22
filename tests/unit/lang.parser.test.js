import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/lang/tokenizer.js';
import { parse } from '../../src/lang/parser.js';

// All parser tests go through the real tokenizer, so these double as
// end-to-end front-end checks.
const ast = (src) => parse(tokenize(src));
// Most snippets are a single statement; this pulls it out.
const firstStmt = (src) => ast(src).body[0];

describe('parser — program & statements', () => {
  it('produces a Program with a body array', () => {
    const tree = ast('');
    expect(tree.type).toBe('Program');
    expect(tree.body).toEqual([]);
  });

  it('parses a param declaration', () => {
    const stmt = firstStmt('param size = 10;');
    expect(stmt.type).toBe('Param');
    expect(stmt.name).toBe('size');
    expect(stmt.value).toMatchObject({ type: 'Number', value: 10, unit: null });
  });

  it('parses an assignment', () => {
    const stmt = firstStmt('x = 5;');
    expect(stmt.type).toBe('Assign');
    expect(stmt.name).toBe('x');
    expect(stmt.value).toMatchObject({ type: 'Number', value: 5 });
  });

  it('parses an expression statement', () => {
    const stmt = firstStmt('cube(1);');
    expect(stmt.type).toBe('ExprStmt');
    expect(stmt.expr.type).toBe('Call');
  });

  it('parses several statements into one program body', () => {
    const tree = ast('param a = 1; b = 2; cube(3);');
    expect(tree.body.map((s) => s.type)).toEqual(['Param', 'Assign', 'ExprStmt']);
  });
});

describe('parser — leaf nodes', () => {
  it('Number leaf carries value and unit (spread from the token)', () => {
    const stmt = firstStmt('10mm;');
    expect(stmt.expr).toEqual({ type: 'Number', value: 10, unit: 'mm' });
  });

  it('Str leaf carries the string value', () => {
    const stmt = firstStmt('"hi";');
    expect(stmt.expr).toEqual({ type: 'Str', value: 'hi' });
  });

  it('Ident leaf carries the name', () => {
    const stmt = firstStmt('foo;');
    expect(stmt.expr).toEqual({ type: 'Ident', name: 'foo' });
  });

  it('List literal collects its items', () => {
    const stmt = firstStmt('[1, 2, 3];');
    expect(stmt.expr.type).toBe('List');
    expect(stmt.expr.items).toHaveLength(3);
    expect(stmt.expr.items.map((n) => n.value)).toEqual([1, 2, 3]);
  });

  it('parses an empty list', () => {
    const stmt = firstStmt('[];');
    expect(stmt.expr).toEqual({ type: 'List', items: [] });
  });
});

describe('parser — calls', () => {
  it('parses positional args', () => {
    const call = firstStmt('cube(10, 20);').expr;
    expect(call.type).toBe('Call');
    expect(call.name).toBe('cube');
    expect(call.args).toHaveLength(2);
    expect(call.args.map((a) => a.value)).toEqual([10, 20]);
    expect(call.named).toEqual({});
    expect(call.children).toBeNull();
  });

  it('parses named args into the named map', () => {
    const call = firstStmt('cylinder(r = 5, h = 10);').expr;
    expect(call.args).toEqual([]);
    expect(Object.keys(call.named)).toEqual(['r', 'h']);
    expect(call.named.r).toMatchObject({ type: 'Number', value: 5 });
    expect(call.named.h).toMatchObject({ type: 'Number', value: 10 });
  });

  it('parses mixed positional and named args', () => {
    const call = firstStmt('shape(1, 2, center = true);').expr;
    expect(call.args.map((a) => a.value)).toEqual([1, 2]);
    expect(call.named.center).toMatchObject({ type: 'Ident', name: 'true' });
  });

  it('parses a trailing { ... } children block', () => {
    const call = firstStmt('union() { cube(1); sphere(2); }').expr;
    expect(call.name).toBe('union');
    expect(call.children).not.toBeNull();
    expect(call.children.type).toBe('Block');
    expect(call.children.body).toHaveLength(2);
    expect(call.children.body.every((s) => s.type === 'ExprStmt')).toBe(true);
  });

  it('parses a brace-less single child (OpenSCAD style)', () => {
    const call = firstStmt('translate([1, 2, 3]) cube(10);').expr;
    expect(call.name).toBe('translate');
    expect(call.children.type).toBe('Block');
    expect(call.children.body).toHaveLength(1);
    const child = call.children.body[0];
    expect(child.type).toBe('ExprStmt');
    expect(child.expr.name).toBe('cube');
  });

  it('records start/end span offsets on a call', () => {
    const call = firstStmt('cube(1);').expr;
    expect(call.start).toBe(0);
    // span covers through the closing ')' at offset 7 (exclusive end).
    expect(call.end).toBe(7);
    expect(call.end).toBeGreaterThan(call.start);
  });
});

describe('parser — operator precedence & associativity', () => {
  it('binds * tighter than + (1 + 2 * 3)', () => {
    const e = firstStmt('1 + 2 * 3;').expr;
    expect(e.type).toBe('Binary');
    expect(e.op).toBe('+');
    expect(e.left).toMatchObject({ type: 'Number', value: 1 });
    expect(e.right.type).toBe('Binary');
    expect(e.right.op).toBe('*');
    expect(e.right.left.value).toBe(2);
    expect(e.right.right.value).toBe(3);
  });

  it('keeps left side grouped when * precedes + (2 * 3 + 1)', () => {
    const e = firstStmt('2 * 3 + 1;').expr;
    expect(e.op).toBe('+');
    expect(e.left.type).toBe('Binary');
    expect(e.left.op).toBe('*');
    expect(e.right.value).toBe(1);
  });

  it('parenthesized groups override precedence ((1 + 2) * 3)', () => {
    const e = firstStmt('(1 + 2) * 3;').expr;
    expect(e.op).toBe('*');
    expect(e.left.type).toBe('Binary');
    expect(e.left.op).toBe('+');
    expect(e.right.value).toBe(3);
  });

  it('term operators are left-associative (1 - 2 - 3)', () => {
    const e = firstStmt('1 - 2 - 3;').expr;
    expect(e.op).toBe('-');
    expect(e.left.type).toBe('Binary');
    expect(e.left.op).toBe('-');
    expect(e.left.left.value).toBe(1);
    expect(e.left.right.value).toBe(2);
    expect(e.right.value).toBe(3);
  });

  it('equality sits below comparison (1 < 2 == 3 > 4)', () => {
    const e = firstStmt('1 < 2 == 3 > 4;').expr;
    expect(e.type).toBe('Binary');
    expect(e.op).toBe('==');
    expect(e.left.op).toBe('<');
    expect(e.right.op).toBe('>');
  });
});

describe('parser — unary & member access', () => {
  it('parses a unary minus', () => {
    const e = firstStmt('-5;').expr;
    expect(e.type).toBe('Unary');
    expect(e.op).toBe('-');
    expect(e.operand).toMatchObject({ type: 'Number', value: 5 });
  });

  it('parses a unary minus inside a larger expression (1 + -2)', () => {
    // The parser grammar lists '!' as a unary op, but the tokenizer never emits
    // a bare '!' punct token (it is not in SINGLE), so unary-not is unreachable
    // through the real front-end — only '-' unary is exercisable here.
    const e = firstStmt('1 + -2;').expr;
    expect(e.op).toBe('+');
    expect(e.left).toMatchObject({ type: 'Number', value: 1 });
    expect(e.right).toMatchObject({ type: 'Unary', op: '-' });
    expect(e.right.operand).toMatchObject({ type: 'Number', value: 2 });
  });

  it('parses nested unary operators', () => {
    const e = firstStmt('--3;').expr;
    expect(e.type).toBe('Unary');
    expect(e.operand.type).toBe('Unary');
    expect(e.operand.operand).toMatchObject({ type: 'Number', value: 3 });
  });

  it('parses member access', () => {
    const e = firstStmt('obj.prop;').expr;
    expect(e).toEqual({
      type: 'Member',
      object: { type: 'Ident', name: 'obj' },
      property: 'prop',
    });
  });

  it('parses chained member access (left-nested)', () => {
    const e = firstStmt('a.b.c;').expr;
    expect(e.type).toBe('Member');
    expect(e.property).toBe('c');
    expect(e.object.type).toBe('Member');
    expect(e.object.property).toBe('b');
    expect(e.object.object).toEqual({ type: 'Ident', name: 'a' });
  });
});

describe('parser — errors', () => {
  it('throws on a missing closing paren', () => {
    expect(() => ast('cube(1;')).toThrow();
  });

  it('throws on an unexpected token where a primary is expected', () => {
    expect(() => ast('1 + ;')).toThrow();
  });

  it('throws when a param declaration is missing its value', () => {
    expect(() => ast('param x = ;')).toThrow();
  });

  it('throws on an unclosed list', () => {
    expect(() => ast('[1, 2')).toThrow();
  });
});
