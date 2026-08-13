import { resolve } from 'node:path';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';

/**
 * `codegraph regenerate` — the one-shot orchestrator. Runs every graph layer in
 * dependency order against a SINGLE repo snapshot, all sharing one base cache, so
 * the resulting artifacts are mutually consistent. Fail-fast: the first layer to
 * return a non-zero exit code (or throw) aborts the whole pipeline with that same
 * code, because a half-regenerated cache is worse than an untouched one.
 *
 * ALL orchestrator chatter goes to STDERR. Each layer writes its own summary line
 * to stdout; the orchestrator never touches stdout, so a layer's stdout artifacts
 * (e.g. the MCP server's protocol stream) are never polluted.
 *
 * Layer order:  inventory → imports → symbols → domains
 *
 * TODO(references, usages): these heavy AST layers slot in AFTER `symbols` (they
 *   consume the inventory + symbol graphs). They walk and type-resolve every
 *   source, so the process needs a large V8 heap — launch it with
 *   `NODE_OPTIONS=--max-old-space-size=8192`. Not wired yet (their run() stubs
 *   still throw), so they are simply left out of the pipeline for now.
 * TODO(explorer): when `src/explorer/run.mjs` is implemented it runs LAST (it
 *   builds the browser index over the finished graph), unless `--skip-explorer`.
 *   Left out for now — still a stub.
 */

// The core pipeline: an ordered list of { name, load }. `load` dynamically imports
// the layer module, keeping layers lazily loaded (and individually mockable in
// tests). References/usages/explorer are intentionally absent until implemented.
const PIPELINE = [
  { name: 'inventory', load: () => import('../inventory/run.mjs') },
  { name: 'imports', load: () => import('../imports/run.mjs') },
  { name: 'symbols', load: () => import('../symbols/run.mjs') },
  { name: 'domains', load: () => import('../domains/run.mjs') },
];

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
        'if-stale': { type: 'boolean' },
        'force': { type: 'boolean' },
      },
    });
  } catch (err) {
    emit(`regenerate: usage error: ${err.message}`);
    return 2;
  }

  const { repoRoot, outDir, _flags: flags } = cfg;
  const skipExplorer = Boolean(flags['skip-explorer']);

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

  // Every layer receives the SAME repo + base cache, so the snapshot stays
  // consistent across layers. Forward an explicit --config too, so a shared
  // configuration reaches every layer.
  const layerArgv = ['--repo-root', repoRoot, '--out', outDir];
  if (flags.config) layerArgv.push('--config', resolve(cwd, flags.config));

  emit(`regenerate: repo=${repoRoot}`);
  emit(`regenerate: base cache=${outDir}`);

  const pipelineStart = performance.now();
  for (const step of PIPELINE) {
    emit(`▶ ${step.name}`);
    const stepStart = performance.now();

    let code;
    try {
      const mod = await step.load();
      // Fresh argv per layer — never let a layer mutate the shared array.
      code = await mod.run([...layerArgv]);
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
  emit(`  Explore/query: codegraph mcp --cache ${outDir}`);
  // The browser index is the explorer layer's job; hint at it once it lands,
  // unless the caller opted out with --skip-explorer.
  if (!skipExplorer) {
    emit(`  Browser index (when explorer lands): codegraph explorer --out ${outDir}`);
  }
  return 0;
}
