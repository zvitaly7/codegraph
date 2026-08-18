import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

function writeSymbols(dir, nodes, manifest = { basedOnSnapshot: 'snapshot:demo:rev1' }) {
  const sym = join(dir, '.kg-cache', 'symbols');
  mkdirSync(sym, { recursive: true });
  writeFileSync(join(sym, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(sym, 'manifest.json'), JSON.stringify(manifest));
  return sym;
}

function symbolNode(path, name, exported) {
  return {
    id: `sym:${path}#${name}`, labels: ['Symbol'],
    properties: { name, kind: 'function', exported, path, line: 1 },
  };
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

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'cg-ref-run-')); });

function src(rel, text) {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

const outArg = () => ['--repo-root', repo, '--out', join(repo, '.kg-cache')];

describe('run() happy path', () => {
  it('writes manifest/nodes/edges and computes reference counts + deadExports', async () => {
    src('src/a.ts', 'export function foo() {}\n');
    src('src/b.ts', "import { foo } from './a';\nexport const useFoo = () => foo();\n");
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    writeSymbols(repo, [
      { id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts' } },
      symbolNode('src/a.ts', 'foo', true),
      symbolNode('src/b.ts', 'useFoo', true),
    ]);

    const code = await run(outArg());
    expect(code).toBe(0);

    const out = join(repo, '.kg-cache', 'references');
    for (const f of ['manifest.json', 'nodes.jsonl', 'edges.jsonl']) {
      expect(existsSync(join(out, f))).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.basedOnSnapshot).toBe('snapshot:demo:rev1');
    expect(typeof manifest.generatedAt).toBe('string');
    // b references a#foo (cross-file). foo is referenced; useFoo is a dead export.
    expect(manifest.counts).toEqual({
      files: 1, symbolsReferenced: 1, edges: 1, deadExports: 1, entryPointExclusions: 0,
    });

    const edges = readLines(join(out, 'edges.jsonl'));
    expect(edges).toContainEqual({
      id: 'edge:file:src/b.ts:REFERENCES:sym:src/a.ts#foo',
      type: 'REFERENCES', from: 'file:src/b.ts', to: 'sym:src/a.ts#foo',
      properties: { sameFile: false },
    });

    // The referenced Symbol node is reused verbatim from the symbols layer.
    const nodes = readLines(join(out, 'nodes.jsonl'));
    expect(nodes).toContainEqual(symbolNode('src/a.ts', 'foo', true));
    expect(nodes).toContainEqual({ id: 'file:src/b.ts', labels: ['File'], properties: { path: 'src/b.ts' } });
  });

  it('is deterministic across runs (byte-identical nodes/edges)', async () => {
    src('src/a.ts', 'export function foo() {}\n');
    src('src/b.ts', "import { foo } from './a';\nexport const useFoo = () => foo();\n");
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    writeSymbols(repo, [symbolNode('src/a.ts', 'foo', true), symbolNode('src/b.ts', 'useFoo', true)]);

    const out = join(repo, '.kg-cache', 'references');
    await run(outArg());
    const first = readFileSync(join(out, 'edges.jsonl'), 'utf8');
    await run(outArg());
    const second = readFileSync(join(out, 'edges.jsonl'), 'utf8');
    expect(second).toBe(first);
  });
});

describe('run() — entry points are not dead exports', () => {
  const INV = [
    { id: 'file:src/entry.ts', path: 'src/entry.ts', language: 'TypeScript', kind: 'code' },
    { id: 'file:src/lib.ts', path: 'src/lib.ts', language: 'TypeScript', kind: 'code' },
  ];

  function twoUnusedExports() {
    // Neither export is imported anywhere: both are dead-export candidates.
    // `lib.ts` uses its own export, so it gets a File node (same-file uses do
    // not save an export from being dead).
    src('src/entry.ts', 'export function mount() {}\n');
    src('src/lib.ts', 'export function helper() {}\nexport const alias = () => helper();\n');
    writeInventory(repo, INV);
    writeSymbols(repo, [
      symbolNode('src/entry.ts', 'mount', true),
      symbolNode('src/lib.ts', 'helper', true),
    ]);
  }

  const manifest = () => JSON.parse(
    readFileSync(join(repo, '.kg-cache', 'references', 'manifest.json'), 'utf8'),
  );

  it('a file listed in entryPoints has its exports excluded, and the count is reported', async () => {
    twoUnusedExports();
    writeFileSync(join(repo, 'loregraph.config.json'), JSON.stringify({ entryPoints: ['src/entry.ts'] }));

    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.deadExports).toBe(1);          // only src/lib.ts#helper
    expect(manifest().counts.entryPointExclusions).toBe(1); // src/entry.ts#mount
    expect(manifest().entryPoints).toEqual([{ path: 'src/entry.ts', reason: 'config' }]);
  });

  it('a package.json bin target is auto-excluded with no config at all', async () => {
    twoUnusedExports();
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'app', bin: { app: './src/entry.ts' } }));

    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.deadExports).toBe(1);
    expect(manifest().counts.entryPointExclusions).toBe(1);
    expect(manifest().entryPoints).toEqual([{ path: 'src/entry.ts', reason: 'package.json' }]);
  });

  it('a package.json main target is auto-excluded too', async () => {
    twoUnusedExports();
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'app', main: 'src/entry.ts' }));

    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.deadExports).toBe(1);
    expect(manifest().counts.entryPointExclusions).toBe(1);
  });

  it('does not over-exclude: with no entry points both exports stay dead', async () => {
    twoUnusedExports();
    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.deadExports).toBe(2);
    expect(manifest().counts.entryPointExclusions).toBe(0);
    expect(manifest().entryPoints).toEqual([]);
  });

  it('globs match as expected', async () => {
    twoUnusedExports();
    writeFileSync(join(repo, 'loregraph.config.json'), JSON.stringify({ entryPoints: ['src/entry.*'] }));
    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.entryPointExclusions).toBe(1);
  });

  it('marks the entry-point File node, even when it references nothing', async () => {
    twoUnusedExports();
    writeFileSync(join(repo, 'loregraph.config.json'), JSON.stringify({ entryPoints: ['src/entry.ts'] }));
    expect(await run(outArg())).toBe(0);

    const nodes = readLines(join(repo, '.kg-cache', 'references', 'nodes.jsonl'));
    expect(nodes).toContainEqual({
      id: 'file:src/entry.ts',
      labels: ['File'],
      properties: { path: 'src/entry.ts', entryPoint: true },
    });
    // A non-entry file's node is untouched.
    expect(nodes.find((n) => n.id === 'file:src/lib.ts')?.properties.entryPoint).toBeUndefined();
  });
});

