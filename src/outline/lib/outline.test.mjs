import { describe, it, expect } from 'vitest';
import { buildOutline, formatOutline } from './outline.mjs';

const SOURCE = `/** Cart module header. */
import React from 'react';
import { store } from './store/cartStore';
import './side-effect.css';

export interface Props {
  id: string;
}

export type Cart = { items: number };

export enum Status { Open, Closed }

/**
 * Read the cart.
 * @param id cart id
 */
export async function loadCart(id: string, opts?: Opts): Promise<Cart> {
  const secret = 42;
  return { items: secret };
}

// Local helper.
function helper(a: number): number {
  return a * 2;
}

export const CART_KEY = 'cart';
export const useCart = (id: string) => loadCart(id);
let counter: number;

export default class CartStore extends Base implements Disposable {
  private hidden = 1;
  protected alsoHidden = 2;
  items: number[] = [];
  static create(): CartStore { return new CartStore(); }
  get size(): number { return this.items.length; }
  add(item: number): void { this.items.push(item); }
  #secret() { return 1; }
}

export * from './other';
`;

/** 1-based line number of the first line containing `needle`. */
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

const outline = (text = SOURCE, opts) => buildOutline('src/checkout/Cart.ts', text, opts);
const declOf = (o, name) => o.declarations.list.find((d) => d.name === name);

describe('buildOutline', () => {
  it('compacts the module imports to specifiers only', () => {
    const o = outline();
    expect(o.imports.list).toEqual(['react', './store/cartStore', './side-effect.css']);
    expect(o.imports.count).toBe(3);
  });

  it('lists every top-level declaration in source order with its kind', () => {
    const o = outline();
    expect(o.declarations.list.map((d) => [d.name, d.kind])).toEqual([
      ['Props', 'interface'],
      ['Cart', 'type'],
      ['Status', 'enum'],
      ['loadCart', 'function'],
      ['helper', 'function'],
      ['CART_KEY', 'const'],
      ['useCart', 'const'],
      ['counter', 'let'],
      ['CartStore', 'class'],
      ['./other', 'reexport'],
    ]);
    expect(o.declarations.count).toBe(10);
    expect(o.declarations.truncated).toBe(false);
  });

  it('marks exported vs local declarations', () => {
    const o = outline();
    expect(declOf(o, 'loadCart').exported).toBe(true);
    expect(declOf(o, 'CartStore').exported).toBe(true);
    expect(declOf(o, 'helper').exported).toBe(false);
    expect(declOf(o, 'counter').exported).toBe(false);
  });

  it('records the real line range of each declaration', () => {
    const o = outline();
    const fn = declOf(o, 'loadCart');
    expect(fn.startLine).toBe(lineOf(SOURCE, 'export async function loadCart'));
    expect(fn.endLine).toBe(fn.startLine + 3);
    expect(o.lines).toBe(SOURCE.split('\n').length);
  });

  it('writes a one-line signature with params and return type as written', () => {
    const o = outline();
    expect(declOf(o, 'loadCart').signature).toBe('loadCart(id: string, opts?: Opts): Promise<Cart>');
    expect(declOf(o, 'loadCart').async).toBe(true);
    expect(declOf(o, 'helper').signature).toBe('helper(a: number): number');
    expect(declOf(o, 'helper').async).toBe(false);
  });

  it('signs classes with their heritage and types/interfaces with their name', () => {
    const o = outline();
    expect(declOf(o, 'CartStore').signature).toBe('CartStore extends Base implements Disposable');
    expect(declOf(o, 'Props').signature).toBe('Props');
    expect(declOf(o, 'Cart').signature).toBe('Cart');
  });

  it('notes a trivially inferable initializer kind for variables', () => {
    const o = outline();
    expect(declOf(o, 'useCart').signature).toBe('useCart = arrow fn');
    expect(declOf(o, 'CART_KEY').signature).toBe("CART_KEY = 'cart'");
    expect(declOf(o, 'counter').signature).toBe('counter: number');
  });

  it('captures only the first line of an attached JSDoc or line comment', () => {
    const o = outline();
    expect(declOf(o, 'loadCart').doc).toBe('Read the cart.');
    expect(declOf(o, 'helper').doc).toBe('Local helper.');
    expect(declOf(o, 'CART_KEY').doc).toBeNull();
  });

  it('lists a class public members one level deep, hiding private ones', () => {
    const members = declOf(outline(), 'CartStore').members;
    expect(members.list.map((m) => [m.name, m.kind])).toEqual([
      ['items', 'property'],
      ['create', 'method'],
      ['size', 'getter'],
      ['add', 'method'],
    ]);
    expect(members.list.find((m) => m.name === 'create').static).toBe(true);
    expect(members.list.find((m) => m.name === 'add').line).toBe(lineOf(SOURCE, 'add(item: number)'));
    expect(members.list.some((m) => m.name === 'hidden' || m.name === 'alsoHidden')).toBe(false);
  });

  it('never includes a function or method body', () => {
    const text = formatOutline(outline());
    expect(text).not.toContain('const secret = 42');
    expect(text).not.toContain('return a * 2');
    expect(text).not.toContain('this.items.push');
  });

  it('caps declarations and members with --limit and marks the truncation', () => {
    const o = outline(SOURCE, { limit: 3 });
    expect(o.declarations.count).toBe(10);
    expect(o.declarations.list).toHaveLength(3);
    expect(o.declarations.truncated).toBe(true);
    expect(o.imports.list).toHaveLength(3);
    expect(formatOutline(o)).toContain('+7 more');
  });

  it('degrades gracefully on a file with syntax errors', () => {
    const broken = 'export function ok(): void {}\nexport class {{{ oops\n';
    const o = buildOutline('src/broken.ts', broken);
    expect(o.kind).toBe('outline');
    expect(o.parseErrors).toBeGreaterThan(0);
    expect(o.declarations.list.some((d) => d.name === 'ok')).toBe(true);
    expect(() => formatOutline(o)).not.toThrow();
  });

  it('handles an empty file', () => {
    const o = buildOutline('src/empty.ts', '');
    expect(o.declarations.count).toBe(0);
    expect(o.imports.count).toBe(0);
    expect(formatOutline(o)).toContain('src/empty.ts');
  });

  it('sees CommonJS requires as imports and named function expressions', () => {
    const cjs = "const fs = require('node:fs');\nmodule.exports = { fs };\n";
    const o = buildOutline('src/legacy.cjs', cjs);
    expect(o.imports.list).toEqual(['node:fs']);
    expect(declOf(o, 'fs').signature).toBe('fs = require(…)');
  });
});

describe('formatOutline', () => {
  it('renders a compact block: header, imports, one line per declaration', () => {
    const text = formatOutline(outline());
    const lines = text.split('\n');
    expect(lines[0]).toContain('OUTLINE src/checkout/Cart.ts');
    expect(lines[1]).toContain('imports (3): react, ./store/cartStore, ./side-effect.css');
    expect(text).toContain('export async function loadCart(id: string, opts?: Opts): Promise<Cart>');
    expect(text).toContain('— Read the cart.');
    expect(text).toContain('export default class CartStore extends Base implements Disposable');
    expect(text).toContain("export * from './other'");
    // A skeleton must stay much shorter than the file it describes.
    expect(lines.length).toBeLessThan(SOURCE.split('\n').length);
  });
});
