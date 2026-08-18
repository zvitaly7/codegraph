// `loregraph check` — the CI gate. Every other command describes the repo; this
// one passes judgement on it and can fail a build.
//
// Rules come from the `check` block of `loregraph.config.mjs` (there are no
// rule flags on purpose: a gate that differs between your laptop and CI is not
// a gate). Each configured rule is evaluated, printed with its verdict, and —
// when it fails — with the specific offenders behind it.
//
// Exit codes:
//   0  every configured rule passed, OR no rules were configured (in which case
//      the report says so out loud rather than implying a clean bill of health).
//   1  at least one rule was violated.
//   2  usage error: a mistyped rule name, a rule whose graph layer is missing
//      from the cache, or no cache at all. Nothing was verified, so nothing is
//      being claimed.

import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import {
  evaluateCheck, renderCheck, unknownRuleKeys, missingPrerequisites, RULE_KEYS,
} from './lib/check.mjs';

/** The import resolution rate the imports layer recorded, or null. */
function readResolutionRate(cache) {
  const path = join(cache, 'imports', 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    const rate = JSON.parse(readFileSync(path, 'utf8'))?.resolutionRate;
    return Number.isFinite(rate) ? rate : null;
  } catch {
    return null;
  }
}

export async function run(argv) {
  const cwd = process.cwd();

  let cfg;
  try {
    cfg = await resolveConfig({
      cwd,
      argv,
      extraOptions: { cache: { type: 'string' }, json: { type: 'boolean' } },
    });
  } catch (err) {
    console.error(`check: usage error: ${err.message}`);
    return 2;
  }

  const flags = cfg._flags;
  const rules = cfg.check ?? {};

  // A typo in a rule name would otherwise check nothing and report success.
  const unknown = unknownRuleKeys(rules);
  if (unknown.length > 0) {
    console.error(
      `check: unknown rule${unknown.length === 1 ? '' : 's'} in the config \`check\` block: `
      + `${unknown.join(', ')} — valid rules are ${RULE_KEYS.join(', ')}`,
    );
    return 2;
  }

  const cache = flags.cache ? resolve(cwd, flags.cache) : cfg.outDir;
  if (!existsSync(cache)) {
    console.error(`check: cache dir not found: ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  const graph = loadGraph(cache);
  if (graph.loadedLayers.length === 0) {
    console.error(`check: no graph artifacts under ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  // A rule that cannot be answered must not come back green.
  const missing = missingPrerequisites(rules, graph.loadedLayers);
  if (missing.length > 0) {
    for (const { rule, layer } of missing) {
      console.error(
        `check: rule \`${rule}\` needs the ${layer} layer, which is not in ${cache} — `
        + `run \`loregraph ${layer}\` (or \`loregraph regenerate\`) first`,
      );
    }
    return 2;
  }

  const staleness = checkStaleness(cache);
  if (staleness.stale === true && staleness.cacheRevision) {
    process.stderr.write(
      `[loregraph] warning: cache is at ${staleness.cacheRevision}, repo is at `
      + `${staleness.currentRevision} — check may be judging stale data, run \`loregraph regenerate\`\n`,
    );
  }

  const report = evaluateCheck(graph, rules, { resolutionRate: readResolutionRate(cache) });
  console.log(flags.json ? JSON.stringify(report, null, 2) : renderCheck(report));

  return report.ok ? 0 : 1;
}
