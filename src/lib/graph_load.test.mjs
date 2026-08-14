import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph, GRAPH_LAYERS } from './graph_load.mjs';

/** Write `<cache>/<layer>/{nodes,edges}.jsonl` from arrays of objects. */
function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

let cache;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'cg-graph-load-'));
});

describe('loadGraph — layer discovery', () => {
  it('covers all six layers in dependency order', () => {
    expect(GRAPH_LAYERS).toEqual([
      'inventory', 'imports', 'symbols', 'references', 'usages', 'domains',
    ]);
  });

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
    expect(g.missingLayers).toEqual(['symbols', 'references', 'usages', 'domains']);
    expect(g.empty).toBe(false);
  });

  it('indexes the reference and usage layers too', () => {
    writeLayer(cache, 'symbols', {
      nodes: [{ id: 'sym:a#foo', labels: ['Symbol'], properties: { name: 'foo', exported: true } }],
      edges: [{ id: 'e:d', type: 'DECLARES', from: 'file:a', to: 'sym:a#foo', properties: {} }],
    });
    writeLayer(cache, 'references', {
      nodes: [{ id: 'sym:a#foo', labels: ['Symbol'], properties: { name: 'foo' } }],
      edges: [{ id: 'e:r', type: 'REFERENCES', from: 'file:b', to: 'sym:a#foo', properties: { sameFile: false } }],
    });
    writeLayer(cache, 'usages', {
      edges: [{ id: 'e:u', type: 'USES', from: 'sym:b#bar', to: 'sym:a#foo', properties: {} }],
    });
    const g = loadGraph(cache);
    expect(g.loadedLayers).toEqual(['symbols', 'references', 'usages']);
    expect(g.byType('REFERENCES')).toHaveLength(1);
    expect(g.byType('USES')).toHaveLength(1);
    expect(g.neighbors('sym:a#foo', { dir: 'in', type: 'REFERENCES' })).toHaveLength(1);
  });

  it('honors an explicit layer subset', () => {
    writeLayer(cache, 'inventory', { nodes: [{ id: 'file:a', labels: ['File'] }] });
    writeLayer(cache, 'imports', { nodes: [{ id: 'pkg:x', labels: ['Package'] }] });
    const g = loadGraph(cache, { layers: ['inventory'] });
    expect(g.loadedLayers).toEqual(['inventory']);
    expect(g.nodesById.has('pkg:x')).toBe(false);
  });

  it('returns a valid empty graph for a missing/empty cache dir', () => {
    const g = loadGraph(join(cache, 'does-not-exist'));
    expect(g.empty).toBe(true);
    expect(g.loadedLayers).toEqual([]);
    expect(g.stats.nodes).toBe(0);
    expect(g.byLabel('File')).toEqual([]);
    expect(g.neighbors('anything')).toEqual([]);
    expect(g.manifest).toBeNull();
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
    expect(g.edges).toHaveLength(2);
    expect(g.outEdges.get('file:a').map((e) => e.to).sort()).toEqual(['file:b', 'pkg:x']);
    expect(g.inEdges.get('file:b').map((e) => e.from)).toEqual(['file:a']);
    expect(g.inEdges.get('pkg:x').map((e) => e.from)).toEqual(['file:a']);
  });

  it('keeps the FIRST occurrence of a duplicate edge id', () => {
    writeLayer(cache, 'symbols', {
      edges: [{ id: 'edge:file:a:IMPORTS:file:b', type: 'IMPORTS', from: 'file:a', to: 'file:b', properties: { kind: 'LATER' } }],
    });
    const g = loadGraph(cache);
    expect(g.getNode('file:a')).toBeTruthy();
    expect(g.edgesById.get('edge:file:a:IMPORTS:file:b').properties.kind).toBe('internal');
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

describe('loadGraph — inventory manifest', () => {
  it('reads the inventory manifest for project/snapshot identity', () => {
    mkdirSync(join(cache, 'inventory'), { recursive: true });
    writeFileSync(
      join(cache, 'inventory', 'manifest.json'),
      JSON.stringify({ projectId: 'project:x', snapshotId: 'snapshot:x:1' }),
    );
    writeLayer(cache, 'inventory', { nodes: [{ id: 'file:a', labels: ['File'], properties: { path: 'a', kind: 'code' } }] });
    const g = loadGraph(cache);
    expect(g.manifest).toMatchObject({ projectId: 'project:x' });
  });

  it('degrades a corrupt manifest to null instead of throwing', () => {
    mkdirSync(join(cache, 'inventory'), { recursive: true });
    writeFileSync(join(cache, 'inventory', 'manifest.json'), '{not json');
    expect(loadGraph(cache).manifest).toBeNull();
  });
});
