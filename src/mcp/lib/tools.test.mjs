import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../../lib/graph_load.mjs';
import {
  findNode, nodeInfo, importsOf, importedBy, impactOf, pathBetween,
  listSymbols, deadExports, domainOf, domainDependencies, domainCrossings,
  brief, impact, outline, show, describe as describeTool, cycles as cyclesTool,
  callTool, TOOLS, TOOL_NAMES,
} from './tools.mjs';
import { writeDescriptions } from '../../describe/lib/store.mjs';

function writeLayer(cache, layer, { nodes = [], edges = [] }) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

const fileNode = (path, extra = {}) => ({ id: `file:${path}`, labels: ['File'], properties: { path, name: path.split('/').pop(), ...extra } });
const imp = (from, to, kind, specifier) => ({ id: `edge:file:${from}:IMPORTS:${to}`, type: 'IMPORTS', from: `file:${from}`, to, properties: { kind, specifier } });
const sym = (path, name, exported) => ({ id: `sym:${path}#${name}`, labels: ['Symbol'], properties: { name, kind: 'function', exported, path, line: 1 } });
const decl = (path, name) => ({ id: `edge:file:${path}:DECLARES:sym:${path}#${name}`, type: 'DECLARES', from: `file:${path}`, to: `sym:${path}#${name}`, properties: { kind: 'function' } });
const domainNode = (id, kind = 'product') => ({ id: `domain:${id}`, labels: ['Domain'], properties: { name: id, kind } });
const belongs = (path, d) => ({ id: `edge:file:${path}:BELONGS_TO:domain:${d}`, type: 'BELONGS_TO', from: `file:${path}`, to: `domain:${d}`, properties: {} });
const dependsOn = (a, b, weight) => ({ id: `edge:domain:${a}:DEPENDS_ON:domain:${b}`, type: 'DEPENDS_ON', from: `domain:${a}`, to: `domain:${b}`, properties: { weight } });

/**
 * Synthetic 4-layer graph:
 *   ui/button.tsx ─imports→ core/index.ts ─imports→ core/util.ts
 *   checkout/pay.ts ─imports→ core/index.ts, ─imports→ pkg:react
 * Domains: core, checkout, ui. checkout→core (w1), ui→core (w1).
 */
function buildGraph() {
  const cache = mkdtempSync(join(tmpdir(), 'cg-mcp-tools-'));
  writeLayer(cache, 'inventory', {
    nodes: [
      fileNode('src/core/index.ts', { language: 'TypeScript' }),
      fileNode('src/core/util.ts', { language: 'TypeScript' }),
      fileNode('src/checkout/pay.ts', { language: 'TypeScript' }),
      fileNode('src/ui/button.tsx', { language: 'TypeScript' }),
    ],
  });
  writeLayer(cache, 'imports', {
    nodes: [{ id: 'pkg:react', labels: ['Package'], properties: { name: 'react', scope: null } }],
    edges: [
      imp('src/checkout/pay.ts', 'file:src/core/index.ts', 'internal', '../core'),
      imp('src/checkout/pay.ts', 'pkg:react', 'external', 'react'),
      imp('src/core/index.ts', 'file:src/core/util.ts', 'internal', './util'),
      imp('src/ui/button.tsx', 'file:src/core/index.ts', 'internal', '../core'),
    ],
  });
  writeLayer(cache, 'symbols', {
    nodes: [
      sym('src/core/index.ts', 'setup', true),
      sym('src/core/index.ts', 'helper', false),
      sym('src/core/util.ts', 'format', true),
      sym('src/checkout/pay.ts', 'pay', true),
    ],
    edges: [
      decl('src/core/index.ts', 'setup'),
      decl('src/core/index.ts', 'helper'),
      decl('src/core/util.ts', 'format'),
      decl('src/checkout/pay.ts', 'pay'),
    ],
  });
  writeLayer(cache, 'domains', {
    nodes: [domainNode('core'), domainNode('checkout'), domainNode('ui')],
    edges: [
      belongs('src/core/index.ts', 'core'),
      belongs('src/core/util.ts', 'core'),
      belongs('src/checkout/pay.ts', 'checkout'),
      belongs('src/ui/button.tsx', 'ui'),
      dependsOn('checkout', 'core', 1),
      dependsOn('ui', 'core', 1),
    ],
  });
  return loadGraph(cache);
}

