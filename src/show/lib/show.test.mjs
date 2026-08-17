import { describe, it, expect } from 'vitest';
import { parseSymbolRef, buildShow, formatShow } from './show.mjs';

const A = `import { helper } from './b';

/**
 * Load one cart.
 * @param id the cart id
 */
export async function loadCart(id: string): Promise<Cart> {
  const raw = await helper(id);
  return raw;
}

export const CART_KEY = 'cart';

export interface Cart {
  items: number;
}
`;

const B = `export function helper(id: string): string {
  return id;
}

export function loadCart(): void {}

export function over(a: string): void;
export function over(a: number): void;
export function over(a: unknown): void {
  return;
}
`;

const FILES = { 'src/a.ts': A, 'src/b.ts': B };
const OPTS = { files: Object.keys(FILES), readFile: (p) => FILES[p] ?? null };

const show = (ref, extra = {}) => buildShow(ref, { ...OPTS, ...extra });
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('parseSymbolRef', () => {
  it('accepts a bare name', () => {
    expect(parseSymbolRef('loadCart')).toEqual({ path: null, name: 'loadCart' });
  });

  it('accepts path#name', () => {
    expect(parseSymbolRef('src/a.ts#loadCart')).toEqual({ path: 'src/a.ts', name: 'loadCart' });
  });

  it('accepts a full sym: id', () => {
    expect(parseSymbolRef('sym:src/a.ts#loadCart')).toEqual({ path: 'src/a.ts', name: 'loadCart' });
  });

  it('rejects an empty ref', () => {
    expect(parseSymbolRef('')).toBeNull();
    expect(parseSymbolRef('src/a.ts#')).toBeNull();
  });
});

describe('buildShow', () => {
  it('prints the declaration and its attached JSDoc, by path#name', () => {
    const r = show('src/a.ts#loadCart');
    expect(r.kind).toBe('symbol');
    expect(r.path).toBe('src/a.ts');
    expect(r.symbolKind).toBe('function');
    expect(r.startLine).toBe(lineOf(A, '/**'));
    expect(r.endLine).toBe(lineOf(A, 'return raw;') + 1);
    expect(r.declarationLine).toBe(lineOf(A, 'export async function loadCart'));
    expect(r.source).toContain('Load one cart.');
    expect(r.source.trimStart().startsWith('/**')).toBe(true);
    expect(r.source).toContain('export async function loadCart(id: string): Promise<Cart> {');
    expect(r.source).toContain('return raw;');
    // ...and nothing from the next declaration.
    expect(r.source).not.toContain('CART_KEY');
  });

  it('accepts a full sym: id', () => {
    expect(show('sym:src/a.ts#CART_KEY')).toMatchObject({ kind: 'symbol', name: 'CART_KEY' });
  });

  it('reports ambiguity across files instead of guessing', () => {
    const r = show('loadCart');
    expect(r.kind).toBe('ambiguous');
    expect(r.total).toBe(2);
    expect(r.candidates.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r.candidates[0].line).toBe(lineOf(A, 'export async function loadCart'));
    expect(formatShow(r)).toMatch(/ambiguous/i);
  });

  it('resolves a unique bare name', () => {
    const r = show('helper');
    expect(r).toMatchObject({ kind: 'symbol', path: 'src/b.ts', name: 'helper' });
  });

  it('merges adjacent overload signatures into one range', () => {
    const r = show('over');
    expect(r.kind).toBe('symbol');
    expect(r.startLine).toBe(lineOf(B, 'export function over(a: string)'));
    expect(r.source).toContain('export function over(a: unknown): void {');
    expect(r.source.split('\n')).toHaveLength(r.endLine - r.startLine + 1);
  });

  it('adds --context lines around the declaration', () => {
    const bare = show('src/a.ts#CART_KEY');
    const withContext = show('src/a.ts#CART_KEY', { context: 2 });
    expect(withContext.startLine).toBe(bare.startLine - 2);
    expect(withContext.endLine).toBe(bare.endLine + 2);
    expect(withContext.context).toBe(2);
    expect(withContext.source).toContain('CART_KEY');
    expect(withContext.source).toContain('interface Cart');
  });

  it('clamps context at the file edges', () => {
    const r = show('src/b.ts#helper', { context: 50 });
    expect(r.startLine).toBe(1);
    expect(r.endLine).toBe(B.split('\n').length);
  });

  it('reports a miss with near-miss suggestions', () => {
    const r = show('loadCarts');
    expect(r.kind).toBe('not-found');
    expect(r.candidates.map((c) => c.name)).toContain('loadCart');
    expect(formatShow(r)).toMatch(/no symbol/i);
  });

  it('narrows by path even when the name is ambiguous repo-wide', () => {
    expect(show('b.ts#loadCart')).toMatchObject({ kind: 'symbol', path: 'src/b.ts' });
  });

  it('does not throw on an unreadable file', () => {
    const r = buildShow('loadCart', { files: ['src/gone.ts'], readFile: () => null });
    expect(r.kind).toBe('not-found');
  });

  it('reports the line count so the caller can see the cost', () => {
    const r = show('src/a.ts#loadCart');
    expect(r.lines).toBe(r.endLine - r.startLine + 1);
    expect(formatShow(r)).toContain(`${r.lines} lines`);
  });
});

describe('formatShow', () => {
  it('prints a one-line header then numbered source', () => {
    const r = show('src/a.ts#loadCart');
    const lines = formatShow(r).split('\n');
    expect(lines[0]).toBe(`src/a.ts:${r.startLine}-${r.endLine}  function loadCart  (${r.lines} lines)`);
    expect(lines[1]).toMatch(new RegExp(`^\\s*${r.startLine} \\| `));
    expect(lines).toHaveLength(r.lines + 1);
  });
});
