import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';

/** The packaged SPA that `explorer` must copy into <cache>/explorer/. */
const SPA_HTML = fileURLToPath(new URL('./index.html', import.meta.url));

function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

function fileNode(path) {
  return { id: `file:${path}`, labels: ['File'], properties: { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'code' } };
}
function symNode(path, name, exported) {
  return { id: `sym:${path}#${name}`, labels: ['Symbol'], properties: { name, kind: 'function', exported, path, line: 1 } };
}
function edge(type, from, to, properties = {}) {
  return { id: `edge:${from}:${type}:${to}`, type, from, to, properties };
}

/** Write a full six-layer cache and return its path. */
function seedCache(cache) {
  mkdirSync(join(cache, 'inventory'), { recursive: true });
  writeFileSync(
    join(cache, 'inventory', 'manifest.json'),
    JSON.stringify({ projectId: 'project:demo', snapshotId: 'snapshot:demo:rev1', generatedAt: '2020-01-01T00:00:00.000Z' }),
  );
  writeLayer(cache, 'inventory', {
    nodes: [fileNode('src/a.ts'), fileNode('src/b.ts'), { id: 'dir:src', labels: ['Directory'], properties: { path: 'src' } }],
    edges: [edge('CONTAINS', 'dir:src', 'file:src/a.ts')],
  });
  writeLayer(cache, 'imports', {
    nodes: [{ id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts' } }, { id: 'pkg:react', labels: ['Package'], properties: { name: 'react' } }],
    edges: [edge('IMPORTS', 'file:src/b.ts', 'file:src/a.ts', { kind: 'internal' }), edge('IMPORTS', 'file:src/a.ts', 'pkg:react', { kind: 'external' })],
  });
  writeLayer(cache, 'symbols', {
    nodes: [symNode('src/a.ts', 'foo', true), symNode('src/b.ts', 'useX', true)],
    edges: [edge('DECLARES', 'file:src/a.ts', 'sym:src/a.ts#foo', { kind: 'function' })],
  });
  writeLayer(cache, 'references', {
    nodes: [symNode('src/a.ts', 'foo', true)],
    edges: [edge('REFERENCES', 'file:src/b.ts', 'sym:src/a.ts#foo', { sameFile: false })],
  });
  writeLayer(cache, 'usages', {
    nodes: [symNode('src/b.ts', 'useX', true), symNode('src/a.ts', 'foo', true)],
    edges: [edge('USES', 'sym:src/b.ts#useX', 'sym:src/a.ts#foo')],
  });
  writeLayer(cache, 'domains', {
    nodes: [{ id: 'domain:core', labels: ['Domain'], properties: { name: 'core', kind: 'product' } }],
    edges: [edge('BELONGS_TO', 'file:src/a.ts', 'domain:core'), edge('BELONGS_TO', 'file:src/b.ts', 'domain:core')],
  });
  return cache;
}

let tmp;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cg-explorer-run-')); });

describe('explorer run()', () => {
  it('builds graph-index.json into <cache>/explorer/ and exits 0', async () => {
    const cache = seedCache(join(tmp, 'base'));
    const code = await run(['--cache', cache]);
    expect(code).toBe(0);

    const outPath = join(cache, 'explorer', 'graph-index.json');
    expect(existsSync(outPath)).toBe(true);

    // The SPA is copied verbatim next to the index so --serve hosts both.
    const htmlPath = join(cache, 'explorer', 'index.html');
    expect(existsSync(htmlPath)).toBe(true);
    expect(readFileSync(htmlPath, 'utf8')).toBe(readFileSync(SPA_HTML, 'utf8'));

    const idx = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(idx.stats).toEqual({ files: 2, symbols: 2, packages: 1, domains: 1, edges: expect.any(Number) });
    expect(idx.meta.project).toBe('demo');
    expect(idx.meta.snapshot).toBe('snapshot:demo:rev1');
    expect(idx.meta.layersPresent).toEqual(['inventory', 'imports', 'symbols', 'references', 'usages', 'domains']);
    expect(idx.insights.mostDependedPackages).toEqual([{ name: 'react', files: 1 }]);
    expect(idx.insights.biggestImporters).toEqual([{ file: 'src/b.ts', imports: 1 }]);
    expect(idx.insights.mostUsedSymbols[0]).toMatchObject({ id: 'sym:src/a.ts#foo', files: 1 });
  });

  it('copies a self-contained i18n SPA (translations + ru, no external URLs)', async () => {
    const cache = seedCache(join(tmp, 'spa'));
    expect(await run(['--cache', cache])).toBe(0);
    const html = readFileSync(join(cache, 'explorer', 'index.html'), 'utf8');
    expect(html.length).toBeGreaterThan(1000);
    expect(/translations\s*=/.test(html)).toBe(true);
    expect(/\bru:\s*\{/.test(html)).toBe(true);
    // No external/CDN fetches — the only http(s) token is the SVG namespace URI.
    const urls = html.match(/https?:\/\/[^\s"')]+/g) || [];
    expect(urls.every((u) => u === 'http://www.w3.org/2000/svg')).toBe(true);
  });

  it('defaults the cache to --out (outDir) when --cache is omitted', async () => {
    const cache = seedCache(join(tmp, 'viaout'));
    const code = await run(['--out', cache]);
    expect(code).toBe(0);
    expect(existsSync(join(cache, 'explorer', 'graph-index.json'))).toBe(true);
  });

  it('is deterministic except for meta.generatedAt', async () => {
    const cache = seedCache(join(tmp, 'det'));
    const outPath = join(cache, 'explorer', 'graph-index.json');
    await run(['--cache', cache]);
    const first = JSON.parse(readFileSync(outPath, 'utf8'));
    await run(['--cache', cache]);
    const second = JSON.parse(readFileSync(outPath, 'utf8'));
    delete first.meta.generatedAt;
    delete second.meta.generatedAt;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('missing cache dir → exit 2', async () => {
    const code = await run(['--cache', join(tmp, 'does-not-exist')]);
    expect(code).toBe(2);
  });

  it('cache with no layers → exit 2', async () => {
    const empty = join(tmp, 'empty');
    mkdirSync(empty, { recursive: true });
    const code = await run(['--cache', empty]);
    expect(code).toBe(2);
  });

  it('bad --port → exit 2', async () => {
    const cache = seedCache(join(tmp, 'port'));
    const code = await run(['--cache', cache, '--serve', '--port', 'abc']);
    expect(code).toBe(2);
  });
});
