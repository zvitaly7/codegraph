import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeInventory(outDir, paths, snapshotId = 'snapshot:test:deadbeef') {
  const dir = join(outDir, 'inventory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, snapshotId }));
  const rows = paths.map((p) => ({ id: `file:${p}`, path: p, language: 'JavaScript', kind: 'code' }));
  writeFileSync(join(dir, 'files.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
}

function writeImports(outDir, edges) {
  const dir = join(outDir, 'imports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1 }));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

function internalEdge(from, to) {
  return { type: 'IMPORTS', from: `file:${from}`, to: `file:${to}`, properties: { kind: 'internal' } };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function readJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const PATHS = ['src/cart/index.ts', 'src/cart/util.ts', 'src/checkout/pay.ts', 'bin/cli.mjs', 'package.json'];

afterEach(() => vi.restoreAllMocks());

describe('domains run — full run with inventory + imports', () => {
  it('writes Domain/BELONGS_TO/DEPENDS_ON artifacts and a manifest, exit 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repoRoot = tmp('cdom-repo-');
    const out = tmp('cdom-out-');
    writeInventory(out, PATHS);
    writeImports(out, [
      internalEdge('src/cart/index.ts', 'src/checkout/pay.ts'), // cart → checkout
      internalEdge('src/checkout/pay.ts', 'src/cart/util.ts'),  // checkout → cart
      internalEdge('src/cart/index.ts', 'src/cart/util.ts'),    // self-loop, skipped
      { type: 'IMPORTS', from: 'file:src/cart/index.ts', to: 'pkg:react', properties: { kind: 'external' } },
    ]);

    const code = await run(['--repo-root', repoRoot, '--out', out]);
    expect(code).toBe(0);

    const manifest = readJson(join(out, 'domains', 'manifest.json'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.mode).toBe('derived');
    expect(manifest.basedOnSnapshot).toBe('snapshot:test:deadbeef');
    expect(manifest.counts).toEqual({ domains: 4, files: 5, belongsTo: 5, dependsOn: 2 });
    expect(typeof manifest.generatedAt).toBe('string');

    const nodes = readJsonl(join(out, 'domains', 'nodes.jsonl'));
    expect(nodes.map((n) => n.id).sort()).toEqual(
      ['domain:bin', 'domain:cart', 'domain:checkout', 'domain:unassigned'],
    );

    const edges = readJsonl(join(out, 'domains', 'edges.jsonl'));
    expect(edges).toContainEqual(expect.objectContaining({
      type: 'DEPENDS_ON', from: 'domain:cart', to: 'domain:checkout', properties: { weight: 1 },
    }));
    expect(edges.filter((e) => e.type === 'BELONGS_TO')).toHaveLength(5);
  });

  it('is deterministic — a second run yields identical nodes/edges bytes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repoRoot = tmp('cdom-repo-');
    const out = tmp('cdom-out-');
    writeInventory(out, PATHS);
    writeImports(out, [internalEdge('src/cart/index.ts', 'src/checkout/pay.ts')]);

    await run(['--repo-root', repoRoot, '--out', out]);
    const n1 = readFileSync(join(out, 'domains', 'nodes.jsonl'), 'utf8');
    const e1 = readFileSync(join(out, 'domains', 'edges.jsonl'), 'utf8');
    await run(['--repo-root', repoRoot, '--out', out]);
    const n2 = readFileSync(join(out, 'domains', 'nodes.jsonl'), 'utf8');
    const e2 = readFileSync(join(out, 'domains', 'edges.jsonl'), 'utf8');
    expect(n1).toBe(n2);
    expect(e1).toBe(e2);
  });
});

describe('domains run — imports optional', () => {
  it('emits Domain + BELONGS_TO only, no DEPENDS_ON, when imports are absent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const repoRoot = tmp('cdom-repo-');
    const out = tmp('cdom-out-');
    writeInventory(out, PATHS);

    const code = await run(['--repo-root', repoRoot, '--out', out]);
    expect(code).toBe(0);
    const manifest = readJson(join(out, 'domains', 'manifest.json'));
    expect(manifest.counts.dependsOn).toBe(0);
    expect(manifest.counts.belongsTo).toBe(5);
    // A one-line note is printed about the missing imports artifact.
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed.toLowerCase()).toContain('imports');
  });
});

describe('domains run — errors', () => {
  it('exits 2 when the inventory manifest is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const repoRoot = tmp('cdom-repo-');
    const out = tmp('cdom-out-');
    const code = await run(['--repo-root', repoRoot, '--out', out]);
    expect(code).toBe(2);
  });
});

describe('domains run — config override mode', () => {
  it('reports mode "config" and honors a string domains override', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repoRoot = tmp('cdom-repo-');
    const out = tmp('cdom-out-');
    writeInventory(out, PATHS);
    writeFileSync(join(repoRoot, 'domains.config.mjs'), `
      export const CANONICAL_DOMAINS = { cart: { kind: 'product' }, checkout: { kind: 'product' } };
      export const ALIASES = { cart: 'cart', checkout: 'checkout' };
      export const AREA_BUCKETS = [];
    `);
    writeFileSync(join(repoRoot, 'codegraph.config.mjs'),
      "export default { domains: './domains.config.mjs' };");

    const code = await run(['--repo-root', repoRoot, '--out', out]);
    expect(code).toBe(0);
    const manifest = readJson(join(out, 'domains', 'manifest.json'));
    expect(manifest.mode).toBe('config');
    // bin/cli.mjs and package.json fall through to unassigned under this override.
    const nodes = readJsonl(join(out, 'domains', 'nodes.jsonl'));
    expect(nodes.map((n) => n.id)).toContain('domain:unassigned');
  });
});