let g;
beforeEach(() => { g = buildGraph(); });

describe('find_node', () => {
  it('matches id, path, and name substrings (case-insensitive)', () => {
    const r = findNode(g, { query: 'core/util.ts' });
    const ids = r.results.map((n) => n.id);
    expect(ids).toContain('file:src/core/util.ts');
    expect(ids).toContain('sym:src/core/util.ts#format');
    expect(findNode(g, { query: 'BUTTON' }).results.map((n) => n.id)).toContain('file:src/ui/button.tsx');
  });
  it('reports total and honors the limit cap', () => {
    const r = findNode(g, { query: 'src/', limit: 2 });
    expect(r.total).toBeGreaterThan(2);
    expect(r.returned).toBe(2);
    expect(r.truncated).toBe(true);
  });
  it('rejects an empty query', () => {
    expect(findNode(g, { query: '' }).error).toBeTruthy();
  });
});

describe('node_info', () => {
  it('groups immediate in/out edges by type and accepts a bare path', () => {
    const r = nodeInfo(g, { id: 'src/core/index.ts' });
    expect(r.found).toBe(true);
    expect(Object.keys(r.outEdges).sort()).toEqual(['BELONGS_TO', 'DECLARES', 'IMPORTS']);
    expect(r.inEdges.IMPORTS.map((e) => e.from).sort()).toEqual(['file:src/checkout/pay.ts', 'file:src/ui/button.tsx']);
    expect(r.counts.out).toBe(4); // 1 IMPORTS + 2 DECLARES + 1 BELONGS_TO
  });
  it('reports not found for an unknown id', () => {
    expect(nodeInfo(g, { id: 'file:nope' }).found).toBe(false);
  });
});

describe('imports_of / imported_by', () => {
  it('lists direct imports (files + packages) with kind', () => {
    const r = importsOf(g, { file: 'src/checkout/pay.ts' });
    expect(r.count).toBe(2);
    expect(r.imports).toContainEqual({ to: 'file:src/core/index.ts', kind: 'internal', specifier: '../core' });
    expect(r.imports).toContainEqual({ to: 'pkg:react', kind: 'external', specifier: 'react' });
  });
  it('lists direct importers of a file', () => {
    const r = importedBy(g, { file: 'file:src/core/index.ts' });
    expect(r.importedBy).toEqual(['file:src/checkout/pay.ts', 'file:src/ui/button.tsx']);
  });
  it('marks a missing file not found but does not error', () => {
    const r = importsOf(g, { file: 'src/ghost.ts' });
    expect(r.found).toBe(false);
    expect(r.count).toBe(0);
  });
});

describe('impact_of', () => {
  it('computes the transitive dependent closure', () => {
    const r = impactOf(g, { file: 'src/core/util.ts' });
    expect(r.count).toBe(3);
    expect(r.impacted).toEqual(['file:src/checkout/pay.ts', 'file:src/core/index.ts', 'file:src/ui/button.tsx']);
  });
  it('honors the depth cap', () => {
    const r = impactOf(g, { file: 'src/core/util.ts', maxDepth: 1 });
    expect(r.impacted).toEqual(['file:src/core/index.ts']); // only direct importer at depth 1
    expect(r.depthCapReached).toBe(true);
  });
});

describe('path_between', () => {
  it('finds the shortest directed path', () => {
    const r = pathBetween(g, { from: 'src/checkout/pay.ts', to: 'src/core/util.ts' });
    expect(r.found).toBe(true);
    expect(r.nodes).toEqual(['file:src/checkout/pay.ts', 'file:src/core/index.ts', 'file:src/core/util.ts']);
    expect(r.length).toBe(2);
  });
  it('returns length 0 for identical endpoints', () => {
    expect(pathBetween(g, { from: 'src/core/util.ts', to: 'src/core/util.ts' }).length).toBe(0);
  });
  it('returns null path when unreachable (wrong direction)', () => {
    const r = pathBetween(g, { from: 'src/core/util.ts', to: 'src/checkout/pay.ts' });
    expect(r.path).toBeNull();
  });
  it('reports unknown endpoints', () => {
    expect(pathBetween(g, { from: 'src/core/util.ts', to: 'ghost' }).found).toBe(false);
  });
});

