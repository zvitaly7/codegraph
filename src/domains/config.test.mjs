import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDomainsConfig } from './config.mjs';

const relPaths = ['src/cart/index.ts', 'src/checkout/pay.ts', 'bin/cli.mjs', 'package.json'];

afterEach(() => vi.restoreAllMocks());

describe('loadDomainsConfig — derived mode (default)', () => {
  it('auto-derives when cfg.domains is null', async () => {
    const out = await loadDomainsConfig({ cfg: { domains: null, srcRoots: ['src'] }, repoRoot: '/x', relPaths });
    expect(out.mode).toBe('derived');
    expect(out.CANONICAL_DOMAINS.cart).toEqual({ kind: 'product' });
    expect(out.CANONICAL_DOMAINS.bin).toEqual({ kind: 'infra' });
    expect(out.CANONICAL_DOMAINS.unassigned).toEqual({ kind: 'infra' });
    expect(out.AREA_BUCKETS).toEqual([['bin', 'bin']]);
  });
});

describe('loadDomainsConfig — inline object override', () => {
  it('uses a provided object and reports config mode', async () => {
    const domains = {
      CANONICAL_DOMAINS: { cart: { kind: 'product' }, tooling: { kind: 'infra' } },
      ALIASES: { cart: 'cart', basket: 'cart' },
      AREA_BUCKETS: [['scripts', 'tooling']],
    };
    const out = await loadDomainsConfig({ cfg: { domains, srcRoots: ['src'] }, repoRoot: '/x', relPaths });
    expect(out.mode).toBe('config');
    expect(out.ALIASES).toEqual({ basket: 'cart', cart: 'cart' });
    expect(out.AREA_BUCKETS).toEqual([['scripts', 'tooling']]);
    // unassigned is guaranteed present even if the user omitted it.
    expect(out.CANONICAL_DOMAINS.unassigned).toEqual({ kind: 'infra' });
  });

  it('normalizes string-kind and array canonical shapes', async () => {
    const out = await loadDomainsConfig({
      cfg: { domains: { CANONICAL_DOMAINS: { cart: 'product', ops: 'infra' }, ALIASES: {}, AREA_BUCKETS: [] } },
      repoRoot: '/x',
      relPaths,
    });
    expect(out.CANONICAL_DOMAINS.cart).toEqual({ kind: 'product' });
    expect(out.CANONICAL_DOMAINS.ops).toEqual({ kind: 'infra' });
  });
});

describe('loadDomainsConfig — string path override (dynamic import)', () => {
  it('imports a module file and reads the three tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdom-cfg-'));
    const file = join(dir, 'my.domains.mjs');
    writeFileSync(file, `
      export const CANONICAL_DOMAINS = { cart: { kind: 'product' }, docs: { kind: 'infra' } };
      export const ALIASES = { cart: 'cart' };
      export const AREA_BUCKETS = [['docs', 'docs']];
    `);
    const out = await loadDomainsConfig({ cfg: { domains: './my.domains.mjs' }, repoRoot: dir, relPaths });
    expect(out.mode).toBe('config');
    expect(out.CANONICAL_DOMAINS.cart).toEqual({ kind: 'product' });
    expect(out.AREA_BUCKETS).toEqual([['docs', 'docs']]);
  });

  it('reads tables from a default export too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdom-cfg-'));
    const file = join(dir, 'def.domains.mjs');
    writeFileSync(file, `
      export default {
        CANONICAL_DOMAINS: { search: { kind: 'product' } },
        ALIASES: { discovery: 'search' },
        AREA_BUCKETS: [],
      };
    `);
    const out = await loadDomainsConfig({ cfg: { domains: './def.domains.mjs' }, repoRoot: dir, relPaths });
    expect(out.CANONICAL_DOMAINS.search).toEqual({ kind: 'product' });
    expect(out.ALIASES).toEqual({ discovery: 'search' });
  });
});

describe('loadDomainsConfig — validation (warn + coerce to unassigned)', () => {
  it('coerces alias targets that are not canonical domains', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await loadDomainsConfig({
      cfg: { domains: { CANONICAL_DOMAINS: { cart: { kind: 'product' } }, ALIASES: { basket: 'nope' }, AREA_BUCKETS: [] } },
      repoRoot: '/x',
      relPaths,
    });
    expect(out.ALIASES.basket).toBe('unassigned');
    expect(warn).toHaveBeenCalled();
  });

  it('coerces area-bucket targets that are not canonical domains', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await loadDomainsConfig({
      cfg: { domains: { CANONICAL_DOMAINS: { cart: { kind: 'product' } }, ALIASES: {}, AREA_BUCKETS: [['scripts', 'ghost']] } },
      repoRoot: '/x',
      relPaths,
    });
    expect(out.AREA_BUCKETS).toEqual([['scripts', 'unassigned']]);
    expect(warn).toHaveBeenCalled();
  });
});
