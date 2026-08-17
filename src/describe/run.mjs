// `loregraph describe` — the "what and why" layer.
//
// The graph proves STRUCTURE: what imports what, who references what. It cannot
// know INTENT. This command asks a model for a short description of a domain, a
// file or a symbol and caches it, so an agent asking "what is this and why does
// it exist" reads ~30 tokens instead of the source.
//
// It is the only command in loregraph that can spend the user's money, so it is
// built to never surprise them:
//   - it prints an estimate (items, approximate tokens, cost — or "unknown"
//     when we have no price on record) BEFORE any paid call;
//   - it asks for confirmation unless `--yes`;
//   - `--dry-run` prints that estimate and exits, having made zero calls and
//     written nothing;
//   - `--budget N` / `--budget-tokens N` stop cleanly and report the remainder;
//   - a re-run only pays for what actually changed, keyed by content hash.
//
// One failing item never aborts the run: the failure is recorded, the run
// continues, and the report names it.
//
// Exit codes: 0 done (INCLUDING a run with per-item failures, or one stopped by
// a budget — both are reported) · 2 usage error, missing cache, or no provider
// configured.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import { collectTargets, kindsForScope, SCOPES, DEFAULT_SCOPE } from './lib/targets.mjs';
import { buildPrompt } from './lib/prompt.mjs';
import { resolveProvider, DEFAULT_TIMEOUT_MS } from './lib/provider.mjs';
import { estimateRun, formatEstimate } from './lib/estimate.mjs';
import { loadDescriptions, writeDescriptions, isFresh, KINDS } from './lib/store.mjs';

/** Parse a flag that must be a positive integer. */
function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return { error: `describe: ${name} must be a positive integer, got ${value}` };
  return { value: n };
}

/** Ask once on stdin. Resolves to true only for an explicit yes. */
function confirm(question) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(/^\s*(y|yes)\s*$/i.test(answer));
    });
  });
}