describe('list_symbols', () => {
  it('lists declared symbols with export flags', () => {
    const r = listSymbols(g, { file: 'src/core/index.ts' });
    expect(r.symbols.map((s) => s.name).sort()).toEqual(['helper', 'setup']);
    expect(r.symbols.find((s) => s.name === 'setup').exported).toBe(true);
  });
});

describe('dead_exports', () => {
  it('without a references layer, returns every export and flags imprecision', () => {
    const r = deadExports(g);
    expect(r.precise).toBe(false);
    expect(r.note).toMatch(/no references layer/);
    expect(r.candidates.map((c) => c.name).sort()).toEqual(['format', 'pay', 'setup']);
    expect(r.total).toBe(3);
  });

  it('with the references layer, only unreferenced exports remain (same-file uses excluded)', () => {
    // `setup` is used cross-file; `format` only within its own file; `pay` never.
    writeLayer(g.cacheDir, 'references', {
      edges: [
        { id: 'r1', type: 'REFERENCES', from: 'file:src/ui/button.tsx', to: 'sym:src/core/index.ts#setup', properties: { sameFile: false } },
        { id: 'r2', type: 'REFERENCES', from: 'file:src/core/util.ts', to: 'sym:src/core/util.ts#format', properties: { sameFile: true } },
      ],
    });
    const r = deadExports(loadGraph(g.cacheDir));
    expect(r.precise).toBe(true);
    expect(r.note).not.toMatch(/Best-effort/);
    expect(r.candidates.map((c) => c.name).sort()).toEqual(['format', 'pay']);
    expect(r.exportedSymbols).toBe(3);
    expect(r.entryPointExclusions).toBe(0);
  });

  it('excludes exports of a file the references layer marked as an entry point', () => {
    writeLayer(g.cacheDir, 'references', {
      nodes: [fileNode('src/checkout/pay.ts', { entryPoint: true })],
      edges: [
        { id: 'r1', type: 'REFERENCES', from: 'file:src/ui/button.tsx', to: 'sym:src/core/index.ts#setup', properties: { sameFile: false } },
      ],
    });
    const r = deadExports(loadGraph(g.cacheDir));
    // `pay` lives in an entry point; `format` is a genuine dead export.
    expect(r.candidates.map((c) => c.name)).toEqual(['format']);
    expect(r.total).toBe(1);
    expect(r.entryPointExclusions).toBe(1);
    expect(r.note).toMatch(/entry point/i);
    // Not listed unless asked for — the count alone says the exclusion happened.
    expect(r.entryPoints).toBeUndefined();
  });

  it('lists the excluded entry-point symbols on request', () => {
    writeLayer(g.cacheDir, 'references', {
      nodes: [fileNode('src/checkout/pay.ts', { entryPoint: true })],
      edges: [],
    });
    const r = deadExports(loadGraph(g.cacheDir), { includeEntryPoints: true });
    expect(r.entryPoints).toEqual([
      { id: 'sym:src/checkout/pay.ts#pay', name: 'pay', kind: 'function', path: 'src/checkout/pay.ts', line: 1 },
    ]);
  });

  it('excludes a symbol an entry point EXPOSES through a re-export chain', () => {
    // `format` is declared in a plain file but re-exported by the entry point,
    // so it is public API. `pay` is reachable from nothing and stays a candidate.
    writeLayer(g.cacheDir, 'references', {
      nodes: [fileNode('src/core/index.ts', { entryPoint: true })],
      edges: [
        {
          id: 'edge:file:src/core/index.ts:EXPOSES:sym:src/core/util.ts#format',
          type: 'EXPOSES',
          from: 'file:src/core/index.ts',
          to: 'sym:src/core/util.ts#format',
          properties: { hops: 1 },
        },
      ],
    });
    const r = deadExports(loadGraph(g.cacheDir));
    expect(r.candidates.map((c) => c.name)).toEqual(['pay']);
    expect(r.entryPointExclusions).toBe(2); // setup (declared in the entry) + format (re-exported)
  });

  it('names the entry point a re-exported symbol came from', () => {
    writeLayer(g.cacheDir, 'references', {
      nodes: [fileNode('src/core/index.ts', { entryPoint: true })],
      edges: [
        {
          id: 'edge:file:src/core/index.ts:EXPOSES:sym:src/core/util.ts#format',
          type: 'EXPOSES',
          from: 'file:src/core/index.ts',
          to: 'sym:src/core/util.ts#format',
          properties: { hops: 2 },
        },
      ],
    });
    const r = deadExports(loadGraph(g.cacheDir), { includeEntryPoints: true });
    expect(r.entryPoints).toContainEqual({
      id: 'sym:src/core/util.ts#format',
      name: 'format',
      kind: 'function',
      path: 'src/core/util.ts',
      line: 1,
      via: 'src/core/index.ts',
      hops: 2,
    });
    // A symbol declared IN the entry point needs no `via` — nothing re-exported it.
    expect(r.entryPoints.find((e) => e.name === 'setup')?.via).toBeUndefined();
  });
});

