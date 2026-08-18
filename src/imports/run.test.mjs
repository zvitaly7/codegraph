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

describe('run() — workspace monorepos', () => {
  const INV = [
    { id: 'file:packages/app/src/main.ts', path: 'packages/app/src/main.ts', language: 'TypeScript', kind: 'code' },
    { id: 'file:packages/ui/src/index.ts', path: 'packages/ui/src/index.ts', language: 'TypeScript', kind: 'code' },
    { id: 'file:packages/ui/src/button.ts', path: 'packages/ui/src/button.ts', language: 'TypeScript', kind: 'code' },
  ];

  function monorepo({ rootPkg, pnpm } = {}) {
    if (rootPkg) src('package.json', JSON.stringify(rootPkg));
    if (pnpm) src('pnpm-workspace.yaml', pnpm);
    src('packages/ui/package.json', JSON.stringify({ name: '@myorg/ui', main: 'src/index.ts' }));
    src('packages/ui/src/index.ts', "export { Button } from './button';");
    src('packages/ui/src/button.ts', 'export const Button = 1;');
    writeInventory(repo, INV);
  }

  async function edgesFor(specifiers) {
    src('packages/app/src/main.ts', specifiers);
    src('packages/app/package.json', JSON.stringify({ name: '@myorg/app' }));
    const code = await run(['--repo-root', repo, '--out', join(repo, '.kg-cache')]);
    expect(code).toBe(0);
    return readLines(join(repo, '.kg-cache', 'imports', 'edges.jsonl'));
  }

  it('a sibling workspace package resolves to a file edge, not pkg:', async () => {
    monorepo({ rootPkg: { name: 'root', private: true, workspaces: ['packages/*'] } });
    const edges = await edgesFor("import { Button } from '@myorg/ui';");
    expect(edges).toContainEqual({
      id: 'edge:file:packages/app/src/main.ts:IMPORTS:file:packages/ui/src/index.ts',
      type: 'IMPORTS',
      from: 'file:packages/app/src/main.ts',
      to: 'file:packages/ui/src/index.ts',
      properties: { specifier: '@myorg/ui', kind: 'internal' },
    });
    expect(edges.some((e) => e.to === 'pkg:@myorg/ui')).toBe(false);
  });

  it('a subpath import resolves to the file under the package', async () => {
    monorepo({ rootPkg: { name: 'root', private: true, workspaces: ['packages/*'] } });
    const edges = await edgesFor("import { Button } from '@myorg/ui/src/button';");
    expect(edges).toContainEqual({
      id: 'edge:file:packages/app/src/main.ts:IMPORTS:file:packages/ui/src/button.ts',
      type: 'IMPORTS',
      from: 'file:packages/app/src/main.ts',
      to: 'file:packages/ui/src/button.ts',
      properties: { specifier: '@myorg/ui/src/button', kind: 'internal' },
    });
  });

  it('the object form { workspaces: { packages: [...] } } works', async () => {
    monorepo({ rootPkg: { name: 'root', private: true, workspaces: { packages: ['packages/*'] } } });
    const edges = await edgesFor("import { Button } from '@myorg/ui';");
    expect(edges.some((e) => e.to === 'file:packages/ui/src/index.ts')).toBe(true);
  });

  it('pnpm-workspace.yaml works with no workspaces key in package.json', async () => {
    monorepo({ rootPkg: { name: 'root', private: true }, pnpm: "packages:\n  - 'packages/*'\n" });
    const edges = await edgesFor("import { Button } from '@myorg/ui';");
    expect(edges.some((e) => e.to === 'file:packages/ui/src/index.ts')).toBe(true);
  });

  it('a workspace name that resolves to no real file stays external', async () => {
    src('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
    src('packages/ghost/package.json', JSON.stringify({ name: '@myorg/ghost', main: 'dist/index.js' }));
    writeInventory(repo, [INV[0]]);
    const edges = await edgesFor("import x from '@myorg/ghost';");
    expect(edges).toContainEqual({
      id: 'edge:file:packages/app/src/main.ts:IMPORTS:pkg:@myorg/ghost',
      type: 'IMPORTS',
      from: 'file:packages/app/src/main.ts',
      to: 'pkg:@myorg/ghost',
      properties: { specifier: '@myorg/ghost', kind: 'external' },
    });
  });

  it('a tsconfig-alias monorepo still resolves exactly as before', async () => {
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@myorg/ui': ['packages/ui/src/index.ts'] } },
    }));
    monorepo({ rootPkg: { name: 'root', private: true, workspaces: ['packages/*'] } });
    const edges = await edgesFor("import { Button } from '@myorg/ui';");
    expect(edges.some((e) => e.to === 'file:packages/ui/src/index.ts')).toBe(true);
  });

  it('a repo with no workspaces produces byte-identical artifacts', async () => {
    // The reference bytes were produced before workspace resolution existed.
    src('src/a.ts', "import { b } from './b'; import react from 'react'; import u from '@myorg/ui';");
    src('src/b.ts', 'export const b = 1;');
    src('package.json', JSON.stringify({ name: 'solo', version: '1.0.0' }));
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    const out = join(repo, '.kg-cache');
    expect(await run(['--repo-root', repo, '--out', out])).toBe(0);

    expect(readFileSync(join(out, 'imports', 'edges.jsonl'), 'utf8')).toBe([
      '{"from":"file:src/a.ts","id":"edge:file:src/a.ts:IMPORTS:file:src/b.ts","properties":{"kind":"internal","specifier":"./b"},"to":"file:src/b.ts","type":"IMPORTS"}',
      '{"from":"file:src/a.ts","id":"edge:file:src/a.ts:IMPORTS:pkg:@myorg/ui","properties":{"kind":"external","specifier":"@myorg/ui"},"to":"pkg:@myorg/ui","type":"IMPORTS"}',
      '{"from":"file:src/a.ts","id":"edge:file:src/a.ts:IMPORTS:pkg:react","properties":{"kind":"external","specifier":"react"},"to":"pkg:react","type":"IMPORTS"}',
    ].join('\n'));
    expect(readFileSync(join(out, 'imports', 'nodes.jsonl'), 'utf8')).toBe([
      '{"id":"file:src/a.ts","labels":["File"],"properties":{"path":"src/a.ts"}}',
      '{"id":"file:src/b.ts","labels":["File"],"properties":{"path":"src/b.ts"}}',
      '{"id":"pkg:@myorg/ui","labels":["Package"],"properties":{"name":"@myorg/ui","scope":"@myorg"}}',
      '{"id":"pkg:react","labels":["Package"],"properties":{"name":"react","scope":null}}',
    ].join('\n'));
    const manifest = JSON.parse(readFileSync(join(out, 'imports', 'manifest.json'), 'utf8'));
    expect(manifest.counts).toEqual({ files: 2, packages: 2, edges: 3, internal: 1, external: 2, unresolved: 0 });
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
