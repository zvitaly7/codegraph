import { describe, it, expect } from 'vitest';
import { deriveDomainsConfig, kebab, segmentAfterSrcRoot } from './derive.mjs';

describe('kebab — canonical id derivation', () => {
  it('leaves simple lowercase segments untouched', () => {
    expect(kebab('config')).toBe('config');
    expect(kebab('inventory')).toBe('inventory');
  });
  it('splits camelCase and normalizes separators', () => {
    expect(kebab('FooBar')).toBe('foo-bar');
    expect(kebab('graph_builder')).toBe('graph-builder');
    expect(kebab('MyHTTPServer')).toBe('my-http-server');
    expect(kebab('already-kebab')).toBe('already-kebab');
  });
  it('falls back to unassigned for degenerate segments', () => {
    expect(kebab('___')).toBe('unassigned');
    expect(kebab('')).toBe('unassigned');
  });
});

describe('segmentAfterSrcRoot', () => {
  it('returns the first segment under a src root', () => {
    expect(segmentAfterSrcRoot('src/config/load.mjs', ['src'])).toBe('config');
    expect(segmentAfterSrcRoot('src/a/b/c.ts', ['src'])).toBe('a');
  });
  it('returns null when not under any src root or when it is the root itself', () => {
    expect(segmentAfterSrcRoot('bin/cli.mjs', ['src'])).toBe(null);
    expect(segmentAfterSrcRoot('src', ['src'])).toBe(null);
    expect(segmentAfterSrcRoot('package.json', ['src'])).toBe(null);
  });
  it('supports multi-segment and multiple roots, longest match first', () => {
    expect(segmentAfterSrcRoot('app/src/widgets/x.ts', ['app/src'])).toBe('widgets');
    expect(segmentAfterSrcRoot('packages/ui/button.ts', ['src', 'packages'])).toBe('ui');
  });
});

describe('deriveDomainsConfig', () => {
  const relPaths = [
    'src/cart/index.ts',
    'src/cart/util.ts',
    'src/checkout/pay.ts',
    'bin/cli.mjs',
    'docs/readme.md',
    'docs/guide/intro.md',
    'package.json',
    '.gitignore',
  ];

  it('maps src subdirs to product domains, top-level dirs to infra buckets', () => {
    const cfg = deriveDomainsConfig(relPaths, { srcRoots: ['src'] });
    expect(cfg.CANONICAL_DOMAINS).toEqual({
      bin: { kind: 'infra' },
      cart: { kind: 'product' },
      checkout: { kind: 'product' },
      docs: { kind: 'infra' },
      unassigned: { kind: 'infra' },
    });
    expect(cfg.ALIASES).toEqual({ cart: 'cart', checkout: 'checkout' });
    expect(cfg.AREA_BUCKETS).toEqual([['bin', 'bin'], ['docs', 'docs']]);
  });

  it('always includes an infra unassigned domain even with no top-level files', () => {
    const cfg = deriveDomainsConfig(['src/only/x.ts'], { srcRoots: ['src'] });
    expect(cfg.CANONICAL_DOMAINS.unassigned).toEqual({ kind: 'infra' });
  });

  it('is deterministic and sorted regardless of input order', () => {
    const a = deriveDomainsConfig(relPaths, { srcRoots: ['src'] });
    const b = deriveDomainsConfig([...relPaths].reverse(), { srcRoots: ['src'] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.CANONICAL_DOMAINS)).toEqual([...Object.keys(a.CANONICAL_DOMAINS)].sort());
    expect(a.AREA_BUCKETS).toEqual([...a.AREA_BUCKETS].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  });

  it('kebab-cases mixed-case segment ids and lowercases alias keys', () => {
    const cfg = deriveDomainsConfig(['src/FooBar/x.ts'], { srcRoots: ['src'] });
    expect(cfg.CANONICAL_DOMAINS['foo-bar']).toEqual({ kind: 'product' });
    expect(cfg.ALIASES.foobar).toBe('foo-bar');
  });

  it('defaults srcRoots to [src]', () => {
    const cfg = deriveDomainsConfig(['src/a/x.ts', 'lib/y.ts']);
    expect(cfg.CANONICAL_DOMAINS.a).toEqual({ kind: 'product' });
    expect(cfg.CANONICAL_DOMAINS.lib).toEqual({ kind: 'infra' });
  });
});
