import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from './graph.mjs';

/** Write `<cache>/<layer>/{nodes,edges}.jsonl` from arrays of objects. */
function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

let cache;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'cg-mcp-graph-'));
});

describe('loadGraph — layer discovery', () => {
  it('loads present layers and reports missing ones', () => {
    writeLayer(cache, 'inventory', {
      nodes: [{ id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts', name: 'a.ts' } }],
    });
    writeLayer(cache, 'imports', {
      nodes: [{ id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts' } }],
      edges: [{ id: 'e1', type: 'IMPORTS', from: 'file:src/a.ts', to: 'pkg:x', properties: { kind: 'external' } }],
    });
    const g = loadGraph(cache);
    expect(g.loadedLayers).toEqual(['inventory', 'imports']);
    expect(g.missingLayers).toEqual(['symbols', 'domains']);
    expect(g.empty).toBe(false);
  });

  it('returns a valid empty graph for a missing/empty cache dir', () => {
    const g = loadGraph(join(cache, 'does-not-exist'));
    expect(g.empty).toBe(true);
    expect(g.loadedLayers).toEqual([]);
    expect(g.stats.nodes).toBe(0);
    expect(g.byLabel('File')).toEqual([]);
    expect(g.neighbors('anything')).toEqual([]);
  });
});

describe('loadGraph — node dedupe + property merge', () => {
  it('merges properties from later layers and unions labels', () => {
    writeLayer(cache, 'inventory', {
      nodes: [{ id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts', name: 'a.ts', language: 'TypeScript' } }],
    });
    // A later layer re-declares the same File id with sparse props + an extra label.
    writeLayer(cache, 'imports', {
      nodes: [{ id: 'file:src/a.ts', labels: ['File', 'Entry'], properties: { path: 'src/a.ts', imported: true } }],
    });
    const g = loadGraph(cache);
    expect(g.nodesById.size).toBe(1);
    const node = g.getNode('file:src/a.ts');
    expect(node.properties).toEqual({ path: 'src/a.ts', name: 'a.ts', language: 'TypeScript', imported: true });
    expect(node.labels.sort()).toEqual(['Entry', 'File']);
  });
});

describe('loadGraph — edges + adjacency + indices', () => {
  beforeEach(() => {
    writeLayer(cache, 'inventory', {
      nodes: [
        { id: 'file:a', labels: ['File'], properties: { path: 'a' } },
        { id: 'file:b', labels: ['File'], properties: { path: 'b' } },
      ],
    });
    writeLayer(cache, 'imports', {
      nodes: [{ id: 'pkg:x', labels: ['Package'], properties: { name: 'x' } }],
      edges: [
        { id: 'edge:file:a:IMPORTS:file:b', type: 'IMPORTS', from: 'file:a', to: 'file:b', properties: { kind: 'internal' } },
        { id: 'edge:file:a:IMPORTS:pkg:x', type: 'IMPORTS', from: 'file:a', to: 'pkg:x', properties: { kind: 'external' } },
        // duplicate id across a hypothetical re-run — must be deduped.
        { id: 'edge:file:a:IMPORTS:file:b', type: 'IMPORTS', from: 'file:a', to: 'file:b', properties: { kind: 'internal' } },
      ],
    });
  });

  it('dedupes edges by id and builds out/in adjacency', () => {
    const g = loadGraph(cache);
    expect(g.edgesById.size).toBe(2);
    expect(g.outEdges.get('file:a').map((e) => e.to).sort()).toEqual(['file:b', 'pkg:x']);
    expect(g.inEdges.get('file:b').map((e) => e.from)).toEqual(['file:a']);
    expect(g.inEdges.get('pkg:x').map((e) => e.from)).toEqual(['file:a']);
  });

  it('indexes nodes by label and edges by type', () => {
    const g = loadGraph(cache);
    expect(g.byLabel('File').map((n) => n.id).sort()).toEqual(['file:a', 'file:b']);
    expect(g.byLabel('Package').map((n) => n.id)).toEqual(['pkg:x']);
    expect(g.byType('IMPORTS')).toHaveLength(2);
    expect(g.byType('NOPE')).toEqual([]);
  });

  it('neighbors() filters by type and direction', () => {
    const g = loadGraph(cache);
    expect(g.neighbors('file:a', { dir: 'out', type: 'IMPORTS' })).toHaveLength(2);
    expect(g.neighbors('file:a', { dir: 'in' })).toEqual([]);
    expect(g.neighbors('file:b', { dir: 'in', type: 'IMPORTS' }).map((e) => e.from)).toEqual(['file:a']);
    expect(g.neighbors('file:b')).toHaveLength(1); // both directions, unfiltered
  });
});

describe('loadGraph — partial layer files', () => {
  it('loads a layer that has only nodes.jsonl (no edges file)', () => {
    const dir = join(cache, 'symbols');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nodes.jsonl'), JSON.stringify({ id: 'sym:a#foo', labels: ['Symbol'], properties: { name: 'foo' } }));
    const g = loadGraph(cache);
    expect(g.loadedLayers).toEqual(['symbols']);
    expect(g.getNode('sym:a#foo').properties.name).toBe('foo');
  });
});
