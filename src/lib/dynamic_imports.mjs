// The one blind spot this tool can measure but cannot close.
//
// `await import(pathToFileURL(x).href)` is a real edge in the running program
// with a specifier that exists only at runtime. Nothing static can follow it —
// not this tool, not the TypeScript type-checker, not a bundler. So a module
// reached ONLY that way has no incoming IMPORTS edge, its exports have no
// incoming REFERENCES edge, and it shows up as dead code that is very much alive.
//
// We cannot fix that. What we refuse to do is be silently wrong about it. The
// imports layer counts every such site while it is already reading each file
// (../imports/lib/specifier_extractor.mjs) and records the per-file count on the
// File node; this module turns that into the repo-wide figure and the ONE
// sentence every consumer uses, so the caveat cannot drift between the MCP tool,
// the CLI, the docs and the explorer.
//
// This makes the graph no more accurate. It makes the uncertainty STATED.

/**
 * How many `import(<non-literal>)` sites the graph knows about, and in how many
 * files. A graph built before this layer existed simply reports zero.
 *
 * @param {{nodesById?: Map<string, object>}} graph loaded graph (see ./graph_load.mjs).
 * @returns {{total: number, files: number}}
 */
export function computedDynamicImports(graph) {
  let total = 0;
  let files = 0;
  for (const node of graph?.nodesById?.values() ?? []) {
    const n = node.properties?.computedDynamicImports;
    if (typeof n === 'number' && n > 0) {
      total += n;
      files += 1;
    }
  }
  return { total, files };
}

/** `3 computed dynamic imports in 2 files` — the shared noun phrase. */
function phrase({ total, files }) {
  return `${total} computed dynamic import${total === 1 ? '' : 's'} `
    + `in ${files} file${files === 1 ? '' : 's'}`;
}

/**
 * The caveat to print next to any answer about what is unreferenced. Says the
 * size of the doubt, then what it does to THIS answer — a bare "dynamic imports
 * exist" tells a reader nothing they can act on.
 *
 * @param {{total: number, files: number}} tally
 * @returns {string}
 */
export function deadCodeCaveat(tally) {
  return `${phrase(tally)} cannot be followed, so a symbol used only that way `
    + 'will appear here as unreferenced. Check those call sites before deleting anything.';
}

/** The same caveat for a reachability answer that is not a list of candidates. */
export function reachabilityCaveat(tally) {
  return `${phrase(tally)} cannot be followed, so anything reached only that way `
    + 'is missing from this graph.';
}
