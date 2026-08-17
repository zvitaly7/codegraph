// `loregraph docs` — generate the agent-facing Markdown docs from the graph.
//
// Teams hand-write an `AGENTS.md` plus a few topic pages and then watch them
// drift. These are rendered from the computed graph instead, so they cannot:
// every number and every link is a fact the graph can back up.
//
// Layout:
//   <repoRoot>/AGENTS.md          entry point for agents (--agents-out moves it)
//   <out-docs>/README.md          index                  (default <repoRoot>/docs/loregraph)
//   <out-docs>/domains/<d>.md     one page per domain
//   <out-docs>/dependencies.md    cross-domain map, packages, importers
//   <out-docs>/health.md          dead exports + orphan candidates
//
// Hand-written text is safe: only the region between the generated markers is
// replaced, and a target file with no markers at all is skipped (a human wrote
// it) unless `--force`.
//
// Exit codes: 0 generated (even if some files were skipped, or the cache was
// stale — both are warnings) · 2 usage error or no graph under the cache dir.

import { resolve, join, dirname, relative, sep } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import { writeTextAtomic } from '../inventory/write.mjs';
import { loadDescriptions } from '../describe/lib/store.mjs';
import { renderDocs, STRINGS, DEFAULT_LANG } from './lib/render.mjs';
import { mergeGenerated } from './lib/merge.mjs';

/** Where the docs go when `--out-docs` is not given. */
const DEFAULT_DOCS_SUBDIR = join('docs', 'loregraph');

/**
 * A POSIX markdown link from one directory to another. A relative link that
 * climbs out of the tree (`--out-docs` pointing outside the repo) is useless to
 * a reader, so those degrade to the absolute path.
 */
function linkPath(from, to) {
  const rel = relative(from, to).split(sep).join('/');
  if (rel === '') return '.';
  return rel.startsWith('..') ? to.split(sep).join('/') : rel;
}

function warn(message) {
  process.stderr.write(`[loregraph] ${message}\n`);
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
        'out-docs': { type: 'string' },
        'agents-out': { type: 'string' },
        lang: { type: 'string' },
        force: { type: 'boolean' },
      },
    });
  } catch (err) {
    console.error(`docs: usage error: ${err.message}`);
    return 2;
  }

  const flags = cfg._flags;

  // --- Language: flag → config file → default -----------------------------
  const lang = flags.lang ?? cfg.lang ?? DEFAULT_LANG;
  if (!Object.hasOwn(STRINGS, lang)) {
    console.error(`docs: --lang must be one of ${Object.keys(STRINGS).join('|')}, got ${lang}`);
    return 2;
  }

  // --- Where everything lands ---------------------------------------------
  const cache = flags.cache ? resolve(cwd, flags.cache) : cfg.outDir;
  const outDocs = flags['out-docs']
    ? resolve(cwd, flags['out-docs'])
    : join(cfg.repoRoot, DEFAULT_DOCS_SUBDIR);
  const agentsOut = flags['agents-out']
    ? resolve(cwd, flags['agents-out'])
    : join(cfg.repoRoot, 'AGENTS.md');

  // --- The graph ------------------------------------------------------------
  if (!existsSync(cache)) {
    console.error(`docs: cache dir not found: ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }
  const graph = loadGraph(cache);
  if (graph.loadedLayers.length === 0) {
    console.error(`docs: no graph artifacts under ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  // Docs built from a stale cache still beat no docs — say so and continue.
  const staleness = checkStaleness(cache);
  if (staleness.stale === true && staleness.reason === 'revision-changed') {
    warn(`warning: cache is stale — built at ${staleness.cacheRevision}, repo is at `
      + `${staleness.currentRevision}. Run \`loregraph regenerate\` for current docs.`);
  }

  // --- Render + merge + write ----------------------------------------------
  // Model-written descriptions, when `loregraph describe` has produced any. The
  // pages stay byte-deterministic: same cache in, same Markdown out.
  const descriptions = loadDescriptions(cache);

  const pages = renderDocs(graph, {
    lang,
    docsPath: linkPath(dirname(agentsOut), outDocs),
    agentsLink: linkPath(outDocs, agentsOut),
    descriptions,
  });

  const force = flags.force === true;
  const tally = { created: 0, merged: 0, replaced: 0, unchanged: 0, skipped: 0 };

  for (const page of pages) {
    const target = page.kind === 'agents' ? agentsOut : join(outDocs, page.path);
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
    const result = mergeGenerated(existing, page.content, { force });

    if (result.action === 'skipped') {
      tally.skipped += 1;
      warn(`skipped ${target} — it has no loregraph markers, so it looks hand-written. `
        + 'Add the markers where the generated block should go, or pass --force to overwrite.');
      continue;
    }
    if (!result.changed) {
      tally.unchanged += 1;
      continue;
    }
    writeTextAtomic(target, result.content);
    tally[result.action] += 1;
  }

  const counts = Object.entries(tally)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ') || 'nothing to do';
  console.log(`[loregraph] docs lang=${lang} pages=${pages.length} ${counts}`);
  console.log(`  AGENTS.md: ${agentsOut}`);
  console.log(`  pages:     ${outDocs}`);
  return 0;
}
