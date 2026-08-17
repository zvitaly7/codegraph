import { describe, it, expect } from 'vitest';
import { buildPrompt, INSTRUCTION } from './prompt.mjs';
import { buildOutline } from '../../outline/lib/outline.mjs';

const FILE_WITH_BODY = `import { total } from './total';

/** Renders the cart screen. */
export function Cart(props) {
  const secretBodyMarker = 'DO-NOT-LEAK-THIS-BODY';
  if (props.empty) { return null; }
  return secretBodyMarker;
}

export const CART_LIMIT = 99;
`;

const fileTarget = () => ({
  id: 'file:src/cart/Cart.tsx',
  kind: 'file',
  name: 'src/cart/Cart.tsx',
  facts: {
    path: 'src/cart/Cart.tsx',
    language: 'TypeScript',
    fileKind: 'code',
    domain: 'cart',
    imports: { internal: ['src/cart/total.ts'], external: ['react'] },
    importedBy: { count: 2, files: ['src/app/Root.tsx', 'src/cart/index.ts'] },
    exports: [{ name: 'Cart', kind: 'function', refs: 2 }],
  },
  outline: buildOutline('src/cart/Cart.tsx', FILE_WITH_BODY),
});

const domainTarget = () => ({
  id: 'domain:cart',
  kind: 'domain',
  name: 'cart',
  facts: {
    name: 'cart',
    domainKind: 'product',
    files: 12,
    dependsOn: [{ name: 'core', n: 7 }],
    dependedOnBy: [{ name: 'checkout', n: 3 }],
    packages: [{ name: 'react', n: 9 }],
    topFiles: [{ name: 'src/cart/store.ts', n: 8 }],
    exports: [{ name: 'useCart', kind: 'function', refs: 6 }],
  },
  outline: null,
});

const symbolTarget = () => ({
  id: 'sym:src/cart/Cart.tsx#Cart',
  kind: 'symbol',
  name: 'Cart',
  facts: {
    name: 'Cart',
    symbolKind: 'function',
    path: 'src/cart/Cart.tsx',
    line: 4,
    exported: true,
    domain: 'cart',
    referencedBy: { count: 2, files: ['src/app/Root.tsx'] },
    uses: ['total'],
    usedBy: ['Root'],
  },
  outline: { kind: 'declaration', path: 'src/cart/Cart.tsx', declarations: { count: 1, list: buildOutline('x.ts', FILE_WITH_BODY).declarations.list.slice(0, 1) } },
});

describe('buildPrompt', () => {
  it('opens with the instruction and asks for 1-2 sentences', () => {
    const prompt = buildPrompt(fileTarget());
    expect(prompt.startsWith(INSTRUCTION)).toBe(true);
    expect(prompt).toContain('1-2 sentences');
    expect(prompt.trimEnd().endsWith('Description:')).toBe(true);
  });

  it('tells the model to say what it cannot determine rather than guess', () => {
    expect(INSTRUCTION).toMatch(/not determinable|say so plainly/i);
    expect(INSTRUCTION).toMatch(/rather than guessing/i);
  });

  it('includes the graph facts for a file', () => {
    const prompt = buildPrompt(fileTarget());
    expect(prompt).toContain('FILE src/cart/Cart.tsx');
    expect(prompt).toContain('domain: cart');
    expect(prompt).toContain('src/cart/total.ts');
    expect(prompt).toContain('react');
    expect(prompt).toContain('imported by 2 file(s)');
    expect(prompt).toContain('src/app/Root.tsx');
    expect(prompt).toContain('Cart function (refs 2)');
  });

  it('includes the outline signatures and doc lines', () => {
    const prompt = buildPrompt(fileTarget());
    expect(prompt).toContain('signatures only, bodies omitted');
    expect(prompt).toContain('export function Cart(props)');
    expect(prompt).toContain('Renders the cart screen.');
    expect(prompt).toContain('CART_LIMIT');
  });

  it('NEVER includes the file body', () => {
    const prompt = buildPrompt(fileTarget());
    expect(prompt).not.toContain('DO-NOT-LEAK-THIS-BODY');
    expect(prompt).not.toContain('props.empty');
    expect(prompt).not.toContain('return null');
    // The whole point: the prompt is far smaller than the file it describes.
    expect(prompt.length).toBeLessThan(INSTRUCTION.length + 900);
  });

  it('builds a domain prompt from domain facts only', () => {
    const prompt = buildPrompt(domainTarget());
    expect(prompt).toContain('DOMAIN cart');
    expect(prompt).toContain('files: 12');
    expect(prompt).toContain('core (7)');
    expect(prompt).toContain('checkout (3)');
    expect(prompt).toContain('react (9)');
    expect(prompt).toContain('useCart function (refs 6)');
    expect(prompt).not.toContain('DECLARATIONS');
  });

  it('builds a symbol prompt with just that symbol declaration', () => {
    const prompt = buildPrompt(symbolTarget());
    expect(prompt).toContain('SYMBOL Cart');
    expect(prompt).toContain('declared in: src/cart/Cart.tsx:4');
    expect(prompt).toContain('referenced by 2 other file(s)');
    expect(prompt).toContain('body omitted');
    expect(prompt).not.toContain('DO-NOT-LEAK-THIS-BODY');
  });

  it('renders empty fact lists as "none" instead of dropping the line', () => {
    const prompt = buildPrompt({
      kind: 'file',
      facts: { path: 'src/x.ts', imports: { internal: [], external: [] }, importedBy: { count: 0, files: [] }, exports: [] },
      outline: null,
    });
    expect(prompt).toContain('imports (internal): none');
    expect(prompt).toContain('imported by 0 file(s): none');
    expect(prompt).toContain('exported symbols: none');
  });

  it('is pure — the same target always yields the same prompt', () => {
    expect(buildPrompt(fileTarget())).toBe(buildPrompt(fileTarget()));
  });
});
