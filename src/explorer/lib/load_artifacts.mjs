// Read every present graph layer under a cache dir into one in-memory graph.
//
// The consumption/explorer view needs ALL six layers — inventory, imports,
// symbols, references, usages, domains — so it reads them directly rather than
// the MCP `loadGraph` (which indexes only four and omits references/usages).
// A missing layer directory is simply skipped; the graph loads with whatever
// exists so the index builder can degrade gracefully.
//
// Nodes are merged by id (labels unioned, later-layer properties layered over
// earlier ones — which only re-confirms the rich inventory/symbol props, since
// the thinner re-emitted `{path}` File nodes carry the same path). Edges are
// deduped by id (first occurrence wins).

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** All layers the explorer consumes, in dependency order. */
export const EXPLORER_LAYERS = [
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

/**
 * Load and merge the graph artifacts under `cacheDir`.
 * @param {string} cacheDir directory holding one subdir per layer.
 * @param {{layers?: string[]}} [opts]
 * @returns {{
 *   cacheDir: string,
 *   layersPresent: string[],
 *   layersMissing: string[],
 *   nodesById: Map<string, object>,
 *   edges: object[],
 *   manifest: object|null,
 * }}
 */
export function loadArtifacts(cacheDir, { layers = EXPLORER_LAYERS } = {}) {
  const nodesById = new Map();
  const edgesById = new Map();
  const layersPresent = [];
  const layersMissing = [];

  for (const layer of layers) {
    const dir = join(cacheDir, layer);
    const nodesPath = join(dir, 'nodes.jsonl');
    const edgesPath = join(dir, 'edges.jsonl');
    const hasNodes = existsSync(nodesPath);
    const hasEdges = existsSync(edgesPath);
    if (!hasNodes && !hasEdges) {
      layersMissing.push(layer);
      continue;
    }
    layersPresent.push(layer);
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

  return {
    cacheDir,
    layersPresent,
    layersMissing,
    nodesById,
    edges: [...edgesById.values()],
    manifest,
  };
}