/** Collapse a generated answer to one clean paragraph. */
function tidy(text) {
  return String(text).replace(/\s+/g, ' ').trim();
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
        scope: { type: 'string' },
        top: { type: 'string' },
        command: { type: 'string' },
        model: { type: 'string' },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        budget: { type: 'string' },
        'budget-tokens': { type: 'string' },
        timeout: { type: 'string' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
  } catch (err) {
    console.error(`describe: usage error: ${err.message}`);
    return 2;
  }

  const flags = cfg._flags;
  const describeCfg = cfg.describe ?? {};

  // --- Options: flag → config file → default -------------------------------
  const scope = flags.scope ?? describeCfg.scope ?? DEFAULT_SCOPE;
  if (kindsForScope(scope) === null) {
    console.error(`describe: --scope must be one of ${SCOPES.join('|')}, got ${scope}`);
    return 2;
  }

  let top;
  if (flags.top !== undefined) {
    const parsed = positiveInt(flags.top, '--top');
    if (parsed.error) { console.error(parsed.error); return 2; }
    top = parsed.value;
  } else if (Number.isInteger(describeCfg.top)) {
    top = describeCfg.top;
  }

  let budgetItems = null;
  if (flags.budget !== undefined) {
    const parsed = positiveInt(flags.budget, '--budget');
    if (parsed.error) { console.error(parsed.error); return 2; }
    budgetItems = parsed.value;
  }

  let budgetTokens = null;
  if (flags['budget-tokens'] !== undefined) {
    const parsed = positiveInt(flags['budget-tokens'], '--budget-tokens');
    if (parsed.error) { console.error(parsed.error); return 2; }
    budgetTokens = parsed.value;
  }

  let timeoutMs = Number.isInteger(describeCfg.timeoutMs) ? describeCfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (flags.timeout !== undefined) {
    const parsed = positiveInt(flags.timeout, '--timeout');
    if (parsed.error) { console.error(parsed.error); return 2; }
    timeoutMs = parsed.value;
  }

  const dryRun = flags['dry-run'] === true;
  const assumeYes = flags.yes === true;
  const force = flags.force === true;
  const asJson = flags.json === true;

  // --- The graph -----------------------------------------------------------
  const cache = flags.cache ? resolve(cwd, flags.cache) : cfg.outDir;
  if (!existsSync(cache)) {
    console.error(`describe: cache dir not found: ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }
  const graph = loadGraph(cache);
  if (graph.loadedLayers.length === 0) {
    console.error(`describe: no graph artifacts under ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  const staleness = checkStaleness(cache);
  if (staleness.stale === true && staleness.cacheRevision) {
    process.stderr.write(
      `[loregraph] warning: cache is at ${staleness.cacheRevision}, repo is at ${staleness.currentRevision}`
      + ' — descriptions would be written for older code. Run `loregraph regenerate` first.\n',
    );
  }

  // --- What could be described, and what already is ------------------------
  const repoRoot = graph.manifest?.repoRoot ?? cfg.repoRoot;
  const { targets, totals } = collectTargets(graph, { scope, top, repoRoot });
  if (targets.length === 0) {
    console.log(`[loregraph] describe: nothing to describe at --scope ${scope} — the graph has no items of that kind.`);
    return 0;
  }

  const cached = loadDescriptions(cache);
  const pending = [];
  let reused = 0;
  for (const target of targets) {
    if (!force && isFresh(cached.get(target.id), target)) {
      reused += 1;
      continue;
    }
    pending.push({ target, prompt: buildPrompt(target) });
  }

  // --- The provider (resolved before the estimate so it can be named) ------
  const provider = resolveProvider({
    command: flags.command ?? describeCfg.command,
    model: flags.model ?? describeCfg.model,
    timeoutMs,
  });
  if (!provider.ok) {
    console.error(provider.error);
    return 2;
  }

  // --- The estimate — printed before anything is spent ---------------------
  const estimate = estimateRun(pending.map((p) => p.prompt), {
    model: provider.model,
    provider: provider.provider,
    pricing: describeCfg.pricing,
  });

  if (asJson && dryRun) {
    console.log(JSON.stringify({ scope, totals, cached: reused, estimate, dryRun: true }, null, 2));
    return 0;
  }

  // With --json, stdout belongs to the JSON payload alone — the human-readable
  // estimate still has to be seen before anything is spent, so it goes to stderr.
  const say = (line) => (asJson ? process.stderr.write(`${line}\n`) : console.log(line));

  say(`[loregraph] describe --scope ${scope}${top ? ` --top ${top}` : ''}`);
  say(formatEstimate(estimate, { cached: reused, totals }));

  if (pending.length === 0) {
    say('\nEverything in scope is already described and unchanged. Nothing to do, nothing spent.');
    if (asJson) {
      console.log(JSON.stringify({
        scope, provider: provider.provider, model: provider.model, described: 0,
        reusedFromCache: reused, failed: 0, failures: [], stoppedBy: null, remaining: 0,
        estimatedTokensSpent: 0, files: [],
      }, null, 2));
    }
    return 0;
  }

  if (dryRun) {
    say('\n--dry-run: no calls made, nothing written.');
    return 0;
  }

  // --- Confirmation --------------------------------------------------------
  if (!assumeYes) {
    if (!process.stdin.isTTY) {
      console.error(
        '\ndescribe: refusing to spend without confirmation on a non-interactive stdin.'
        + '\n  Re-run with --yes to accept the estimate above, or --dry-run to just see it.',
      );
      return 2;
    }
    const ok = await confirm(`\nProceed with ${pending.length} call(s)? [y/N] `);
    if (!ok) {
      say('Aborted. Nothing was spent.');
      return 0;
    }
  }

  // --- The run -------------------------------------------------------------
  const generatedAt = new Date().toISOString();
  const rowsByKind = new Map(KINDS.map((k) => [k, []]));
  const failures = [];
  let spentTokens = 0;
  let describedCount = 0;
  let stoppedBy = null;
  let remaining = 0;

  for (let i = 0; i < pending.length; i += 1) {
    const { target, prompt } = pending[i];

    if (budgetItems !== null && describedCount >= budgetItems) {
      stoppedBy = `--budget ${budgetItems} item(s)`;
      remaining = pending.length - i;
      break;
    }
    const wouldSpend = estimateRun([prompt], { model: provider.model }).inputTokens
      + estimate.maxOutputTokensPerItem;
    if (budgetTokens !== null && spentTokens + wouldSpend > budgetTokens) {
      stoppedBy = `--budget-tokens ${budgetTokens}`;
      remaining = pending.length - i;
      break;
    }

    try {
      const text = tidy(await provider.describeOne(prompt));
      rowsByKind.get(target.kind).push({
        targetId: target.id,
        kind: target.kind,
        contentHash: target.contentHash,
        text,
        model: provider.model,
        provider: provider.provider,
        generatedAt,
      });
      describedCount += 1;
      spentTokens += wouldSpend;
      process.stderr.write(`  [${describedCount}/${pending.length}] ${target.id}\n`);
    } catch (err) {
      // One bad item must not cost the whole run: record it and keep going.
      failures.push({ targetId: target.id, error: err?.message ?? String(err) });
      process.stderr.write(`  [!] ${target.id}: ${err?.message ?? err}\n`);
    }
  }

  // --- Write ---------------------------------------------------------------
  const written = [];
  for (const kind of KINDS) {
    const rows = rowsByKind.get(kind) ?? [];
    if (rows.length === 0) continue;
    // Prune only rows whose target has vanished from the graph entirely — a
    // `--top N` run must not delete the descriptions it did not look at.
    const keepIds = new Set(graph.nodesById.keys());
    written.push({ kind, ...writeDescriptions(cache, kind, rows, { keepIds }) });
  }

  // --- Report --------------------------------------------------------------
  const summary = {
    scope,
    provider: provider.provider,
    model: provider.model,
    described: describedCount,
    reusedFromCache: reused,
    failed: failures.length,
    failures,
    stoppedBy,
    remaining,
    estimatedTokensSpent: spentTokens,
    files: written.map((w) => w.path),
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log(`\n[loregraph] described=${describedCount} cached=${reused} failed=${failures.length}`
    + `  ~${spentTokens.toLocaleString('en-US')} tokens`);
  for (const w of written) console.log(`  ${w.kind}: ${w.path} (${w.written} row(s))`);
  if (stoppedBy) {
    console.log(`\nStopped by ${stoppedBy}. ${remaining} item(s) left undescribed — re-run to continue `
      + '(what is already described will not be paid for again).');
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} item(s) failed and were skipped:`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f.targetId}: ${f.error}`);
    if (failures.length > 10) console.log(`  (+${failures.length - 10} more)`);
    console.log('Re-run to retry them; the successful ones are cached and will not be paid for again.');
  }
  if (describedCount > 0) {
    console.log('\nDescriptions are MODEL-GENERATED. `brief`, `docs`, the explorer and the MCP'
      + ' `describe` tool always show them labelled with the model that wrote them.');
  }
  return 0;
}
