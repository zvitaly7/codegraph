import { resolve } from 'node:path';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import { serve } from './lib/rpc.mjs';

/**
 * `loregraph mcp` — start the stdio MCP server over the loaded graph.
 *
 * Reads the graph artifacts under `--cache DIR` (default: the resolved
 * `outDir`), then serves JSON-RPC 2.0 on stdin/stdout. stdout carries ONLY
 * protocol messages — all diagnostics go to stderr. Returns a numeric exit code:
 *   0 clean shutdown (stdin EOF) · 1 load failure · 2 usage error.
 */
export async function run(argv) {
  const cwd = process.cwd();

  let cfg;
  try {
    cfg = await resolveConfig({ cwd, argv, extraOptions: { cache: { type: 'string' } } });
  } catch (err) {
    process.stderr.write(`mcp: usage error: ${err.message}\n`);
    return 2;
  }

  const cacheDir = cfg._flags.cache ? resolve(cwd, cfg._flags.cache) : cfg.outDir;

  // Non-blocking freshness notice: warn (once, to stderr only) when the cache
  // was built from a different revision than the repo is on now. `vcs-unknown`
  // and `no-cache` carry no revisions to compare, so they stay silent here.
  const staleness = checkStaleness(cacheDir);
  if (staleness.stale === true && staleness.cacheRevision) {
    process.stderr.write(
      `[loregraph] warning: graph cache is at ${staleness.cacheRevision}, `
      + `repo is at ${staleness.currentRevision} `
      + '— run `loregraph regenerate` to refresh\n',
    );
  }

  let graph;
  try {
    graph = loadGraph(cacheDir);
  } catch (err) {
    process.stderr.write(`mcp: failed to load graph from ${cacheDir}: ${err.message}\n`);
    return 1;
  }

  const layers = graph.loadedLayers.length > 0 ? graph.loadedLayers.join(',') : 'none';
  process.stderr.write(
    `[loregraph mcp] cache=${cacheDir} layers=${layers} `
    + `nodes=${graph.stats.nodes} edges=${graph.stats.edges}\n`,
  );
  if (graph.empty) {
    process.stderr.write('[loregraph mcp] graph empty — run `loregraph regenerate`\n');
  }

  await serve(graph, { input: process.stdin, output: process.stdout });
  return 0;
}
