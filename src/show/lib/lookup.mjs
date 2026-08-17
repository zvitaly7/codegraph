// The I/O half of `show`: decide WHICH files to open, then hand them to the
// pure locator in ./show.mjs.
//
// Order matters and is the whole design:
//   1. if a graph is loaded, ask it which files declare a symbol of that name —
//      cheap, and it disambiguates across a repo without parsing all of it;
//   2. otherwise (or when tier 1's answer no longer holds) scan the repo's
//      source files.
// Tier 1 only ever narrows the search. The line range always comes from
// re-parsing the file — see the rationale at the top of ./show.mjs — so a stale
// cache can cost a rescan, never a wrong answer.

import { listSourceFiles } from '../../lib/source_files.mjs';
import { readRepoFile } from '../../lib/file_target.mjs';
import { buildShow, parseSymbolRef, DEFAULT_CONTEXT } from './show.mjs';

/** Repo-relative paths the graph says declare a symbol called `name`. */
export function pathsDeclaring(graph, name) {
  if (!graph || typeof graph.byLabel !== 'function') return [];
  const paths = new Set();
  for (const node of graph.byLabel('Symbol')) {
    if (node.properties?.name !== name) continue;
    const path = node.properties?.path
      ?? (node.id.startsWith('sym:') ? node.id.slice('sym:'.length, node.id.lastIndexOf('#')) : null);
    if (path) paths.add(path);
  }
  return [...paths].sort();
}

/**
 * Locate one symbol and slice its source.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot absolute repo root.
 * @param {string} opts.ref `name`, `path#name` or `sym:path#name`.
 * @param {object} [opts.graph] a loaded graph, when one is available.
 * @param {number} [opts.context] lines of surrounding context.
 * @param {string} [opts.ignoreFile] ignore file to honour while scanning.
 * @returns {object} the `show` payload plus `lookup: 'graph' | 'scan'`.
 */
export function lookupSymbol({ repoRoot, ref, graph = null, context = DEFAULT_CONTEXT, ignoreFile } = {}) {
  const parsed = parseSymbolRef(ref);
  if (!parsed) {
    return {
      kind: 'not-found', symbol: ref ?? null, error: 'symbol must be a non-empty string', candidates: [], lookup: 'none',
    };
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return {
      kind: 'not-found', symbol: ref, name: parsed.name, error: 'no repo root to read sources from', candidates: [], lookup: 'none',
    };
  }

  const readFile = (path) => readRepoFile(repoRoot, path);

  const fromGraph = pathsDeclaring(graph, parsed.name);
  const result = fromGraph.length > 0
    ? buildShow(ref, { files: fromGraph, readFile, context })
    : null;
  if (result !== null && result.kind !== 'not-found') return { ...result, lookup: 'graph' };

  // A symbol the cache places in a file that no longer declares it is not
  // "missing" — it is a stale cache, and the repo still has the answer.
  const files = listSourceFiles(repoRoot, ignoreFile ? { ignoreFile } : undefined);
  return { ...buildShow(ref, { files, readFile, context }), lookup: 'scan' };
}