describe('run() — entry-point reachability through re-export chains', () => {
  const manifest = () => JSON.parse(
    readFileSync(join(repo, '.kg-cache', 'references', 'manifest.json'), 'utf8'),
  );
  const edges = () => readLines(join(repo, '.kg-cache', 'references', 'edges.jsonl'));
  const invRow = (path) => ({ id: `file:${path}`, path, language: 'JavaScript', kind: 'code' });

  it('a symbol re-exported by the package main is public API, not a dead export', async () => {
    // The reported bug, verbatim: `main` re-exports renderCart, so it is not
    // dead; trulyUnused is reachable from nothing and stays dead.
    src('package.json', JSON.stringify({ name: 'reex', version: '1.0.0', main: 'src/index.js' }));
    src('src/cart.js', 'export const renderCart = () => 1;\n');
    src('src/orphan.js', 'export const trulyUnused = () => 2;\n');
    src('src/index.js', 'export { renderCart } from "./cart.js";\n');
    writeInventory(repo, ['src/cart.js', 'src/index.js', 'src/orphan.js'].map(invRow));
    writeSymbols(repo, [
      symbolNode('src/cart.js', 'renderCart', true),
      symbolNode('src/orphan.js', 'trulyUnused', true),
    ]);

    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.deadExports).toBe(1);          // only src/orphan.js#trulyUnused
    expect(manifest().counts.entryPointExclusions).toBe(1); // renderCart, via the re-export
    expect(manifest().entryPoints).toEqual([{ path: 'src/index.js', reason: 'package.json' }]);

    // The exclusion is visible in the graph, and it names the entry point it came from.
    expect(edges()).toContainEqual({
      id: 'edge:file:src/index.js:EXPOSES:sym:src/cart.js#renderCart',
      type: 'EXPOSES',
      from: 'file:src/index.js',
      to: 'sym:src/cart.js#renderCart',
      properties: { hops: 1 },
    });
  });

  it('follows a chain two hops deep', async () => {
    src('package.json', JSON.stringify({ name: 'chain', main: 'src/index.js' }));
    src('src/index.js', 'export { deep } from "./feature/index.js";\n');
    src('src/feature/index.js', 'export { deep } from "./impl.js";\n');
    src('src/feature/impl.js', 'export const deep = () => 1;\n');
    writeInventory(repo, ['src/feature/impl.js', 'src/feature/index.js', 'src/index.js'].map(invRow));
    writeSymbols(repo, [symbolNode('src/feature/impl.js', 'deep', true)]);

    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.deadExports).toBe(0);
    expect(manifest().counts.entryPointExclusions).toBe(1);
    expect(edges().find((e) => e.type === 'EXPOSES')).toMatchObject({
      from: 'file:src/index.js', to: 'sym:src/feature/impl.js#deep', properties: { hops: 2 },
    });
  });

  it('`export * from` carries every export of the target', async () => {
    src('package.json', JSON.stringify({ name: 'star', main: 'src/index.js' }));
    src('src/index.js', 'export * from "./lib.js";\n');
    src('src/lib.js', 'export const a = 1;\nexport const b = 2;\n');
    writeInventory(repo, ['src/index.js', 'src/lib.js'].map(invRow));
    writeSymbols(repo, [symbolNode('src/lib.js', 'a', true), symbolNode('src/lib.js', 'b', true)]);

    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.deadExports).toBe(0);
    expect(manifest().counts.entryPointExclusions).toBe(2);
  });

  it('a renamed re-export excludes the DECLARED name, not the public one', async () => {
    src('package.json', JSON.stringify({ name: 'renamed', main: 'src/index.js' }));
    src('src/index.js', 'export { internalName as PublicName } from "./lib.js";\n');
    src('src/lib.js', 'export const internalName = 1;\nexport const PublicName = 2;\n');
    writeInventory(repo, ['src/index.js', 'src/lib.js'].map(invRow));
    writeSymbols(repo, [
      symbolNode('src/lib.js', 'internalName', true),
      symbolNode('src/lib.js', 'PublicName', true),
    ]);

    expect(await run(outArg())).toBe(0);
    // internalName is excluded; the decoy also called PublicName is still dead.
    expect(manifest().counts.entryPointExclusions).toBe(1);
    expect(manifest().counts.deadExports).toBe(1);
    expect(edges().filter((e) => e.type === 'EXPOSES').map((e) => e.to))
      .toEqual(['sym:src/lib.js#internalName']);
  });

  it('a re-export cycle terminates instead of hanging', async () => {
    src('package.json', JSON.stringify({ name: 'cyclic', main: 'src/index.js' }));
    src('src/index.js', 'export * from "./a.js";\n');
    src('src/a.js', 'export * from "./b.js";\nexport const fromA = 1;\n');
    src('src/b.js', 'export * from "./a.js";\nexport const fromB = 2;\n');
    writeInventory(repo, ['src/a.js', 'src/b.js', 'src/index.js'].map(invRow));
    writeSymbols(repo, [symbolNode('src/a.js', 'fromA', true), symbolNode('src/b.js', 'fromB', true)]);

    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.entryPointExclusions).toBe(2);
    expect(manifest().counts.deadExports).toBe(0);
  });

  it('does NOT over-exclude: a barrel that is not an entry point saves nothing', async () => {
    // src/barrel.js re-exports hidden, but nothing is an entry point and nobody
    // imports the barrel — hidden is still dead, and so is the barrel's own file.
    src('src/barrel.js', 'export { hidden } from "./impl.js";\n');
    src('src/impl.js', 'export const hidden = 1;\n');
    writeInventory(repo, ['src/barrel.js', 'src/impl.js'].map(invRow));
    writeSymbols(repo, [symbolNode('src/impl.js', 'hidden', true)]);

    expect(await run(outArg())).toBe(0);
    expect(manifest().counts.deadExports).toBe(1);
    expect(manifest().counts.entryPointExclusions).toBe(0);
    expect(manifest().entryPoints).toEqual([]);
    expect(edges().filter((e) => e.type === 'EXPOSES')).toEqual([]);
  });

  it('a repo with no re-exports produces byte-identical artifacts', async () => {
    // Golden bytes captured before re-export reachability existed: the feature
    // must be invisible to every repo that does not re-export.
    src('src/a.ts', 'export function foo() {}\n');
    src('src/b.ts', "import { foo } from './a';\nexport const useFoo = () => foo();\n");
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    writeSymbols(repo, [
      { id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts' } },
      symbolNode('src/a.ts', 'foo', true),
      symbolNode('src/b.ts', 'useFoo', true),
    ]);

    expect(await run(outArg())).toBe(0);
    const out = join(repo, '.kg-cache', 'references');
    expect(readFileSync(join(out, 'nodes.jsonl'), 'utf8')).toBe(
      '{"id":"file:src/b.ts","labels":["File"],"properties":{"path":"src/b.ts"}}\n'
      + '{"id":"sym:src/a.ts#foo","labels":["Symbol"],"properties":'
      + '{"exported":true,"kind":"function","line":1,"name":"foo","path":"src/a.ts"}}',
    );
    expect(readFileSync(join(out, 'edges.jsonl'), 'utf8')).toBe(
      '{"from":"file:src/b.ts","id":"edge:file:src/b.ts:REFERENCES:sym:src/a.ts#foo",'
      + '"properties":{"sameFile":false},"to":"sym:src/a.ts#foo","type":"REFERENCES"}',
    );
    expect(manifest().counts).toEqual({
      files: 1, symbolsReferenced: 1, edges: 1, deadExports: 1, entryPointExclusions: 0,
    });
  });
});

