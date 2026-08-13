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
  repo = mkdtempSync(join(tmpdir(), 'cg-imp-run-'));
});

function src(rel, text) {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

describe('run() happy path', () => {
  it('writes manifest/nodes/edges and computes counts + rate', async () => {
    src('src/a.ts', "import { b } from './b'; import react from 'react'; import x from './missing';");
    src('src/b.ts', "export const b = 1;");
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:README.md', path: 'README.md', language: 'Markdown', kind: 'doc' },
    ]);

    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    expect(code).toBe(0);

    const out = join(repo, '.kg-cache', 'imports');
    for (const f of ['manifest.json', 'nodes.jsonl', 'edges.jsonl']) {
      expect(existsSync(join(out, f))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.basedOnSnapshot).toBe('snapshot:demo:rev1');
    expect(typeof manifest.generatedAt).toBe('string');
    expect(manifest.counts).toEqual({ files: 2, packages: 1, edges: 2, internal: 1, external: 1, unresolved: 1 });
    expect(manifest.resolutionRate).toBeCloseTo(0.5, 5);

    const nodes = readLines(join(out, 'nodes.jsonl'));
    expect(nodes).toContainEqual({ id: 'pkg:react', labels: ['Package'], properties: { name: 'react', scope: null } });
    const edges = readLines(join(out, 'edges.jsonl'));
    expect(edges.some((e) => e.to === 'file:src/b.ts' && e.properties.kind === 'internal')).toBe(true);
  });

  it('resolves tsconfig path aliases end to end', async () => {
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } },
    }));
    src('src/entry.ts', "import { u } from '@app/util';");
    src('src/app/util.ts', 'export const u = 1;');
    writeInventory(repo, [
      { id: 'file:src/entry.ts', path: 'src/entry.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/app/util.ts', path: 'src/app/util.ts', language: 'TypeScript', kind: 'code' },
    ]);
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    expect(code).toBe(0);
    const edges = readLines(join(repo, '.kg-cache', 'imports', 'edges.jsonl'));
    expect(edges).toContainEqual({
      id: 'edge:file:src/entry.ts:IMPORTS:file:src/app/util.ts',
      type: 'IMPORTS', from: 'file:src/entry.ts', to: 'file:src/app/util.ts',
      properties: { specifier: '@app/util', kind: 'internal' },
    });
  });

  it('basedOnSnapshot falls back to "unknown" when inventory manifest lacks a snapshotId', async () => {
    src('src/a.ts', 'export const a = 1;');
    writeInventory(repo, [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }], {});
    await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'imports', 'manifest.json'), 'utf8'));
    expect(manifest.basedOnSnapshot).toBe('unknown');
    // vacuous rate when there is nothing internal/unresolved to resolve
    expect(manifest.resolutionRate).toBe(1);
  });
});

describe('run() exit codes', () => {
  it('missing inventory manifest → 2', async () => {
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    expect(code).toBe(2);
  });

  it('bad --require-resolution-rate value → 2', async () => {
    writeInventory(repo, [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }]);
    src('src/a.ts', 'export const a = 1;');
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache'), '--require-resolution-rate', 'abc']);
    expect(code).toBe(2);
  });

  it('--require-resolution-rate gate: fails (exit 1) but still writes artifacts', async () => {
    src('src/a.ts', "import b from './b'; import x from './missing';");
    src('src/b.ts', 'export const b = 1;');
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    const out = join(repo, '.kg-cache');
    const code = await run(['--repo-root', repo, '--out', out, '--require-resolution-rate', '0.9']);
    expect(code).toBe(1); // rate 0.5 < 0.9
    expect(existsSync(join(out, 'imports', 'manifest.json'))).toBe(true); // written first
  });

  it('--require-resolution-rate gate: passes (exit 0) when rate ≥ threshold', async () => {
    src('src/a.ts', "import b from './b'; import x from './missing';");
    src('src/b.ts', 'export const b = 1;');
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache'), '--require-resolution-rate', '0.4']);
    expect(code).toBe(0); // rate 0.5 ≥ 0.4
  });

  it('--max-files limits the analyzed sources', async () => {
    src('src/a.ts', "import b from './b';");
    src('src/b.ts', "import c from './c';");
    src('src/c.ts', 'export const c = 1;');
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/c.ts', path: 'src/c.ts', language: 'TypeScript', kind: 'code' },
    ]);
    await run(['--repo-root', repo, '--out', join(repo, '.kg-cache'), '--max-files', '1']);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'imports', 'manifest.json'), 'utf8'));
    expect(manifest.counts.files).toBe(1);
  });

  it('honors --inventory pointing at a custom inventory dir', async () => {
    const customInv = join(repo, 'custom-inv');
    mkdirSync(customInv, { recursive: true });
    writeFileSync(join(customInv, 'files.jsonl'),
      JSON.stringify({ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }));
    writeFileSync(join(customInv, 'manifest.json'), JSON.stringify({ snapshotId: 'snapshot:x:y' }));
    src('src/a.ts', "import r from 'react';");
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache'), '--inventory', customInv]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'imports', 'manifest.json'), 'utf8'));
    expect(manifest.basedOnSnapshot).toBe('snapshot:x:y');
  });
});
