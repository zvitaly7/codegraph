import { describe, it, expect } from 'vitest';
import { buildGraph } from './graph_builder.mjs';

const REPO = '/repo';
const NO_TS_INDEX = { forFile: () => ({ paths: {}, pathsBase: undefined }) };

function file(path, specifiers) {
  return { path, absPath: `${REPO}/${path}`, specifiers };
}

function build(files, tsconfigIndex = NO_TS_INDEX) {
  return buildGraph({ files, repoRoot: REPO, tsconfigIndex });
}

describe('buildGraph nodes/edges/counts', () => {
  it('emits File nodes, Package nodes and IMPORTS edges', () => {
    const g = build([
      file('src/a.ts', ['./b', 'react', './missing']),
      file('src/b.ts', []),
    ]);

    expect(g.nodes).toContainEqual({ id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts' } });
    expect(g.nodes).toContainEqual({ id: 'file:src/b.ts', labels: ['File'], properties: { path: 'src/b.ts' } });
    expect(g.nodes).toContainEqual({ id: 'pkg:react', labels: ['Package'], properties: { name: 'react', scope: null } });

    expect(g.edges).toContainEqual({
      id: 'edge:file:src/a.ts:IMPORTS:file:src/b.ts',
      type: 'IMPORTS', from: 'file:src/a.ts', to: 'file:src/b.ts',
      properties: { specifier: './b', kind: 'internal' },
    });
    expect(g.edges).toContainEqual({
      id: 'edge:file:src/a.ts:IMPORTS:pkg:react',
      type: 'IMPORTS', from: 'file:src/a.ts', to: 'pkg:react',
      properties: { specifier: 'react', kind: 'external' },
    });

    expect(g.counts).toEqual({
      files: 2, packages: 1, edges: 2, internal: 1, external: 1, unresolved: 1,
      unresolvedPackages: {}, computedDynamicImports: 0,
    });
  });

  it('totals computed dynamic imports and puts the per-file count on the File node', () => {
    const g = buildGraph({
      files: [
        { path: 'src/a.ts', absPath: `${REPO}/src/a.ts`, specifiers: [], computedDynamicImports: 2 },
        { path: 'src/b.ts', absPath: `${REPO}/src/b.ts`, specifiers: [], computedDynamicImports: 0 },
      ],
      repoRoot: REPO,
      tsconfigIndex: NO_TS_INDEX,
    });

    expect(g.counts.computedDynamicImports).toBe(2);
    expect(g.computedDynamicImportFiles).toEqual([{ path: 'src/a.ts', count: 2 }]);
    expect(g.nodes).toContainEqual({
      id: 'file:src/a.ts',
      labels: ['File'],
      properties: { path: 'src/a.ts', computedDynamicImports: 2 },
    });
    // A file with none keeps exactly the node it always had.
    expect(g.nodes).toContainEqual({
      id: 'file:src/b.ts', labels: ['File'], properties: { path: 'src/b.ts' },
    });
  });

  it('records the scope of scoped packages', () => {
    const g = build([file('a.ts', ['@scope/pkg/sub'])]);
    expect(g.nodes).toContainEqual({
      id: 'pkg:@scope/pkg', labels: ['Package'], properties: { name: '@scope/pkg', scope: '@scope' },
    });
  });
});

describe('deduplication', () => {
  it('collapses two specifiers pointing at the same source into one edge', () => {
    const g = build([
      file('src/a.ts', ['./b', './b.ts']),
      file('src/b.ts', []),
    ]);
    const aToB = g.edges.filter((e) => e.from === 'file:src/a.ts' && e.to === 'file:src/b.ts');
    expect(aToB).toHaveLength(1);
    expect(g.counts.edges).toBe(1);
    expect(g.counts.internal).toBe(2); // both specifiers counted as occurrences
  });

  it('collapses many subpaths of one package into a single Package node + edge', () => {
    const g = build([file('src/a.ts', ['lodash/fp', 'lodash/map', 'lodash'])]);
    expect(g.nodes.filter((n) => n.id.startsWith('pkg:'))).toHaveLength(1);
    expect(g.edges).toHaveLength(1);
    expect(g.counts.external).toBe(3);
    expect(g.counts.packages).toBe(1);
  });

  it('a package imported by two files yields one node and two edges', () => {
    const g = build([
      file('src/a.ts', ['react']),
      file('src/b.ts', ['react']),
    ]);
    expect(g.nodes.filter((n) => n.id === 'pkg:react')).toHaveLength(1);
    expect(g.edges).toHaveLength(2);
  });
});

describe('determinism / ordering', () => {
  it('sorts nodes and edges by id and is byte-stable across runs', () => {
    const files = [
      file('src/z.ts', ['react', './a']),
      file('src/a.ts', ['@scope/x', './z']),
    ];
    const a = build(files);
    const b = build([...files].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const nodeIds = a.nodes.map((n) => n.id);
    expect(nodeIds).toEqual([...nodeIds].sort());
    const edgeIds = a.edges.map((e) => e.id);
    expect(edgeIds).toEqual([...edgeIds].sort());
  });
});

describe('tsconfig alias integration', () => {
  it('uses the per-file tsconfig to resolve aliases', () => {
    const index = { forFile: () => ({ paths: { '@app/*': ['src/app/*'] }, pathsBase: REPO }) };
    const g = build([
      file('src/entry.ts', ['@app/util']),
      file('src/app/util.ts', []),
    ], index);
    expect(g.edges).toContainEqual({
      id: 'edge:file:src/entry.ts:IMPORTS:file:src/app/util.ts',
      type: 'IMPORTS', from: 'file:src/entry.ts', to: 'file:src/app/util.ts',
      properties: { specifier: '@app/util', kind: 'internal' },
    });
    expect(g.counts.internal).toBe(1);
  });
});

// A count of unresolved imports is a number nobody can act on. The names behind
// it are the actionable part: they say which packages the graph is missing, and
// therefore which mappings would bring those dependencies back.
describe('unresolved workspace packages are reported by name', () => {
  const ws = new Map([
    ['@myorg/ui', { name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/dist/index.js'], subpaths: {} }],
    ['@myorg/core', { name: '@myorg/core', dir: 'packages/core', entries: ['packages/core/dist/index.js'], subpaths: {} }],
  ]);

  function buildWs(files) {
    return buildGraph({ files, repoRoot: REPO, tsconfigIndex: NO_TS_INDEX, workspaces: ws });
  }

  it('counts the imports behind each package that could not be reached', () => {
    const g = buildWs([
      file('apps/a/src/main.ts', ['@myorg/ui', '@myorg/ui/button', '@myorg/core']),
      file('apps/b/src/main.ts', ['@myorg/ui', 'react']),
    ]);
    expect(g.counts.unresolvedPackages).toEqual({ '@myorg/ui': 3, '@myorg/core': 1 });
  });

  it('says nothing when every workspace package resolves', () => {
    const okWs = new Map([
      ['@myorg/ui', { name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/src/index.ts'], subpaths: {} }],
    ]);
    const g = buildGraph({
      files: [file('apps/a/src/main.ts', ['@myorg/ui']), file('packages/ui/src/index.ts', [])],
      repoRoot: REPO,
      tsconfigIndex: NO_TS_INDEX,
      workspaces: okWs,
    });
    expect(g.counts.unresolvedPackages).toEqual({});
  });

  it('a genuine third party is never listed as one of ours', () => {
    const g = buildWs([file('apps/a/src/main.ts', ['react', 'lodash'])]);
    expect(g.counts.unresolvedPackages).toEqual({});
  });
});
