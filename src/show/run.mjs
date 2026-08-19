// `loregraph show <symbol>` — print the source of exactly one symbol.
//
// The graph cache, when there is one, is used ONLY to narrow the search to the
// files that declare a symbol of that name (fast, and it disambiguates across
// files). The source range itself always comes from re-parsing the file now —
// see the rationale at the top of ./lib/show.mjs. With no cache, or when the
// cache's answer no longer holds, the repo's source files are scanned instead,
// so `show` works on a repo that has never been indexed and cannot be misled by
// a stale one.
//
// Exit codes: 0 answered (INCLUDING an ambiguous or unmatched symbol — the
// candidate list is the useful answer) · 2 usage error.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import { formatShow, parseSymbolRef, DEFAULT_CONTEXT } from './lib/show.mjs';
import { lookupSymbol } from './lib/lookup.mjs';
import { withEnvelope } from '../lib/json_envelope.mjs';

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
        context: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`show: usage error: ${err.message}`);
    return 2;
  }

  const flags = cfg._flags;
  const target = cfg._positionals[0];
  if (!target) {
    console.error('show: missing <symbol> — a name, path#name, or a sym:path#name id');
    return 2;
  }

  let context = DEFAULT_CONTEXT;
  if (flags.context !== undefined) {
    context = Number(flags.context);
    if (!Number.isInteger(context) || context < 0) {
      console.error(`show: --context must be a non-negative integer, got ${flags.context}`);
      return 2;
    }
  }

  const parsed = parseSymbolRef(target);
  if (!parsed) {
    console.error(`show: could not read "${target}" as a symbol reference`);
    return 2;
  }

  // The cache is optional: it only narrows WHICH files are searched. A stale
  // one costs a rescan, never a wrong line range (see ./lib/show.mjs).
  const cache = flags.cache ? resolve(cwd, flags.cache) : cfg.outDir;
  let graph = null;
  if (existsSync(cache)) {
    graph = loadGraph(cache);
    const staleness = checkStaleness(cache);
    if (staleness.stale === true && staleness.cacheRevision) {
      process.stderr.write(
        `[loregraph] warning: cache is at ${staleness.cacheRevision}, repo is at `
        + `${staleness.currentRevision} — the file is re-parsed, so the source below is current\n`,
      );
    }
  }

  const payload = lookupSymbol({
    repoRoot: cfg.repoRoot, ref: target, graph, context, ignoreFile: cfg.ignoreFile,
  });
  console.log(flags.json ? JSON.stringify(withEnvelope(payload), null, 2) : formatShow(payload));
  return 0;
}
