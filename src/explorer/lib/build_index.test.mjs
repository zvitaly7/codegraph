import { describe, it, expect } from 'vitest';
import { buildIndex } from './build_index.mjs';

// ---- synthetic-graph builders -------------------------------------------

function fileNode(path) {
  return {
    id: `file:${path}`,
    labels: ['File'],
    properties: { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'code', language: 'TypeScript' },
  };
}
function symNode(path, name, { exported = false, kind = 'function' } = {}) {
  return { id: `sym:${path}#${name}`, labels: ['Symbol'], properties: { name, kind, exported, path, line: 1 } };
}
function pkgNode(name) {
  return { id: `pkg:${name}`, labels: ['Package'], properties: { name } };
}
function domainNode(id, kind) {
  return { id: `domain:${id}`, labels: ['Domain'], properties: { name: id, kind } };
}
function edge(type, from, to, properties = {}) {
  return { id: `edge:${from}:${type}:${to}`, type, from, to, properties };
}

/** A small graph exercising every insight. */
function sampleGraph() {
  const nodes = [
    fileNode('src/a.ts'),
    fileNode('src/b.ts'),
    fileNode('src/c.ts'),
    symNode('src/a.ts', 'foo', { exported: true }),
    symNode('src/a.ts', 'deadFn', { exported: true }),
    symNode('src/b.ts', 'useThing', { exported: true }),
    symNode('src/b.ts', 'helper', { exported: false }),
    symNode('src/c.ts', 'Widget', { exported: true, kind: 'variable' }),
    pkgNode('react'),
    pkgNode('lodash'),
    domainNode('core', 'product'),
    domainNode('ui', 'product'),
    domainNode('infra', 'infra'),
    // A structural node that must be dropped from the output.
    { id: 'dir:src', labels: ['Directory'], properties: { path: 'src' } },
  ];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const edges = [
    // internal imports → biggestImporters (c:2, b:1, a:0)
    edge('IMPORTS', 'file:src/b.ts', 'file:src/a.ts', { kind: 'internal' }),
    edge('IMPORTS', 'file:src/c.ts', 'file:src/a.ts', { kind: 'internal' }),
    edge('IMPORTS', 'file:src/c.ts', 'file:src/b.ts', { kind: 'internal' }),
    // external imports → mostDependedPackages (react:2, lodash:1)
    edge('IMPORTS', 'file:src/a.ts', 'pkg:react', { kind: 'external' }),
    edge('IMPORTS', 'file:src/b.ts', 'pkg:react', { kind: 'external' }),
    edge('IMPORTS', 'file:src/a.ts', 'pkg:lodash', { kind: 'external' }),
    // declarations
    edge('DECLARES', 'file:src/a.ts', 'sym:src/a.ts#foo', { kind: 'function' }),
    edge('DECLARES', 'file:src/a.ts', 'sym:src/a.ts#deadFn', { kind: 'function' }),
    edge('DECLARES', 'file:src/b.ts', 'sym:src/b.ts#useThing', { kind: 'function' }),
    edge('DECLARES', 'file:src/b.ts', 'sym:src/b.ts#helper', { kind: 'function' }),
    edge('DECLARES', 'file:src/c.ts', 'sym:src/c.ts#Widget', { kind: 'variable' }),
    // references (sameFile flags drive mostUsedSymbols + deadExports)
    edge('REFERENCES', 'file:src/b.ts', 'sym:src/a.ts#foo', { sameFile: false }),
    edge('REFERENCES', 'file:src/a.ts', 'sym:src/a.ts#foo', { sameFile: true }),
    edge('REFERENCES', 'file:src/c.ts', 'sym:src/b.ts#useThing', { sameFile: false }),
    edge('REFERENCES', 'file:src/a.ts', 'sym:src/c.ts#Widget', { sameFile: false }),
    edge('REFERENCES', 'file:src/b.ts', 'sym:src/b.ts#helper', { sameFile: true }),
    edge('REFERENCES', 'file:src/a.ts', 'sym:src/a.ts#deadFn', { sameFile: true }), // same-file only → dead
    // usages → mostConnectedSymbols (foo degree 3)
    edge('USES', 'sym:src/b.ts#useThing', 'sym:src/a.ts#foo'),
    edge('USES', 'sym:src/c.ts#Widget', 'sym:src/a.ts#foo'),
    edge('USES', 'sym:src/a.ts#foo', 'sym:src/b.ts#helper'),
    // belongs-to → biggestDomains (core:2, ui:1)
    edge('BELONGS_TO', 'file:src/a.ts', 'domain:core'),
    edge('BELONGS_TO', 'file:src/b.ts', 'domain:core'),
    edge('BELONGS_TO', 'file:src/c.ts', 'domain:ui'),
    // depends-on → productMap (product↔product only)
    edge('DEPENDS_ON', 'domain:core', 'domain:ui', { weight: 3 }),
    edge('DEPENDS_ON', 'domain:ui', 'domain:core', { weight: 1 }),
    edge('DEPENDS_ON', 'domain:core', 'domain:infra', { weight: 5 }), // infra → excluded
    // a structural edge that must NOT enter the index
    edge('CONTAINS', 'dir:src', 'file:src/a.ts'),
  ];

  const manifest = {
    projectId: 'project:demo',
    snapshotId: 'snapshot:demo:rev1',
    generatedAt: '2020-01-01T00:00:00.000Z',
  };
  return {
    nodesById,
    edges,
    loadedLayers: ['inventory', 'imports', 'symbols', 'references', 'usages', 'domains'],
    manifest,
  };
}

