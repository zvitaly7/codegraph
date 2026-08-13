import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';

function writeInventory(dir, rows, manifest = { snapshotId: 'snapshot:demo:rev1' }) {
  const inv = join(dir, '.kg-cache', 'inventory');
  mkdirSync(inv, { recursive: true });
  writeFileSync(join(inv, 'files.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(inv, 'manifest.json'), JSON.stringify(manifest));
  return inv;
}

function readLines(p) {
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let repo;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cg-sym-run-'));
});

function src(rel, text) {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

describe('run() happy path', () => {
  it('writes manifest/nodes/edges and computes symbol counts', async () => {
    src('src/a.ts', 'export function foo() {}\nexport const bar = 2;');
    src('src/b.ts', 'const hidden = 1;');
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:README.md', path: 'README.md', language: 'Markdown', kind: 'doc' },
    ]);

    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    expect(code).toBe(0);

    const out = join(repo, '.kg-cache', 'symbols');
    for (const f of ['manifest.json', 'nodes.jsonl', 'edges.jsonl']) {
      expect(existsSync(join(out, f))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.basedOnSnapshot).toBe('snapshot:demo:rev1');
    expect(typeof manifest.generatedAt).toBe('string');
    expect(manifest.counts).toEqual({ files: 2, symbols: 3, edges: 3, exported: 2 });

    const nodes = readLines(join(out, 'nodes.jsonl'));
    expect(nodes).toContainEqual({
      id: 'sym:src/a.ts#foo',
      labels: ['Symbol'],
      properties: { name: 'foo', kind: 'function', exported: true, path: 'src/a.ts', line: 1 },
    });
    expect(nodes).toContainEqual({ id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts' } });

    const edges = readLines(join(out, 'edges.jsonl'));
    expect(edges).toContainEqual({
      id: 'edge:file:src/a.ts:DECLARES:sym:src/a.ts#foo',
      type: 'DECLARES', from: 'file:src/a.ts', to: 'sym:src/a.ts#foo',
      properties: { kind: 'function' },
    });
  });

  it('basedOnSnapshot falls back to "unknown" when the inventory manifest lacks a snapshotId', async () => {
    src('src/a.ts', 'export const a = 1;');
    writeInventory(repo, [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }], {});
    await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'symbols', 'manifest.json'), 'utf8'));
    expect(manifest.basedOnSnapshot).toBe('unknown');
  });

  it('tolerates a source listed in inventory but missing on disk', async () => {
    // b.ts is in the inventory but never written to disk — should be skipped, not fatal.
    src('src/a.ts', 'export const a = 1;');
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'symbols', 'manifest.json'), 'utf8'));
    expect(manifest.counts.files).toBe(1);
    expect(manifest.counts.symbols).toBe(1);
  });
});

describe('run() exit codes & flags', () => {
  it('missing inventory manifest → 2', async () => {
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    expect(code).toBe(2);
  });

  it('bad --max-files value → 2', async () => {
    writeInventory(repo, [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }]);
    src('src/a.ts', 'export const a = 1;');
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache'), '--max-files', 'abc']);
    expect(code).toBe(2);
  });

  it('--max-files limits the analyzed sources', async () => {
    src('src/a.ts', 'export const a = 1;');
    src('src/b.ts', 'export const b = 1;');
    src('src/c.ts', 'export const c = 1;');
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/c.ts', path: 'src/c.ts', language: 'TypeScript', kind: 'code' },
    ]);
    await run(['--repo-root', repo, '--out', join(repo, '.kg-cache'), '--max-files', '1']);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'symbols', 'manifest.json'), 'utf8'));
    expect(manifest.counts.files).toBe(1);
  });

  it('honors --inventory pointing at a custom inventory dir', async () => {
    const customInv = join(repo, 'custom-inv');
    mkdirSync(customInv, { recursive: true });
    writeFileSync(join(customInv, 'files.jsonl'),
      JSON.stringify({ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }));
    writeFileSync(join(customInv, 'manifest.json'), JSON.stringify({ snapshotId: 'snapshot:x:y' }));
    src('src/a.ts', 'export const a = 1;');
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache'), '--inventory', customInv]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'symbols', 'manifest.json'), 'utf8'));
    expect(manifest.basedOnSnapshot).toBe('snapshot:x:y');
  });
});
