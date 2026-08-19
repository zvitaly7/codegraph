import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';

const A = `import { helper } from './b';

/** Load one cart. */
export async function loadCart(id: string): Promise<Cart> {
  const raw = await helper(id);
  return raw;
}

export const CART_KEY = 'cart';
`;

const B = `export function helper(id: string): string {
  return id;
}

export function loadCart(): void {}
`;

function seedRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'lg-show-cli-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), A);
  writeFileSync(join(repo, 'src', 'b.ts'), B);
  return repo;
}

/** A symbols layer that claims `loadCart` lives at a line it does NOT live at. */
function seedStaleCache(nodes) {
  const cache = mkdtempSync(join(tmpdir(), 'lg-show-cache-'));
  mkdirSync(join(cache, 'symbols'), { recursive: true });
  writeFileSync(join(cache, 'symbols', 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(cache, 'symbols', 'edges.jsonl'), '');
  return cache;
}

const symNode = (path, name, line) => ({
  id: `sym:${path}#${name}`,
  labels: ['Symbol'],
  properties: { name, kind: 'function', exported: true, path, line },
});

let repo;
let out;
let err;
beforeEach(() => {
  repo = seedRepo();
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation((s) => err.push(String(s)));
});
afterEach(() => vi.restoreAllMocks());

const stdout = () => out.join('\n');

describe('show CLI', () => {
  it('prints one symbol with a header and numbered source, exit 0', async () => {
    const code = await run(['src/a.ts#loadCart', '--repo-root', repo]);
    expect(code).toBe(0);
    expect(stdout().split('\n')[0]).toBe('src/a.ts:3-7  function loadCart  (5 lines)');
    expect(stdout()).toContain('3 | /** Load one cart. */');
    expect(stdout()).toContain('export async function loadCart');
    expect(stdout()).not.toContain('CART_KEY');
  });

  it('works with no cache at all (scans the repo)', async () => {
    const code = await run(['helper', '--repo-root', repo, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ kind: 'symbol', path: 'src/b.ts', lookup: 'scan' });
    // Every --json answer says what shape it is (see lib/json_envelope.mjs).
    expect(JSON.parse(stdout())).toMatchObject({ schemaVersion: 1, tool: 'loregraph' });
  });

  it('lists candidates and still exits 0 when the name is ambiguous', async () => {
    const code = await run(['loadCart', '--repo-root', repo]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/ambiguous/i);
    expect(stdout()).toContain('src/a.ts:4');
    expect(stdout()).toContain('src/b.ts:5');
  });

  it('--context adds surrounding lines', async () => {
    await run(['src/a.ts#CART_KEY', '--repo-root', repo, '--context', '3']);
    expect(stdout()).toContain('+3 context');
    expect(stdout()).toContain('src/a.ts:6-10');
    expect(stdout()).toContain('6 |   return raw;');
    expect(stdout()).toContain("9 | export const CART_KEY = 'cart';");
  });

  it('reports a miss with suggestions, exit 0', async () => {
    const code = await run(['loadCarts', '--repo-root', repo]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/no symbol/i);
    expect(stdout()).toContain('loadCart');
  });

  it('prints the RIGHT source even when the cache line number is wrong', async () => {
    // The cache says line 99; the declaration really starts at line 4. `show`
    // re-parses, so a stale line number cannot make it print the wrong lines.
    const cache = seedStaleCache([symNode('src/a.ts', 'loadCart', 99)]);
    const code = await run(['src/a.ts#loadCart', '--repo-root', repo, '--cache', cache, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.lookup).toBe('graph');
    expect(parsed.declarationLine).toBe(4);
    expect(parsed.startLine).toBe(3);
    expect(parsed.endLine).toBe(7);
    expect(parsed.source).toContain('export async function loadCart(id: string): Promise<Cart> {');
    expect(parsed.source).not.toContain('CART_KEY');
  });

  it('falls back to a repo scan when the cache points at the wrong file', async () => {
    const cache = seedStaleCache([symNode('src/gone.ts', 'helper', 1)]);
    const code = await run(['helper', '--repo-root', repo, '--cache', cache, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({ kind: 'symbol', path: 'src/b.ts', lookup: 'scan' });
  });

  it('exits 2 without a symbol', async () => {
    expect(await run(['--repo-root', repo])).toBe(2);
    expect(err.join('\n')).toMatch(/symbol/);
  });

  it('exits 2 on a bad --context', async () => {
    expect(await run(['helper', '--repo-root', repo, '--context', 'lots'])).toBe(2);
  });
});
