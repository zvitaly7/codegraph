import { resolve } from 'node:path';
import { resolveConfig } from '../config/load.mjs';
import { loadGraph } from './lib/graph.mjs';
import { serve } from './lib/rpc.mjs';

/**
 * `codegraph mcp` — start the stdio MCP server over the loaded graph.
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

  let graph;
  try {
    graph = loadGraph(cacheDir);
  } catch (err) {
    process.stderr.write(`mcp: failed to load graph from ${cacheDir}: ${err.message}\n`);
    return 1;
  }

  const layers = graph.loadedLayers.length > 0 ? graph.loadedLayers.join(',') : 'none';
  process.stderr.write(
    `[codegraph mcp] cache=${cacheDir} layers=${layers} `
    + `nodes=${graph.stats.nodes} edges=${graph.stats.edges}\n`,
  );
  if (graph.empty) {
    process.stderr.write('[codegraph mcp] graph empty — run `codegraph regenerate`\n');
  }

  await serve(graph, { input: process.stdin, output: process.stdout });
  return 0;
}