describe('domain tools', () => {
  it('domain_of returns the file domain', () => {
    const r = domainOf(g, { file: 'src/checkout/pay.ts' });
    expect(r.domain).toBe('domain:checkout');
    expect(r.name).toBe('checkout');
  });
  it('domain_dependencies returns weighted in/out edges', () => {
    const r = domainDependencies(g, { domain: 'core' });
    expect(r.dependsOn).toEqual([]);
    expect(r.dependedOnBy.map((d) => d.from).sort()).toEqual(['domain:checkout', 'domain:ui']);
    expect(r.dependedOnBy[0].weight).toBe(1);
  });
  it('domain_crossings ranks all DEPENDS_ON edges', () => {
    const r = domainCrossings(g);
    expect(r.pairs).toBe(2);
    expect(r.totalWeight).toBe(2);
    expect(r.crossings.every((c) => c.to === 'domain:core')).toBe(true);
  });
});

describe('brief tool', () => {
  it('returns the structured file brief', () => {
    const r = brief(g, { target: 'src/core/index.ts' });
    expect(r).toMatchObject({ kind: 'file', path: 'src/core/index.ts', domain: 'core' });
    expect(r.importedBy.count).toBe(2);
    expect(r.blastRadius.count).toBe(2);
  });

  it('resolves a bare basename and a domain name', () => {
    expect(brief(g, { target: 'button.tsx' }).path).toBe('src/ui/button.tsx');
    expect(brief(g, { target: 'checkout' }).kind).toBe('domain');
  });

  it('honors limit and reports a missing/invalid target in the payload', () => {
    expect(brief(g, { target: 'src/core/index.ts', limit: 1 }).importedBy.files).toHaveLength(1);
    expect(brief(g, {}).error).toMatch(/target/);
    expect(brief(g, { target: 'nowhere' }).kind).toBe('not-found');
  });
});

describe('impact tool', () => {
  it('reports blast radius, domains, risky exports and tests for explicit files', () => {
    const r = impact(g, { files: ['src/core/index.ts'] });
    expect(r.source).toBe('files');
    expect(r.changed.byDomain).toEqual([{ domain: 'core', files: ['src/core/index.ts'] }]);
    expect(r.blastRadius.files).toEqual(['src/checkout/pay.ts', 'src/ui/button.tsx']);
    expect(r.domains).toEqual([{ domain: 'checkout', files: 1 }, { domain: 'core', files: 1 }, { domain: 'ui', files: 1 }]);
    expect(r.tests.count).toBe(0);
  });

  it('reads an explicit empty file list as an empty change set', () => {
    expect(impact(g, { files: [] }).note).toMatch(/no changed files/i);
  });

  it('reports (never throws) when a diff cannot be resolved', () => {
    // The fixture cache carries no manifest, so there is no repo root to diff in.
    const r = impact(g, { diff: 'main' });
    expect(r.source).toBe('diff main');
    expect(r.error).toMatch(/files/);
  });
});

