import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractUsages } from './usage_extractor.mjs';
import { defaultCompilerOptions } from '../../lib/ts_resolve.mjs';

// Each test builds a tiny real on-disk TS project under a temp dir, then feeds
// the absolute file paths + an explicit symbol-id set to the extractor. Real
// files keep module resolution faithful and mirror how the run layer drives it.

let repo;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'cg-usg-')); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

function src(rel, text) {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function run(files, symbolIds) {
  return extractUsages({
    fileNames: files,
    options: defaultCompilerOptions(),
    symbolIds: new Set(symbolIds),
    repoRoot: repo,
  });
}

describe('extractUsages — enclosing-symbol attribution', () => {
  it('emits a symbol→symbol USES edge for a same-file call in a body', () => {
    const f = src('f.ts', 'export function b() {}\nexport function a() { return b(); }\n');
    const uses = run([f], ['sym:f.ts#a', 'sym:f.ts#b']);
    expect(uses).toEqual([{ fromSymId: 'sym:f.ts#a', toSymId: 'sym:f.ts#b' }]);
  });

  it('attributes a reference nested deep in a closure to the top-level symbol', () => {
    const f = src(
      'f.ts',
      'export function b() {}\n'
      + 'export function a() {\n'
      + '  const inner = () => b();\n'
      + '  return inner();\n'
      + '}\n',
    );
    const uses = run([f], ['sym:f.ts#a', 'sym:f.ts#b']);
    // inner is a nested (non-top-level) binding — the use of b belongs to a.
    expect(uses).toEqual([{ fromSymId: 'sym:f.ts#a', toSymId: 'sym:f.ts#b' }]);
  });

  it('never treats a NESTED declaration as the enclosing symbol', () => {
    // A nested `function x` shadows the top-level symbol `x`. A use of z inside
    // it must be attributed to the top-level enclosing symbol y, not to x.
    const f = src(
      'f.ts',
      'export function z() {}\n'
      + 'export function x() {}\n'
      + 'export function y() {\n'
      + '  function x() { return z(); }\n'
      + '  return x();\n'
      + '}\n',
    );
    const uses = run([f], ['sym:f.ts#x', 'sym:f.ts#y', 'sym:f.ts#z']);
    expect(uses).toContainEqual({ fromSymId: 'sym:f.ts#y', toSymId: 'sym:f.ts#z' });
    // The top-level x has an empty body, and the nested x is not an enclosing
    // symbol — so nothing is ever attributed FROM x.
    expect(uses.find((u) => u.fromSymId === 'sym:f.ts#x')).toBeUndefined();
  });

  it('attributes a variable-initializer body to that declarator', () => {
    const f = src(
      'f.ts',
      'export function b() {}\n'
      + 'export const a = () => b();\n',
    );
    const uses = run([f], ['sym:f.ts#a', 'sym:f.ts#b']);
    expect(uses).toEqual([{ fromSymId: 'sym:f.ts#a', toSymId: 'sym:f.ts#b' }]);
  });
});

describe('extractUsages — cross-file resolution', () => {
  it('resolves an imported use back to the original symbol, symbol→symbol', () => {
    const a = src('a.ts', 'export function foo() {}\n');
    const b = src('b.ts', "import { foo } from './a';\nexport const useFoo = () => foo();\n");
    const uses = run([a, b], ['sym:a.ts#foo', 'sym:b.ts#useFoo']);
    expect(uses).toEqual([{ fromSymId: 'sym:b.ts#useFoo', toSymId: 'sym:a.ts#foo' }]);
  });
});

describe('extractUsages — what is skipped', () => {
  it('skips references at module top level (no enclosing symbol)', () => {
    const f = src('f.ts', 'export function b() {}\nb();\n');
    const uses = run([f], ['sym:f.ts#b']);
    expect(uses).toEqual([]);
  });

  it('skips a self-use (recursion) — no self-edge', () => {
    const f = src('f.ts', 'export function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }\n');
    const uses = run([f], ['sym:f.ts#fact']);
    expect(uses).toEqual([]);
  });

  it('ignores a use whose resolved target is not a known symbol', () => {
    const a = src('a.ts', 'export const x = 1;\n');
    const b = src('b.ts', "import { x } from './a';\nexport function g() { return x + 1; }\n");
    // symbolIds intentionally omits sym:a.ts#x.
    const uses = run([a, b], ['sym:b.ts#g']);
    expect(uses).toEqual([]);
  });
});

describe('extractUsages — dedupe & determinism', () => {
  it('dedupes multiple uses of the same target into one edge', () => {
    const f = src('f.ts', 'export function b() {}\nexport function a() { return b() + b() + b(); }\n');
    const uses = run([f], ['sym:f.ts#a', 'sym:f.ts#b']);
    expect(uses).toEqual([{ fromSymId: 'sym:f.ts#a', toSymId: 'sym:f.ts#b' }]);
  });

  it('returns records sorted by (from, to)', () => {
    const f = src(
      'f.ts',
      'export function b() {}\n'
      + 'export function c() {}\n'
      + 'export function a() { return c() + b(); }\n',
    );
    const uses = run([f], ['sym:f.ts#a', 'sym:f.ts#b', 'sym:f.ts#c']);
    expect(uses).toEqual([
      { fromSymId: 'sym:f.ts#a', toSymId: 'sym:f.ts#b' },
      { fromSymId: 'sym:f.ts#a', toSymId: 'sym:f.ts#c' },
    ]);
  });
});