const FIXED = { generatedAt: '2020-06-01T00:00:00.000Z' };

describe('buildIndex — stats & meta', () => {
  it('counts nodes by kind and only semantic edges', () => {
    const idx = buildIndex(sampleGraph(), FIXED);
    expect(idx.stats).toEqual({ files: 3, symbols: 5, packages: 2, domains: 3, edges: 26 });
  });

  it('derives project / snapshot from the manifest and lists layers', () => {
    const idx = buildIndex(sampleGraph(), FIXED);
    expect(idx.meta.project).toBe('demo');
    expect(idx.meta.snapshot).toBe('snapshot:demo:rev1');
    expect(idx.meta.generatedAt).toBe('2020-06-01T00:00:00.000Z');
    expect(idx.meta.layersPresent).toContain('references');
    expect(idx.meta.notes).toEqual([]);
  });

  it('falls back to manifest.generatedAt when no override is given', () => {
    const idx = buildIndex(sampleGraph());
    expect(idx.meta.generatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('omits meta.staleness unless a staleness result is supplied', () => {
    const idx = buildIndex(sampleGraph(), FIXED);
    expect(idx.meta.staleness).toBeUndefined();
  });

  it('embeds only the {stale, cacheRevision, currentRevision, reason} fields of staleness', () => {
    const staleness = {
      hasCache: true, stale: true, reason: 'revision-changed',
      cacheRevision: 'aaaa', currentRevision: 'bbbb',
    };
    const idx = buildIndex(sampleGraph(), { ...FIXED, staleness });
    expect(idx.meta.staleness).toEqual({
      stale: true, cacheRevision: 'aaaa', currentRevision: 'bbbb', reason: 'revision-changed',
    });
    // `hasCache` is an internal field and must not leak into the index.
    expect(idx.meta.staleness).not.toHaveProperty('hasCache');
  });

  it('normalizes missing staleness revisions to null', () => {
    const staleness = { hasCache: false, stale: true, reason: 'no-cache' };
    const idx = buildIndex(sampleGraph(), { ...FIXED, staleness });
    expect(idx.meta.staleness).toEqual({
      stale: true, cacheRevision: null, currentRevision: null, reason: 'no-cache',
    });
  });
});

describe('buildIndex — nodes & edges', () => {
  it('emits only file/symbol/package/domain nodes (structural dropped)', () => {
    const idx = buildIndex(sampleGraph(), FIXED);
    const types = new Set(idx.nodes.map((n) => n.type));
    expect([...types].sort()).toEqual(['domain', 'file', 'package', 'symbol']);
    expect(idx.nodes.find((n) => n.id === 'dir:src')).toBeUndefined();
  });

  it('attaches path/kind/domainId to file nodes', () => {
    const idx = buildIndex(sampleGraph(), FIXED);
    const a = idx.nodes.find((n) => n.id === 'file:src/a.ts');
    expect(a).toMatchObject({ type: 'file', name: 'a.ts', path: 'src/a.ts', kind: 'code', domainId: 'domain:core' });
  });

  it('marks exported symbols', () => {
    const idx = buildIndex(sampleGraph(), FIXED);
    const foo = idx.nodes.find((n) => n.id === 'sym:src/a.ts#foo');
    expect(foo).toMatchObject({ type: 'symbol', name: 'foo', exported: true });
  });

  it('drops structural edge types, keeps the six semantic relations', () => {
    const idx = buildIndex(sampleGraph(), FIXED);
    const kinds = new Set(idx.edges.map((e) => e.type));
    expect([...kinds].sort()).toEqual(['BELONGS_TO', 'DECLARES', 'DEPENDS_ON', 'IMPORTS', 'REFERENCES', 'USES']);
    // DEPENDS_ON keeps its weight.
    const dep = idx.edges.find((e) => e.type === 'DEPENDS_ON' && e.from === 'domain:core' && e.to === 'domain:ui');
    expect(dep.weight).toBe(3);
  });
});

describe('buildIndex — insights', () => {
  it('productMap ranks product→product DEPENDS_ON by weight desc (infra excluded)', () => {
    const { productMap } = buildIndex(sampleGraph(), FIXED).insights;
    expect(productMap).toEqual([
      { from: 'domain:core', to: 'domain:ui', fromName: 'core', toName: 'ui', weight: 3 },
      { from: 'domain:ui', to: 'domain:core', fromName: 'ui', toName: 'core', weight: 1 },
    ]);
  });

  it('biggestDomains ranks by BELONGS_TO in-degree', () => {
    const { biggestDomains } = buildIndex(sampleGraph(), FIXED).insights;
    expect(biggestDomains).toEqual([
      { id: 'domain:core', name: 'core', kind: 'product', files: 2 },
      { id: 'domain:ui', name: 'ui', kind: 'product', files: 1 },
      { id: 'domain:infra', name: 'infra', kind: 'infra', files: 0 },
    ]);
  });

  it('mostUsedSymbols ranks by distinct referencing files (REFERENCES in-degree)', () => {
    const { mostUsedSymbols } = buildIndex(sampleGraph(), FIXED).insights;
    expect(mostUsedSymbols[0]).toEqual({ id: 'sym:src/a.ts#foo', name: 'foo', kind: 'function', files: 2 });
    // foo (2 files) outranks the singles; ties broken by id ascending.
    expect(mostUsedSymbols.map((s) => s.id)).toEqual([
      'sym:src/a.ts#foo',
      'sym:src/a.ts#deadFn',
      'sym:src/b.ts#helper',
      'sym:src/b.ts#useThing',
      'sym:src/c.ts#Widget',
    ]);
  });

  it('mostConnectedSymbols ranks by total USES degree (in+out)', () => {
    const { mostConnectedSymbols } = buildIndex(sampleGraph(), FIXED).insights;
    expect(mostConnectedSymbols[0]).toEqual({ id: 'sym:src/a.ts#foo', name: 'foo', kind: 'function', degree: 3 });
  });

  it('hooks match /^use[A-Z]/ ranked by referencing files', () => {
    const { hooks } = buildIndex(sampleGraph(), FIXED).insights;
    expect(hooks).toEqual([{ id: 'sym:src/b.ts#useThing', name: 'useThing', files: 1 }]);
  });

  it('components match PascalCase ranked by referencing files', () => {
    const { components } = buildIndex(sampleGraph(), FIXED).insights;
    expect(components).toEqual([{ id: 'sym:src/c.ts#Widget', name: 'Widget', files: 1 }]);
  });

  it('deadExports = exported symbols with zero cross-file references', () => {
    const { deadExports, deadExportsTotal, deadExportsEntryPoints } = buildIndex(sampleGraph(), FIXED).insights;
    expect(deadExports).toEqual([{ id: 'sym:src/a.ts#deadFn', name: 'deadFn', kind: 'function' }]);
    expect(deadExportsTotal).toBe(1);
    expect(deadExportsEntryPoints).toBe(0);
  });

  it('deadExports skips symbols declared in an entry-point file, and counts the exclusion', () => {
    const g = sampleGraph();
    g.nodesById.get('file:src/a.ts').properties.entryPoint = true;
    const { deadExports, deadExportsTotal, deadExportsEntryPoints } = buildIndex(g, FIXED).insights;
    expect(deadExports).toEqual([]);
    expect(deadExportsTotal).toBe(0);
    expect(deadExportsEntryPoints).toBe(1);
  });

  it('deadExports skips a symbol an entry point EXPOSES through a re-export chain', () => {
    // src/b.ts is the entry point and re-exports src/a.ts#deadFn, so deadFn is
    // public API rather than dead — and the exclusion is still counted.
    const g = sampleGraph();
    g.nodesById.get('file:src/b.ts').properties.entryPoint = true;
    g.edges.push(edge('EXPOSES', 'file:src/b.ts', 'sym:src/a.ts#deadFn', { hops: 1 }));
    const { deadExports, deadExportsTotal, deadExportsEntryPoints } = buildIndex(g, FIXED).insights;
    expect(deadExports).toEqual([]);
    expect(deadExportsTotal).toBe(0);
    expect(deadExportsEntryPoints).toBe(1);
  });

  it('an EXPOSES edge never enters the index edge list or the edge count', () => {
    const g = sampleGraph();
    g.edges.push(edge('EXPOSES', 'file:src/b.ts', 'sym:src/a.ts#deadFn', { hops: 1 }));
    const idx = buildIndex(g, FIXED);
    expect(idx.stats.edges).toBe(26);
    expect(idx.edges.some((e) => e.type === 'EXPOSES')).toBe(false);
  });

  it('cycles counts circular dependencies and samples them for the card', () => {
    const { cycles, cyclesTotal, fileCyclesTotal, domainCyclesTotal } = buildIndex(sampleGraph(), FIXED).insights;
    // The fixture is acyclic on files, but core ↔ ui is a domain cycle.
    expect(fileCyclesTotal).toBe(0);
    expect(domainCyclesTotal).toBe(1);
    expect(cyclesTotal).toBe(1);
    expect(cycles).toEqual([{
      scope: 'domain', id: 'domain:core', members: ['core', 'ui'], length: 2, weight: 4,
    }]);
  });

  it('cycles picks up file import cycles too', () => {
    const g = sampleGraph();
    g.edges.push(edge('IMPORTS', 'file:src/a.ts', 'file:src/b.ts', { kind: 'internal' }));
    const { cycles, fileCyclesTotal, cyclesTotal } = buildIndex(g, FIXED).insights;
    expect(fileCyclesTotal).toBe(1);
    expect(cyclesTotal).toBe(2);
    expect(cycles[0]).toEqual({
      scope: 'file', id: 'file:src/a.ts', members: ['src/a.ts', 'src/b.ts'], length: 2,
    });
  });

  it('mostDependedPackages ranks external packages by importing files', () => {
    const { mostDependedPackages } = buildIndex(sampleGraph(), FIXED).insights;
    expect(mostDependedPackages).toEqual([
      { name: 'react', files: 2 },
      { name: 'lodash', files: 1 },
    ]);
  });

  it('biggestImporters ranks files by internal IMPORTS out-degree', () => {
    const { biggestImporters } = buildIndex(sampleGraph(), FIXED).insights;
    expect(biggestImporters).toEqual([
      { file: 'src/c.ts', imports: 2 },
      { file: 'src/b.ts', imports: 1 },
    ]);
  });

  it('respects per-insight limits', () => {
    const idx = buildIndex(sampleGraph(), { ...FIXED, limits: { mostUsedSymbols: 1 } });
    expect(idx.insights.mostUsedSymbols).toHaveLength(1);
    expect(idx.insights.mostUsedSymbols[0].id).toBe('sym:src/a.ts#foo');
  });
});

describe('buildIndex — determinism & graceful degradation', () => {
  it('is a pure function (identical output for identical input)', () => {
    const a = JSON.stringify(buildIndex(sampleGraph(), FIXED));
    const b = JSON.stringify(buildIndex(sampleGraph(), FIXED));
    expect(a).toBe(b);
  });

  it('carries model-written descriptions in their own map, never inside nodes', () => {
    const rows = {
      'domain:core': {
        kind: 'domain',
        text: 'Shared primitives.',
        model: 'fake-model',
        provider: 'command',
        generatedAt: '2026-08-17T09:00:00.000Z',
      },
    };
    const idx = buildIndex(sampleGraph(), { ...FIXED, descriptions: { get: (id) => rows[id] } });
    expect(idx.descriptions['domain:core']).toEqual({
      generated: true,
      text: 'Shared primitives.',
      model: 'fake-model',
      provider: 'command',
      generatedAt: '2026-08-17T09:00:00.000Z',
    });
    // The node itself stays exactly what the graph proved.
    expect(idx.nodes.find((n) => n.id === 'domain:core').description).toBeUndefined();
    expect(JSON.stringify(idx.nodes)).not.toContain('Shared primitives');
  });

  it('emits an empty descriptions map when none were generated', () => {
    expect(buildIndex(sampleGraph(), FIXED).descriptions).toEqual({});
  });

  it('emits layer-independent insights and empties dependent ones when layers are missing', () => {
    // Only inventory + imports + domains present: no references, no usages.
    const g = sampleGraph();
    g.loadedLayers = ['inventory', 'imports', 'domains'];
    // Drop the reference/usage edges so the graph matches the declared layers.
    g.edges = g.edges.filter((e) => e.type !== 'REFERENCES' && e.type !== 'USES');
    const idx = buildIndex(g, FIXED);

    // Dependent insights degrade to empty.
    expect(idx.insights.mostUsedSymbols).toEqual([]);
    expect(idx.insights.mostConnectedSymbols).toEqual([]);
    expect(idx.insights.hooks).toEqual([]);
    expect(idx.insights.components).toEqual([]);
    expect(idx.insights.deadExports).toEqual([]);
    expect(idx.insights.deadExportsTotal).toBe(0);
    expect(idx.insights.deadExportsEntryPoints).toBe(0);

    // Layer-independent insights still populated.
    expect(idx.insights.productMap.length).toBeGreaterThan(0);
    expect(idx.insights.biggestDomains.length).toBeGreaterThan(0);
    expect(idx.insights.mostDependedPackages.length).toBeGreaterThan(0);
    expect(idx.insights.biggestImporters.length).toBeGreaterThan(0);

    // Notes explain the empty cards.
    expect(idx.meta.notes.some((n) => n.startsWith('references layer absent'))).toBe(true);
    expect(idx.meta.notes.some((n) => n.startsWith('usages layer absent'))).toBe(true);
  });

  it('empty graph yields zeroed stats and empty insights', () => {
    const idx = buildIndex({ nodesById: new Map(), edges: [], loadedLayers: [], manifest: null }, FIXED);
    expect(idx.stats).toEqual({ files: 0, symbols: 0, packages: 0, domains: 0, edges: 0 });
    expect(idx.nodes).toEqual([]);
    expect(idx.insights.deadExportsTotal).toBe(0);
    expect(idx.meta.project).toBeNull();
  });
});

// The dead-exports card is the one place in the explorer someone might act on by
// deleting code. It carries the count of import sites nothing static can follow.
describe('computed dynamic imports', () => {
  it('totals them from the File nodes into the insights', () => {
    const g = sampleGraph();
    g.nodesById.get('file:src/a.ts').properties.computedDynamicImports = 2;
    g.nodesById.get('file:src/b.ts').properties.computedDynamicImports = 1;

    expect(buildIndex(g, FIXED).insights.computedDynamicImports).toEqual({ total: 3, files: 2 });
  });

  it('reports zero on a repo with none', () => {
    expect(buildIndex(sampleGraph(), FIXED).insights.computedDynamicImports)
      .toEqual({ total: 0, files: 0 });
  });
});
