import { describe, it, expect } from 'vitest';
import { extractSymbols } from './symbol_extractor.mjs';

describe('extractSymbols — kinds', () => {
  it('function declaration', () => {
    expect(extractSymbols('a.ts', 'function foo() {}')).toEqual([
      { name: 'foo', kind: 'function', exported: false, line: 1 },
    ]);
  });

  it('class declaration', () => {
    expect(extractSymbols('a.ts', 'class C {}')).toEqual([
      { name: 'C', kind: 'class', exported: false, line: 1 },
    ]);
  });

  it('interface declaration', () => {
    expect(extractSymbols('a.ts', 'interface I { x: number }')).toEqual([
      { name: 'I', kind: 'interface', exported: false, line: 1 },
    ]);
  });

  it('type-alias declaration', () => {
    expect(extractSymbols('a.ts', 'type T = string | number;')).toEqual([
      { name: 'T', kind: 'type', exported: false, line: 1 },
    ]);
  });

  it('enum declaration', () => {
    expect(extractSymbols('a.ts', 'enum E { A, B }')).toEqual([
      { name: 'E', kind: 'enum', exported: false, line: 1 },
    ]);
  });

  it('variable statement (const/let/var)', () => {
    expect(extractSymbols('a.ts', 'const x = 1;')).toEqual([
      { name: 'x', kind: 'variable', exported: false, line: 1 },
    ]);
    expect(extractSymbols('a.ts', 'let y = 2;')[0]).toMatchObject({ name: 'y', kind: 'variable' });
    expect(extractSymbols('a.ts', 'var z = 3;')[0]).toMatchObject({ name: 'z', kind: 'variable' });
  });

  it('several declarators in one statement → one symbol per name', () => {
    expect(extractSymbols('a.ts', 'const a = 1, b = 2;')).toEqual([
      { name: 'a', kind: 'variable', exported: false, line: 1 },
      { name: 'b', kind: 'variable', exported: false, line: 1 },
    ]);
  });

  it('destructuring binds each leaf name', () => {
    const out = extractSymbols('a.ts', 'export const { a, b } = obj; const [c, , d] = arr;');
    expect(out).toEqual([
      { name: 'a', kind: 'variable', exported: true, line: 1 },
      { name: 'b', kind: 'variable', exported: true, line: 1 },
      { name: 'c', kind: 'variable', exported: false, line: 1 },
      { name: 'd', kind: 'variable', exported: false, line: 1 },
    ]);
  });
});

describe('extractSymbols — exported vs not', () => {
  it('export modifier marks a declaration exported', () => {
    expect(extractSymbols('a.ts', 'export function f() {}')[0].exported).toBe(true);
    expect(extractSymbols('a.ts', 'export interface I {}')[0].exported).toBe(true);
    expect(extractSymbols('a.ts', 'export type T = number;')[0].exported).toBe(true);
    expect(extractSymbols('a.ts', 'export enum E { A }')[0].exported).toBe(true);
    expect(extractSymbols('a.ts', 'export const c = 1;')[0].exported).toBe(true);
  });

  it('plain declarations are not exported', () => {
    expect(extractSymbols('a.ts', 'function f() {}')[0].exported).toBe(false);
    expect(extractSymbols('a.ts', 'const c = 1;')[0].exported).toBe(false);
  });

  it('names listed in a local `export { … }` are exported (with alias)', () => {
    const out = extractSymbols('a.ts', 'const a = 1;\nfunction b() {}\nexport { a, b as bee };');
    expect(out.find((s) => s.name === 'a').exported).toBe(true);
    expect(out.find((s) => s.name === 'b').exported).toBe(true);
  });

  it('re-export from another module does NOT mark a local same-name symbol', () => {
    const out = extractSymbols('a.ts', "const foo = 1;\nexport { foo } from './other';");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'foo', exported: false });
  });
});

describe('extractSymbols — default exports', () => {
  it('export default named function', () => {
    expect(extractSymbols('a.ts', 'export default function foo() {}')).toEqual([
      { name: 'foo', kind: 'function', exported: true, line: 1 },
    ]);
  });

  it('export default named class', () => {
    expect(extractSymbols('a.ts', 'export default class Bar {}')).toEqual([
      { name: 'Bar', kind: 'class', exported: true, line: 1 },
    ]);
  });

  it('anonymous default function → name "default"', () => {
    expect(extractSymbols('a.ts', 'export default function () {}')).toEqual([
      { name: 'default', kind: 'function', exported: true, line: 1 },
    ]);
  });

  it('anonymous default class → name "default"', () => {
    expect(extractSymbols('a.ts', 'export default class {}')).toEqual([
      { name: 'default', kind: 'class', exported: true, line: 1 },
    ]);
  });

  it('anonymous default expression → variable named "default"', () => {
    expect(extractSymbols('a.ts', 'export default 42;')).toEqual([
      { name: 'default', kind: 'variable', exported: true, line: 1 },
    ]);
  });

  it('`export default <name>` flips an existing declaration, no duplicate', () => {
    const out = extractSymbols('a.ts', 'function foo() {}\nexport default foo;');
    expect(out).toEqual([
      { name: 'foo', kind: 'function', exported: true, line: 1 },
    ]);
  });
});

describe('extractSymbols — top level only', () => {
  it('does not descend into function or class bodies', () => {
    const text = [
      'export function outer() {',
      '  function inner() {}',
      '  const local = 1;',
      '}',
      'class Wrapper {',
      '  method() { const deep = 2; }',
      '}',
    ].join('\n');
    expect(extractSymbols('a.ts', text).map((s) => s.name)).toEqual(['outer', 'Wrapper']);
  });

  it('ignores namespace/module bodies (unsupported kind)', () => {
    const text = 'namespace NS { export const inside = 1; }\nexport const outside = 2;';
    expect(extractSymbols('a.ts', text).map((s) => s.name)).toEqual(['outside']);
  });
});

describe('extractSymbols — lines & collisions', () => {
  it('reports 1-based line numbers', () => {
    const text = '\n\nexport const onLine3 = 1;';
    expect(extractSymbols('a.ts', text)[0].line).toBe(3);
  });

  it('surfaces every declaration on a within-file name collision (overloads)', () => {
    const text = [
      'export function foo(a: number): void;',
      'export function foo(a: string): void;',
      'export function foo(a: any): void {}',
    ].join('\n');
    const out = extractSymbols('a.ts', text);
    expect(out).toEqual([
      { name: 'foo', kind: 'function', exported: true, line: 1 },
      { name: 'foo', kind: 'function', exported: true, line: 2 },
      { name: 'foo', kind: 'function', exported: true, line: 3 },
    ]);
  });
});
