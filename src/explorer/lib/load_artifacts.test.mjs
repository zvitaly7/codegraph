import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArtifacts } from './load_artifacts.mjs';

function writeLayer(cache, layer, nodes, edges) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

let cache;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), 'cg-load-')); });

describe('loadArtifacts', () => {
  it('reads present layers, records missing ones, and reads the inventory manifest', () => {
    mkdirSync(join(cache, 'inventory'), { recursive: true });
    writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({ projectId: 'project:x', snapshotId: 'snapshot:x:1' }));
    writeLayer(cache, 'inventory', [{ id: 'file:a', labels: ['File'], properties: { path: 'a', name: 'a', kind: 'code' } }], []);
    writeLayer(cache, 'imports', [{ id: 'file:a', labels: ['File'], properties: { path: 'a' } }], [
      { id: 'e1', type: 'IMPORTS', from: 'file:a', to: 'pkg:react', properties: {} },
    ]);

    const g = loadArtifacts(cache);
    expect(g.layersPresent).toEqual(['inventory', 'imports']);
    expect(g.layersMissing).toEqual(['symbols', 'references', 'usages', 'domains']);
    expect(g.manifest).toMatchObject({ projectId: 'project:x' });
    expect(g.edges).toHaveLength(1);

    // File node merged: rich inventory props survive the thinner imports re-emit.
    const file = g.nodesById.get('file:a');
    expect(file.properties).toMatchObject({ path: 'a', name: 'a', kind: 'code' });
  });

  it('dedupes edges by id (first occurrence wins) and unions labels', () => {
    writeLayer(cache, 'inventory', [{ id: 'n', labels: ['File'] }], [{ id: 'dup', type: 'X', from: 'a', to: 'b', properties: { v: 1 } }]);
    writeLayer(cache, 'imports', [{ id: 'n', labels: ['Thing'] }], [{ id: 'dup', type: 'X', from: 'a', to: 'b', properties: { v: 2 } }]);

    const g = loadArtifacts(cache);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].properties.v).toBe(1);
    expect(new Set(g.nodesById.get('n').labels)).toEqual(new Set(['File', 'Thing']));
  });

  it('empty cache → no layers, null manifest', () => {
    const g = loadArtifacts(cache);
    expect(g.layersPresent).toEqual([]);
    expect(g.manifest).toBeNull();
    expect(g.nodesById.size).toBe(0);
  });
});
