import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from './graph.mjs';
import {
  findNode, nodeInfo, importsOf, importedBy, impactOf, pathBetween,
  listSymbols, deadExports, domainOf, domainDependencies, domainCrossings,
  callTool, TOOLS, TOOL_NAMES,
} from './tools.mjs';

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
  it('returns all exported symbols and flags imprecision', () => {
    const r = deadExports(g);
    expect(r.precise).toBe(false);
    expect(r.note).toMatch(/references\/usages/);
    expect(r.candidates.map((c) => c.name).sort()).toEqual(['format', 'pay', 'setup']);
    expect(r.total).toBe(3);
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

describe('callTool + registry', () => {
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