// ---- precise reading ----------------------------------------------------

const CART = `import { store } from './store';

/** Load one cart. */
export async function loadCart(id: string): Promise<Cart> {
  return store.get(id);
}

export const CART_KEY = 'cart';
`;

/**
 * A cache whose manifest points at a REAL little repo on disk, with a symbols
 * layer that deliberately records the wrong line (`sym()` says line 1, the
 * declaration is on line 4) — `show` must ignore it and re-parse.
 */
function buildRepoGraph() {
  const repo = mkdtempSync(join(tmpdir(), 'cg-mcp-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'cart.ts'), CART);

  const cache = mkdtempSync(join(tmpdir(), 'cg-mcp-repo-cache-'));
  mkdirSync(join(cache, 'inventory'), { recursive: true });
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({ repoRoot: repo }));
  writeLayer(cache, 'inventory', { nodes: [fileNode('src/cart.ts', { language: 'TypeScript' })] });
  writeLayer(cache, 'symbols', { nodes: [sym('src/cart.ts', 'loadCart', true)] });
  return loadGraph(cache);
}

describe('outline tool', () => {
  it('returns the file skeleton without any bodies', () => {
    const r = outline(buildRepoGraph(), { target: 'cart.ts' });
    expect(r.kind).toBe('outline');
    expect(r.path).toBe('src/cart.ts');
    expect(r.imports.list).toEqual(['./store']);
    expect(r.declarations.list.map((d) => d.name)).toEqual(['loadCart', 'CART_KEY']);
    expect(JSON.stringify(r)).not.toContain('store.get(id)');
  });

  it('honors limit and reports a bad or unmatched target in the payload', () => {
    const g2 = buildRepoGraph();
    expect(outline(g2, { target: 'cart.ts', limit: 1 }).declarations.truncated).toBe(true);
    expect(outline(g2, {}).error).toMatch(/target/);
    expect(outline(g2, { target: 'nowhere.ts' }).kind).toBe('not-found');
  });

  it('says so when the cache has no repo root to read from', () => {
    expect(outline(g, { target: 'src/core/index.ts' }).error).toMatch(/repoRoot/);
  });
});

describe('show tool', () => {
  it('prints the real range even though the cached line number is wrong', () => {
    const r = show(buildRepoGraph(), { symbol: 'loadCart' });
    expect(r.kind).toBe('symbol');
    expect(r.lookup).toBe('graph');
    expect(r.declarationLine).toBe(4);
    expect(r.startLine).toBe(3); // the JSDoc line, not the cached `line: 1`
    expect(r.source).toContain('export async function loadCart(id: string): Promise<Cart> {');
    expect(r.source).not.toContain('CART_KEY');
  });

  it('adds context lines and reports a miss in the payload', () => {
    const g2 = buildRepoGraph();
    expect(show(g2, { symbol: 'src/cart.ts#CART_KEY', context: 1 }).context).toBe(1);
    expect(show(g2, { symbol: 'nope' }).kind).toBe('not-found');
    expect(show(g2, {}).error).toMatch(/symbol/);
  });

  it('says so when the cache has no repo root to read from', () => {
    expect(show(g, { symbol: 'setup' }).error).toMatch(/repoRoot/);
  });
});

describe('describe (lookup only)', () => {
  const row = {
    targetId: 'domain:core',
    kind: 'domain',
    contentHash: 'h1',
    text: 'Shared primitives every other domain builds on.',
    model: 'fake-model',
    provider: 'command',
    generatedAt: '2026-08-17T10:00:00.000Z',
  };

  it('returns a cached description, always labelled as generated', () => {
    writeDescriptions(g.cacheDir, 'domain', [row]);
    const r = describeTool(g, { target: 'core' });
    expect(r).toMatchObject({
      targetId: 'domain:core',
      found: true,
      generated: true,
      description: row.text,
      model: 'fake-model',
      provider: 'command',
      generatedAt: row.generatedAt,
    });
    expect(r.label).toContain('generated by fake-model');
    expect(r.note).toMatch(/MODEL-GENERATED/);
  });

  it('says so — and how to get one — when nothing is cached', () => {
    const r = describeTool(g, { target: 'core' });
    expect(r.found).toBe(false);
    expect(r.targetId).toBe('domain:core');
    expect(r.hint).toMatch(/loregraph describe/);
    expect(r.hint).toMatch(/never do it for you/);
  });

  it('resolves a target exactly the way brief does, including ambiguity', () => {
    expect(describeTool(g, { target: 'src/core/util.ts' }).targetId).toBe('file:src/core/util.ts');
    expect(describeTool(g, { target: 'format' }).targetId).toBe('sym:src/core/util.ts#format');
    expect(describeTool(g, { target: 'nothing-like-this' })).toMatchObject({ found: false });
    expect(describeTool(g, { target: '' }).error).toBeTruthy();
  });

  it('never mutates the graph node it describes', () => {
    writeDescriptions(g.cacheDir, 'domain', [row]);
    describeTool(g, { target: 'core' });
    expect(g.getNode('domain:core').properties.description).toBeUndefined();
    expect(JSON.stringify(g.getNode('domain:core'))).not.toContain('Shared primitives');
  });

  it('is reachable through callTool', () => {
    writeDescriptions(g.cacheDir, 'domain', [row]);
    expect(callTool(g, 'describe', { target: 'core' }).description).toBe(row.text);
  });
});

describe('brief + descriptions', () => {
  it('carries a cached description in its own labelled field', () => {
    writeDescriptions(g.cacheDir, 'file', [{
      targetId: 'file:src/core/util.ts',
      kind: 'file',
      contentHash: 'h2',
      text: 'Formatting helpers.',
      model: 'fake-model',
      provider: 'command',
      generatedAt: '2026-08-17T10:00:00.000Z',
    }]);
    const r = brief(g, { target: 'src/core/util.ts' });
    expect(r.description).toMatchObject({ generated: true, text: 'Formatting helpers.', model: 'fake-model' });
    expect(r.description.label).toContain('generated by');
    // Never merged into the proven properties.
    expect(g.getNode('file:src/core/util.ts').properties.description).toBeUndefined();
  });

  it('has no description field at all when none is cached', () => {
    expect(brief(g, { target: 'src/core/util.ts' }).description).toBeUndefined();
  });
});

describe('cycles', () => {
  it('reports none on the acyclic fixture graph', () => {
    const r = cyclesTool(g, {});
    expect(r.scope).toBe('both');
    expect(r.total).toBe(0);
  });

  it('finds a file cycle and a weighted domain cycle', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-mcp-cycles-'));
    writeLayer(cache, 'inventory', { nodes: [fileNode('src/a.ts'), fileNode('src/b.ts')] });
    writeLayer(cache, 'imports', {
      edges: [
        imp('src/a.ts', 'file:src/b.ts', 'internal', './b'),
        imp('src/b.ts', 'file:src/a.ts', 'internal', './a'),
      ],
    });
    writeLayer(cache, 'domains', {
      nodes: [domainNode('ui'), domainNode('server')],
      edges: [dependsOn('ui', 'server', 4), dependsOn('server', 'ui', 2)],
    });
    const cyclic = loadGraph(cache);
    const r = cyclesTool(cyclic, {});
    expect(r.file.cycles[0].members).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r.domain.cycles[0].members).toEqual(['server', 'ui']);
    expect(r.domain.cycles[0].minWeight).toBe(2);
    expect(cyclesTool(cyclic, { scope: 'file' }).domain).toBeUndefined();
  });
});

