// `loregraph cycles` — circular dependencies, in two scopes.
//
//   --scope file    import cycles between this repo's own files
//   --scope domain  dependency cycles between domains, with hop weights
//   --scope both    (default) one report containing each
//
// Reporting a cycle is not a policy: this command always exits 0 when it could
// answer. `loregraph check` is what fails a build on one.
//
// Exit codes: 0 answered (cycles or not) · 2 usage error, or no graph artifacts
// under the cache dir.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import { buildCycles, renderCycles, SCOPES, DEFAULT_LIMIT } from '../lib/cycles.mjs';

export async function run(argv) {
  const cwd = process.cwd();

  let cfg;
  try {
    cfg = await resolveConfig({
      cwd,
      argv,
      extraOptions: {
        cache: { type: 'string' },
        json: { type: 'boolean' },
        limit: { type: 'string' },
        scope: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`cycles: usage error: ${err.message}`);
    return 2;
  }

  const flags = cfg._flags;

  const scope = flags.scope ?? 'both';
  if (!SCOPES.includes(scope)) {
    console.error(`cycles: --scope must be one of ${SCOPES.join('|')}, got ${scope}`);
    return 2;
  }

  let limit = DEFAULT_LIMIT;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      console.error(`cycles: --limit must be a positive integer, got ${flags.limit}`);
      return 2;
    }
  }

  const cache = flags.cache ? resolve(cwd, flags.cache) : cfg.outDir;
  if (!existsSync(cache)) {
    console.error(`cycles: cache dir not found: ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  const graph = loadGraph(cache);
  if (graph.loadedLayers.length === 0) {
    console.error(`cycles: no graph artifacts under ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  // A stale cache still answers — the reader just needs to know it is behind.
  const staleness = checkStaleness(cache);
  if (staleness.stale === true && staleness.cacheRevision) {
    process.stderr.write(
      `[loregraph] warning: cache is at ${staleness.cacheRevision}, repo is at `
      + `${staleness.currentRevision} — cycles may be stale, run \`loregraph regenerate\`\n`,
    );
  }

  const report = buildCycles(graph, { scope, limit });
  console.log(flags.json ? JSON.stringify(report, null, 2) : renderCycles(report));
  return 0;
}
