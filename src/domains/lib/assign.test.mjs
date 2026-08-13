import { describe, it, expect } from 'vitest';
import { assignDomain } from './assign.mjs';
import { deriveDomainsConfig } from '../derive.mjs';

const relPaths = [
  'src/cart/index.ts',
  'src/checkout/pay.ts',
  'bin/cli.mjs',
  'docs/readme.md',
  'package.json',
];
const cfg = deriveDomainsConfig(relPaths, { srcRoots: ['src'] });
const opts = { srcRoots: ['src'] };

describe('assignDomain — precedence order', () => {
  it('(a) maps a file under a src root via ALIASES', () => {
    expect(assignDomain('src/cart/index.ts', cfg, opts)).toBe('cart');
    expect(assignDomain('src/checkout/pay.ts', cfg, opts)).toBe('checkout');
  });

  it('(a) soft kebab-derives a src segment that has no alias', () => {
    expect(assignDomain('src/NewThing/x.ts', cfg, opts)).toBe('new-thing');
    expect(assignDomain('src/orders/list.ts', cfg, opts)).toBe('orders');
  });

  it('(b) walks AREA_BUCKETS for files outside src roots', () => {
    expect(assignDomain('bin/cli.mjs', cfg, opts)).toBe('bin');
    expect(assignDomain('docs/readme.md', cfg, opts)).toBe('docs');
    expect(assignDomain('docs/guide/deep/intro.md', cfg, opts)).toBe('docs');
  });

  it('(c) falls back to unassigned for top-level files and unknown areas', () => {
    expect(assignDomain('package.json', cfg, opts)).toBe('unassigned');
    expect(assignDomain('tools/x.mjs', cfg, opts)).toBe('unassigned');
  });

  it('area-bucket prefix matching is segment-safe (bin does not match binary/)', () => {
    expect(assignDomain('binary/x.ts', cfg, opts)).toBe('unassigned');
  });

  it('src precedence wins over an overlapping area bucket', () => {
    // A config where "src" is also (nonsensically) an area bucket: src wins.
    const weird = {
      CANONICAL_DOMAINS: { cart: { kind: 'product' }, src: { kind: 'infra' }, unassigned: { kind: 'infra' } },
      ALIASES: { cart: 'cart' },
      AREA_BUCKETS: [['src', 'src']],
    };
    expect(assignDomain('src/cart/index.ts', weird, opts)).toBe('cart');
  });

  it('defaults srcRoots to [src] when opts omitted', () => {
    expect(assignDomain('src/cart/index.ts', cfg)).toBe('cart');
  });
});
