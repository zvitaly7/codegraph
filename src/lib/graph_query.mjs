// Small pure read helpers over a loaded graph (see ./graph_load.mjs).
//
// These are the questions BOTH `brief` and `impact` ask — "what does this file
// pull in", "who transitively imports it", "which files reference this symbol"
// — so they live here instead of being reimplemented per command. Nothing here
// does I/O or throws; unknown ids simply yield empty results.

import { normPosix } from '../inventory/schema.mjs';

/** Default BFS depth cap for transitive walks. */
export const DEFAULT_MAX_DEPTH = 25;

/** Canonical `file:<path>` id for a path that may already be an id. */
export function toFileId(file) {
  if (typeof file !== 'string') return null;
  return file.startsWith('file:') ? file : `file:${normPosix(file)}`;
}

/** The repo-relative path behind a `file:` id (any other id is returned as-is). */
export function fileIdToPath(id) {
  return typeof id === 'string' && id.startsWith('file:') ? id.slice('file:'.length) : id;
}

/** The domain a file belongs to: `{ id, name, kind }`, or null. */
export function domainOfFile(graph, fileId) {
  const edge = graph.neighbors(fileId, { dir: 'out', type: 'BELONGS_TO' })[0];
  if (!edge) return null;
  const node = graph.getNode(edge.to);
  return {
    id: edge.to,
    name: node?.properties?.name ?? edge.to.replace(/^domain:/, ''),
    kind: node?.properties?.kind ?? null,
  };
}

/** Symbol nodes a file DECLARES, in source order (line, then name). */
export function symbolsOfFile(graph, fileId) {
  return graph.neighbors(fileId, { dir: 'out', type: 'DECLARES' })
    .map((e) => graph.getNode(e.to))
    .filter(Boolean)
    .sort((a, b) => (a.properties?.line ?? 0) - (b.properties?.line ?? 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Files that REFERENCE a symbol. Same-file references are excluded by default:
 * an export used only by its own module is not used by anyone else.
 * @returns {string[]} sorted repo-relative paths.
 */
export function referencingFiles(graph, symId, { includeSameFile = false } = {}) {
  const paths = new Set();
  for (const e of graph.neighbors(symId, { dir: 'in', type: 'REFERENCES' })) {
    if (!includeSameFile && e.properties?.sameFile === true) continue;
    paths.add(fileIdToPath(e.from));
  }
  return [...paths].sort();
}

/** Direct importers of a file id, as sorted file ids. */
export function directImporters(graph, fileId) {
  const ids = new Set(graph.neighbors(fileId, { dir: 'in', type: 'IMPORTS' }).map((e) => e.from));
  return [...ids].sort();
}

/**
 * Blast radius: every file that (transitively) imports any of `seedIds`.
 * BFS over incoming IMPORTS edges, seeds excluded from the result.
 * @returns {{ byId: Map<string, number>, depthCapReached: boolean }} id → depth first reached.
 */
export function transitiveImporters(graph, seedIds, { maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  const cap = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : DEFAULT_MAX_DEPTH;
  const seeds = new Set(seedIds);
  const byId = new Map();
  let frontier = [...seeds];
  let depth = 0;
  let depthCapReached = false;
  while (frontier.length > 0) {
    if (depth >= cap) { depthCapReached = true; break; }
    depth += 1;
    const next = [];
    for (const id of frontier) {
      for (const e of graph.neighbors(id, { dir: 'in', type: 'IMPORTS' })) {
        if (seeds.has(e.from) || byId.has(e.from)) continue;
        byId.set(e.from, depth);
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return { byId, depthCapReached };
}

/** Split a file's outgoing IMPORTS into internal paths and external package names. */
export function importsOfFile(graph, fileId) {
  const internal = new Set();
  const external = new Set();
  for (const e of graph.neighbors(fileId, { dir: 'out', type: 'IMPORTS' })) {
    if (e.to.startsWith('pkg:')) {
      external.add(graph.getNode(e.to)?.properties?.name ?? e.to.slice('pkg:'.length));
    } else {
      internal.add(fileIdToPath(e.to));
    }
  }
  return { internal: [...internal].sort(), external: [...external].sort() };
}

/** File ids assigned to a domain id, sorted. */
export function filesOfDomain(graph, domainId) {
  return graph.neighbors(domainId, { dir: 'in', type: 'BELONGS_TO' })
    .map((e) => e.from)
    .sort();
}

/** Cap a list, returning the slice plus the untruncated total. */
export function capped(list, limit) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : list.length;
  return { count: list.length, items: list.slice(0, n), truncated: list.length > n };
}