describe('callTool + registry', () => {
  it('exposes exactly 17 tools', () => {
    expect(TOOLS).toHaveLength(17);
    expect(TOOL_NAMES.has('outline')).toBe(true);
    expect(TOOL_NAMES.has('show')).toBe(true);
    expect(TOOL_NAMES.has('describe')).toBe(true);
    expect(TOOL_NAMES.has('cycles')).toBe(true);
  });
  it('every TOOLS spec has a matching dispatch entry and vice versa', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of TOOLS) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
  });
  it('dispatches by name', () => {
    expect(callTool(g, 'imports_of', { file: 'src/checkout/pay.ts' }).count).toBe(2);
  });
  it('throws on an unknown tool', () => {
    expect(() => callTool(g, 'nope', {})).toThrow(/Unknown tool/);
  });
  it('prefixes a graph-empty note when the graph is empty', () => {
    const empty = loadGraph(join(tmpdir(), 'cg-mcp-none-does-not-exist'));
    const r = callTool(empty, 'find_node', { query: 'x' });
    expect(r.note).toMatch(/graph empty/);
  });
});

describe('optional response shaping on the token savers', () => {
  it('advertises maxTokens on brief, impact and outline', () => {
    for (const name of ['brief', 'impact', 'outline']) {
      const spec = TOOLS.find((t) => t.name === name);
      expect(spec.inputSchema.properties.maxTokens).toBeDefined();
      expect(spec.inputSchema.required ?? []).not.toContain('maxTokens');
    }
  });

  it('advertises compressPaths on the two tools that list repo paths', () => {
    for (const name of ['brief', 'impact']) {
      expect(TOOLS.find((t) => t.name === name).inputSchema.properties.compressPaths).toBeDefined();
    }
    // `outline` lists import specifiers, not repo paths — no switch to offer.
    expect(TOOLS.find((t) => t.name === 'outline').inputSchema.properties.compressPaths).toBeUndefined();
  });

  it('either honours the cap or says out loud that it could not', () => {
    // A JSON result has a fixed skeleton (kind, path, counts, the budget block)
    // that truncation cannot shrink, so a small enough cap is unmeetable. The
    // invariant is not "always under" — it is "never silently over".
    const graph = buildGraph();
    for (const cap of [400, 300, 200, 150, 100, 50, 10]) {
      const capped = callTool(graph, 'brief', { target: 'src/core/util.ts', limit: 200, maxTokens: cap });
      const approx = Math.ceil(JSON.stringify(capped).length / 4);
      expect(capped.budget.maxTokens).toBe(cap);
      expect(capped.budget.note).toMatch(/4 chars\/token/);
      if (approx > cap) expect(capped.budget.overBudget).toBe(true);
      else expect(capped.budget.overBudget).toBeUndefined();
    }
  });

  it('records which sections a cap cut', () => {
    const graph = buildGraph();
    const capped = callTool(graph, 'brief', { target: 'src/core/util.ts', limit: 200, maxTokens: 150 });
    expect(capped.budget.truncated).toBe(true);
    expect(capped.budget.truncatedSections.length).toBeGreaterThan(0);
  });

  it('says so in the payload when a cap is impossible to meet', () => {
    const graph = buildGraph();
    const capped = callTool(graph, 'brief', { target: 'src/core/util.ts', maxTokens: 1 });
    expect(capped.budget.overBudget).toBe(true);
  });

  it('ignores a nonsensical maxTokens instead of returning nothing', () => {
    const graph = buildGraph();
    for (const bad of [0, -1, 'lots', null]) {
      const result = callTool(graph, 'brief', { target: 'src/core/util.ts', maxTokens: bad });
      expect(result.budget).toBeUndefined();
      expect(result.kind).toBe('file');
    }
  });

  it('returns pathGroups a caller can rebuild full paths from', () => {
    const graph = buildGraph();
    const packed = callTool(graph, 'impact', { files: ['src/core/util.ts'], limit: 200, compressPaths: true });
    const plain = callTool(graph, 'impact', { files: ['src/core/util.ts'], limit: 200, compressPaths: false });
    if (packed.blastRadius.pathGroups) {
      const rebuilt = packed.blastRadius.pathGroups
        .flatMap((g) => g.paths.map((p) => `${g.pathPrefix}${p}`)).sort();
      expect(rebuilt).toEqual([...plain.blastRadius.files].sort());
    } else {
      // Below the thresholds on this fixture: then it must be byte-identical.
      expect(packed).toEqual(plain);
    }
  });
});