describe('run() — workspace packages are followed by the type-checker', () => {
  it('records a cross-package REFERENCES edge for a workspace-name import', async () => {
    src('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
    src('packages/ui/package.json', JSON.stringify({ name: '@myorg/ui', main: 'src/index.ts' }));
    src('packages/ui/src/index.ts', "export function Button() { return 'b'; }\n");
    src('packages/app/package.json', JSON.stringify({ name: '@myorg/app' }));
    src('packages/app/src/main.ts', "import { Button } from '@myorg/ui';\nexport const App = () => Button();\n");

    writeInventory(repo, [
      { id: 'file:packages/app/src/main.ts', path: 'packages/app/src/main.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:packages/ui/src/index.ts', path: 'packages/ui/src/index.ts', language: 'TypeScript', kind: 'code' },
    ]);
    writeSymbols(repo, [
      symbolNode('packages/ui/src/index.ts', 'Button', true),
      symbolNode('packages/app/src/main.ts', 'App', true),
    ]);

    expect(await run(outArg())).toBe(0);
    const edges = readLines(join(repo, '.kg-cache', 'references', 'edges.jsonl'));
    expect(edges).toContainEqual({
      id: 'edge:file:packages/app/src/main.ts:REFERENCES:sym:packages/ui/src/index.ts#Button',
      type: 'REFERENCES',
      from: 'file:packages/app/src/main.ts',
      to: 'sym:packages/ui/src/index.ts#Button',
      properties: { sameFile: false },
    });
    // Button is used across packages, so it is not a dead export; the entry
    // point (ui's `main`) accounts for nothing extra here.
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'references', 'manifest.json'), 'utf8'));
    expect(manifest.counts.deadExports).toBe(1); // only App
  });
});

