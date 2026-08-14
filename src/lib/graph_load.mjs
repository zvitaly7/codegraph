// The one in-memory graph index every consumer reads (MCP, explorer, brief, impact).
//
// `loadGraph(cacheDir)` reads every present `<cacheDir>/<layer>/{nodes,edges}.jsonl`
// for ALL SIX layers — inventory → imports → symbols → references → usages →
// domains — and merges them into a single queryable index:
//   - nodesById  Map<id, node>   deduped by id; a later layer merges its
//                                properties over an earlier one and unions labels.
//   - edgesById  Map<id, edge>   deduped by id (first occurrence wins).
//   - edges      edge[]          the same edges as a plain array.
//   - outEdges   Map<id, edge[]> adjacency keyed by edge.from.
//   - inEdges    Map<id, edge[]> adjacency keyed by edge.to.
//   - byLabel / byType indices, plus neighbors() / getNode() helpers.
//   - manifest   the inventory manifest (project / snapshot identity), or null.
//
// A missing layer directory is skipped (the graph loads with whatever exists);
// an empty or missing cache yields an empty—but valid—graph (`empty === true`).

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** Every layer merged into the index, in dependency order (later wins on conflict). */
export const GRAPH_LAYERS = [
  'inventory', 'imports', 'symbols', 'references', 'usages', 'domains',
];

/** Read every row of a .jsonl file (blank lines skipped). */
function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Merge `node` into the index: union labels, later properties override earlier. */
function mergeNode(nodesById, node) {
  if (!node || typeof node.id !== 'string') return;
  const existing = nodesById.get(node.id);
  if (!existing) {
    nodesById.set(node.id, {
      id: node.id,
      labels: [...(node.labels ?? [])],
      properties: { ...(node.properties ?? {}) },
    });
    return;
  }
  const labels = new Set(existing.labels);
  for (const label of node.labels ?? []) labels.add(label);
  existing.labels = [...labels];
  existing.properties = { ...existing.properties, ...(node.properties ?? {}) };
}

function pushInto(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Load and index the graph artifacts under `cacheDir`.
 * @param {string} cacheDir directory holding one subdir per layer.
 * @param {{layers?: string[]}} [opts] restrict which layers are read.
 * @returns {object} the in-memory graph index (see module header).
 */
export function loadGraph(cacheDir, { layers = GRAPH_LAYERS } = {}) {
  const nodesById = new Map();
  const edgesById = new Map();
  const outEdges = new Map();
  const inEdges = new Map();
  const loadedLayers = [];
  const missingLayers = [];

  for (const layer of layers) {
    const dir = join(cacheDir, layer);
    const nodesPath = join(dir, 'nodes.jsonl');
    const edgesPath = join(dir, 'edges.jsonl');
    const hasNodes = existsSync(nodesPath);
    const hasEdges = existsSync(edgesPath);
    if (!hasNodes && !hasEdges) {
      missingLayers.push(layer);
      continue;
    }
    loadedLayers.push(layer);
    if (hasNodes) {
      for (const node of readJsonl(nodesPath)) mergeNode(nodesById, node);
    }
    if (hasEdges) {
      for (const e of readJsonl(edgesPath)) {
        if (!e || typeof e.id !== 'string' || edgesById.has(e.id)) continue;
        edgesById.set(e.id, e);
      }
    }
  }

  // Build adjacency + label/type indices once every layer is merged.
  const byLabelIndex = new Map();
  for (const node of nodesById.values()) {
    for (const label of node.labels ?? []) pushInto(byLabelIndex, label, node);
  }

  const byTypeIndex = new Map();
  for (const e of edgesById.values()) {
    pushInto(outEdges, e.from, e);
    pushInto(inEdges, e.to, e);
    pushInto(byTypeIndex, e.type, e);
  }

  // The inventory manifest carries the project / snapshot identity.
  let manifest = null;
  const manifestPath = join(cacheDir, 'inventory', 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = null; // a corrupt manifest is non-fatal — identity just goes null.
    }
  }

  /**
   * Edges incident to `id`, optionally filtered by edge `type` and direction.
   * @param {string} id node id.
   * @param {{type?: string, dir?: 'out'|'in'|'both'}} [opts]
   * @returns {object[]} matching edges.
   */
  function neighbors(id, { type, dir = 'both' } = {}) {
    const out = [];
    if (dir === 'out' || dir === 'both') {
      for (const e of outEdges.get(id) ?? []) {
        if (!type || e.type === type) out.push(e);
      }
    }
    if (dir === 'in' || dir === 'both') {
      for (const e of inEdges.get(id) ?? []) {
        if (!type || e.type === type) out.push(e);
      }
    }
    return out;
  }

  return {
    cacheDir,
    loadedLayers,
    missingLayers,
    manifest,
    nodesById,
    edgesById,
    edges: [...edgesById.values()],
    outEdges,
    inEdges,
    empty: nodesById.size === 0,
    stats: { nodes: nodesById.size, edges: edgesById.size, layers: loadedLayers },
    getNode: (id) => nodesById.get(id),
    byLabel: (label) => byLabelIndex.get(label) ?? [],
    byType: (type) => byTypeIndex.get(type) ?? [],
    neighbors,
    allNodes: () => [...nodesById.values()],
    allEdges: () => [...edgesById.values()],
  };
}
