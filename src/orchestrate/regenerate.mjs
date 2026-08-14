import { resolve } from 'node:path';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';

/**
 * `loregraph regenerate` — the one-shot orchestrator. Runs every graph layer in
 * dependency order against a SINGLE repo snapshot, all sharing one base cache, so
 * the resulting artifacts are mutually consistent. Fail-fast: the first layer to
 * return a non-zero exit code (or throw) aborts the whole pipeline with that same
 * code, because a half-regenerated cache is worse than an untouched one.
 *
 * ALL orchestrator chatter goes to STDERR. Each layer writes its own summary line
 * to stdout; the orchestrator never touches stdout, so a layer's stdout artifacts
 * (e.g. the MCP server's protocol stream) are never polluted.
 *
 * Layer order:
 *   inventory → imports → symbols → domains → references → usages → explorer
 *
 * The cheap layers (inventory/imports/symbols/domains) always run FULL. The heavy
 * type-checking layers (references, usages) accept `--incremental <off|incremental>`,
 * forwarded from this command; incremental is a byte-identical speed optimization
 * over a full rebuild. `--skip-heavy` omits references/usages (light graph only);
 * `--skip-explorer` omits the browser index (which otherwise runs last).
 *
 * NOTE: references/usages build a TypeScript program over the whole repo and run
 * the type-checker, so on BIG repos the process may need a larger V8 heap — launch
 * it with `NODE_OPTIONS=--max-old-space-size=8192 loregraph regenerate ...`. This
 * is documented, not forced, so small repos stay light.
 */

// Each step is { name, load, heavy? }. `load` dynamically imports the layer
// module, keeping layers lazily loaded (and individually mockable in tests).
const CORE_STEPS = [
  { name: 'inventory', load: () => import('../inventory/run.mjs') },
  { name: 'imports', load: () => import('../imports/run.mjs') },
  { name: 'symbols', load: () => import('../symbols/run.mjs') },
  { name: 'domains', load: () => import('../domains/run.mjs') },
];
const HEAVY_STEPS = [
  { name: 'references', load: () => import('../references/run.mjs'), heavy: true },
  { name: 'usages', load: () => import('../usages/run.mjs'), heavy: true },
];
const EXPLORER_STEP = { name: 'explorer', load: () => import('../explorer/run.mjs') };

/** Write one orchestrator line to stderr (never stdout). */
const emit = (line) => process.stderr.write(`${line}\n`);

/** Human-friendly duration: sub-second in ms, otherwise seconds. */
function fmtDuration(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Orchestrate a full regeneration. Returns a numeric exit code:
 *   0 success · 2 usage error · otherwise the failing layer's own exit code.
 */
export async function run(argv) {
  const cwd = process.cwd();

  let cfg;
  try {
    cfg = await resolveConfig({
      cwd,
      argv,
      extraOptions: {
        'skip-explorer': { type: 'boolean' },
        'skip-heavy': { type: 'boolean' },
        'if-stale': { type: 'boolean' },
        'force': { type: 'boolean' },
        incremental: { type: 'string' },
      },
    });
  } catch (err) {
    emit(`regenerate: usage error: ${err.message}`);
    return 2;
  }

  if (cfg.incremental !== 'off' && cfg.incremental !== 'incremental') {
    emit(`regenerate: --incremental must be 'off' or 'incremental', got ${cfg.incremental}`);
    return 2;
  }

  const { repoRoot, outDir, _flags: flags } = cfg;
  const skipExplorer = Boolean(flags['skip-explorer']);
  const skipHeavy = Boolean(flags['skip-heavy']);

  // --if-stale: only rebuild when the cache is stale (or its staleness is
  // unknown). --force always rebuilds and thus overrides --if-stale. When the
  // cache is DEFINITIVELY up to date (stale === false) we skip the whole
  // pipeline. `vcs-unknown` (stale === null) is NOT "up to date", so we proceed.
  if (Boolean(flags['if-stale']) && !Boolean(flags.force)) {
    const status = checkStaleness(outDir);
    if (status.stale === false) {
      emit(`graph up to date at ${status.currentRevision} — skipping`);
      return 0;
    }
  }

  // Assemble the pipeline from the requested layers.
  const steps = [...CORE_STEPS];
  if (!skipHeavy) steps.push(...HEAVY_STEPS);
  if (!skipExplorer) steps.push(EXPLORER_STEP);

  // Every layer receives the SAME repo + base cache, so the snapshot stays
  // consistent across layers. Forward an explicit --config too, so a shared
  // configuration reaches every layer.
  const baseArgv = ['--repo-root', repoRoot, '--out', outDir];
  if (flags.config) baseArgv.push('--config', resolve(cwd, flags.config));

  emit(`regenerate: repo=${repoRoot}`);
  emit(`regenerate: base cache=${outDir}`);
  if (!skipHeavy) emit(`regenerate: heavy layers mode=${cfg.incremental}`);

  const pipelineStart = performance.now();
  for (const step of steps) {
    emit(`▶ ${step.name}`);
    const stepStart = performance.now();

    // Heavy layers get the incremental mode; everyone else runs full.
    const stepArgv = step.heavy
      ? [...baseArgv, '--incremental', cfg.incremental]
      : [...baseArgv];

    let code;
    try {
      const mod = await step.load();
      code = await mod.run(stepArgv);
    } catch (err) {
      emit(`✗ ${step.name} threw after ${fmtDuration(performance.now() - stepStart)}: ${err?.stack || err?.message || err}`);
      emit(`regenerate: pipeline aborted at "${step.name}" — cache may be partial`);
      return 1;
    }

    if (typeof code === 'number' && code !== 0) {
      emit(`✗ ${step.name} failed (exit ${code}) after ${fmtDuration(performance.now() - stepStart)}`);
      emit(`regenerate: pipeline aborted at "${step.name}" — cache may be partial`);
      return code;
    }

    emit(`✓ ${step.name} (${fmtDuration(performance.now() - stepStart)})`);
  }

  const total = fmtDuration(performance.now() - pipelineStart);
  emit(`✔ regenerate complete in ${total}`);
  emit(`  base cache: ${outDir}`);
  emit('Next:');
  emit(`  Explore/query: loregraph mcp --cache ${outDir}`);
  if (!skipExplorer) {
    emit(`  Browser index: open ${outDir}/explorer/index.html`);
  }
  return 0;
}
