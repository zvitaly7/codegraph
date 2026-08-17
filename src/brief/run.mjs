// `loregraph brief <target>` — print the context pack for a file, domain or symbol.
//
// Reads the cached graph under `--cache DIR` (default: the resolved outDir) and
// prints a few dense lines to stdout — or the raw structured object with --json.
// The whole point is to replace "open ten files to find your bearings" with one
// small, cheap answer, so lists are capped by --limit (default 10) and, if the
// caller asks, by --max-tokens (a hard cap on the whole answer, cut visibly).
//
// Exit codes: 0 answered (INCLUDING an ambiguous or unmatched target — the
// payload carries the candidates, which is the useful answer) · 2 usage error
// or no graph artifacts under the cache dir.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import { loadDescriptions } from '../describe/lib/store.mjs';
import { ANSWER_OPTIONS, resolveCompressPaths, resolveMaxTokens } from '../lib/answer_render.mjs';
import { buildBrief, fitBrief, DEFAULT_LIMIT } from './lib/brief.mjs';

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
        ...ANSWER_OPTIONS,
      },
    });
  } catch (err) {
    console.error(`brief: usage error: ${err.message}`);
    return 2;
  }

  const flags = cfg._flags;
  const target = cfg._positionals[0];
  if (!target) {
    console.error('brief: missing <target> — a file path, domain name or symbol name');
    return 2;
  }

  let limit = DEFAULT_LIMIT;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`brief: --limit must be a positive integer, got ${flags.limit}`);
      return 2;
    }
  }

  const budget = resolveMaxTokens(flags);
  if (budget.error) {
    console.error(`brief: ${budget.error}`);
    return 2;
  }

  const cache = flags.cache ? resolve(cwd, flags.cache) : cfg.outDir;
  if (!existsSync(cache)) {
    console.error(`brief: cache dir not found: ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  const graph = loadGraph(cache);
  if (graph.loadedLayers.length === 0) {
    console.error(`brief: no graph artifacts under ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  // Non-blocking freshness notice — a brief built from a stale cache is still
  // worth having, the reader just needs to know.
  const staleness = checkStaleness(cache);
  if (staleness.stale === true && staleness.cacheRevision) {
    process.stderr.write(
      `[loregraph] warning: cache is at ${staleness.cacheRevision}, repo is at `
      + `${staleness.currentRevision} — run \`loregraph regenerate\`\n`,
    );
  }

  // Cached, model-written descriptions when `loregraph describe` has been run.
  // They are additive and always labelled; a cache without any simply has none.
  const descriptions = loadDescriptions(cache);

  const brief = buildBrief(graph, target, { limit, descriptions });
  const fit = fitBrief(brief, {
    mode: flags.json ? 'json' : 'text',
    jsonSpace: 2,
    compress: resolveCompressPaths(flags, cfg),
    maxTokens: budget.value,
  });
  console.log(fit.text);
  return 0;
}