describe('run() exit codes & flags', () => {
  it('missing inventory manifest → 2', async () => {
    const code = await run(outArg());
    expect(code).toBe(2);
  });

  it('missing symbols manifest → 2', async () => {
    writeInventory(repo, [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }]);
    src('src/a.ts', 'export const a = 1;\n');
    const code = await run(outArg());
    expect(code).toBe(2);
  });

  it('bad --max-files value → 2', async () => {
    writeInventory(repo, [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }]);
    writeSymbols(repo, [symbolNode('src/a.ts', 'a', true)]);
    src('src/a.ts', 'export const a = 1;\n');
    const code = await run([...outArg(), '--max-files', 'abc']);
    expect(code).toBe(2);
  });

  it('honors --symbols / --inventory pointing at custom dirs', async () => {
    const inv = join(repo, 'inv');
    const symdir = join(repo, 'sym');
    mkdirSync(inv, { recursive: true });
    mkdirSync(symdir, { recursive: true });
    writeFileSync(join(inv, 'files.jsonl'),
      [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
        { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' }]
        .map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(inv, 'manifest.json'), JSON.stringify({ snapshotId: 'snapshot:x:y' }));
    writeFileSync(join(symdir, 'nodes.jsonl'),
      [symbolNode('src/a.ts', 'foo', true)].map((n) => JSON.stringify(n)).join('\n'));
    writeFileSync(join(symdir, 'manifest.json'), JSON.stringify({ basedOnSnapshot: 'snapshot:x:y' }));
    src('src/a.ts', 'export function foo() {}\n');
    src('src/b.ts', "import { foo } from './a';\nexport const g = () => foo();\n");

    const code = await run([...outArg(), '--inventory', inv, '--symbols', symdir]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'references', 'manifest.json'), 'utf8'));
    expect(manifest.basedOnSnapshot).toBe('snapshot:x:y');
    expect(manifest.counts.edges).toBe(1);
  });
});
