// `loregraph impact` — review context for a change: what it touches, what it
// might break, and which tests to run.
//
// The changed set comes from either `--files a.ts,b.ts` (explicit) or a VCS
// diff: `--diff <ref>` compares the WORKING TREE against `<ref>`, so the default
// `--diff HEAD` means "my uncommitted changes" and `--diff main` means "this
// branch". Added, modified AND deleted files all count — a deletion is exactly
// the change whose importers break.
//
// Exit codes: 0 answered (including an empty change set) · 1 the changed set
// could not be determined (git unavailable / unknown revision) · 2 usage error
// or no graph artifacts under the cache dir.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import { changedFilesSince } from '../lib/changed_files.mjs';
import { buildImpact, formatImpact, DEFAULT_LIMIT } from './lib/impact.mjs';

/** Positive-integer flag parse; returns null when absent, NaN-ish when invalid. */
function intFlag(value) {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

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
        diff: { type: 'string' },
        files: { type: 'string', multiple: true },
        'max-depth': { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`impact: usage error: ${err.message}`);
    return 2;
  }

  const flags = cfg._flags;

  const limit = intFlag(flags.limit) ?? DEFAULT_LIMIT;
  if (Number.isNaN(limit)) {
    console.error(`impact: --limit must be a positive integer, got ${flags.limit}`);
    return 2;
  }
  const maxDepth = intFlag(flags['max-depth']);
  if (Number.isNaN(maxDepth)) {
    console.error(`impact: --max-depth must be a positive integer, got ${flags['max-depth']}`);
    return 2;
  }

  const cache = flags.cache ? resolve(cwd, flags.cache) : cfg.outDir;
  if (!existsSync(cache)) {
    console.error(`impact: cache dir not found: ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  const graph = loadGraph(cache);
  if (graph.loadedLayers.length === 0) {
    console.error(`impact: no graph artifacts under ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  // --- the changed set ----------------------------------------------------
  let changed;
  let source;
  if (flags.files !== undefined) {
    // Accept both `--files a,b` and repeated `--files a --files b`.
    changed = [flags.files].flat().flatMap((v) => String(v).split(','))
      .map((s) => s.trim()).filter(Boolean);
    source = 'files';
  } else {
    const ref = flags.diff ?? 'HEAD';
    const delta = changedFilesSince(cfg.repoRoot, ref);
    if (!delta.ok) {
      console.error(
        `impact: could not determine changes vs ${ref} in ${cfg.repoRoot} `
        + '(git unavailable or unknown revision) — pass --files instead',
      );
      return 1;
    }
    changed = [...delta.added, ...delta.modified, ...delta.deleted];
    source = `diff ${ref}`;
  }

  // A stale cache still answers — the reader just needs to know it is behind.
  const staleness = checkStaleness(cache);
  if (staleness.stale === true && staleness.cacheRevision) {
    process.stderr.write(
      `[loregraph] warning: cache is at ${staleness.cacheRevision}, repo is at `
      + `${staleness.currentRevision} — impact may be stale, run \`loregraph regenerate\`\n`,
    );
  }

  const report = buildImpact(graph, changed, { limit, maxDepth: maxDepth ?? undefined, source });
  console.log(flags.json ? JSON.stringify(report, null, 2) : formatImpact(report));
  return 0;
}
