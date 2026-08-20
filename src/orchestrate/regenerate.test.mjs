import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A hoisted control lets the vi.mock factory below force a mid-pipeline failure
// on demand while otherwise delegating to the REAL symbols layer — so the
// happy-path test still produces genuine symbol artifacts.
const control = vi.hoisted(() => ({ symbolsExit: null }));

vi.mock('../symbols/run.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    run: async (argv) => (control.symbolsExit === null ? actual.run(argv) : control.symbolsExit),
  };
});

import { run } from './regenerate.mjs';

const LAYERS = ['inventory', 'imports', 'symbols', 'domains'];

/** A tiny repo of three ES modules that import each other: a → b → c. */
function makeFixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'cg-regen-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.mjs'), "import { b } from './b.mjs';\nexport const a = b + 1;\n");
  writeFileSync(join(repo, 'src', 'b.mjs'), "import { c } from './c.mjs';\nexport const b = c + 1;\n");
  writeFileSync(join(repo, 'src', 'c.mjs'), 'export const c = 1;\n');
  return repo;
}

/** Same fixture, but a real git repo with one commit (so a HEAD revision exists). */
function makeGitFixtureRepo() {
  const repo = makeFixtureRepo();
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('add', '-A');
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });
  return repo;
}

let stdoutSpy;
let stderrSpy;

beforeAll(() => {
  // Layers print their own summaries to stdout via console.log; silence + capture
  // so we can assert the orchestrator itself never writes there.
  stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

afterEach(() => {
  control.symbolsExit = null;
  if (stderrSpy) stderrSpy.mockRestore();
  stdoutSpy.mockClear();
});

/** Capture (and silence) everything the orchestrator writes to stderr. */
function captureStderr() {
  const lines = [];
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

describe('regenerate orchestrator — happy path', () => {
  it('runs the full pipeline (core→heavy→explorer) and writes every manifest (exit 0)', async () => {
    const repo = makeFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();

    const code = await run(['--repo-root', repo, '--out', base]);
    expect(code).toBe(0);

    // The four cheap layers + the two heavy layers each write a manifest…
    for (const layer of [...LAYERS, 'references', 'usages']) {
      expect(existsSync(join(base, layer, 'manifest.json'))).toBe(true);
    }
    // …and the explorer writes its browser index last.
    expect(existsSync(join(base, 'explorer', 'graph-index.json'))).toBe(true);

    const err = errLines.join('');
    for (const layer of [...LAYERS, 'references', 'usages', 'explorer']) {
      expect(err).toContain(`▶ ${layer}`); // "▶ <layer>"
    }
    expect(err).toContain(`Explore/query: loregraph mcp --cache ${base}`);
    expect(err).toContain('heavy layers mode=off'); // default mode

    // Orchestrator chatter must never touch stdout (would corrupt layer artifacts).
    const out = stdoutSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).not.toContain('▶');
    expect(out).not.toContain('Explore/query');
  });

  it('honors --skip-explorer by omitting the explorer step (still exit 0)', async () => {
    const repo = makeFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();

    const code = await run(['--repo-root', repo, '--out', base, '--skip-explorer']);
    expect(code).toBe(0);
    const err = errLines.join('');
    expect(err).toContain('Explore/query: loregraph mcp --cache');
    expect(err).not.toContain('▶ explorer');
    expect(existsSync(join(base, 'explorer', 'graph-index.json'))).toBe(false);
    // Heavy layers still ran.
    expect(existsSync(join(base, 'references', 'manifest.json'))).toBe(true);
  });

  it('honors --skip-heavy by omitting references/usages (explorer still runs)', async () => {
    const repo = makeFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();

    const code = await run(['--repo-root', repo, '--out', base, '--skip-heavy']);
    expect(code).toBe(0);
    const err = errLines.join('');
    expect(err).not.toContain('▶ references');
    expect(err).not.toContain('▶ usages');
    expect(err).not.toContain('heavy layers mode='); // no heavy layers to report
    expect(existsSync(join(base, 'references', 'manifest.json'))).toBe(false);
    expect(existsSync(join(base, 'usages', 'manifest.json'))).toBe(false);
    // The cheap layers + explorer still ran.
    expect(existsSync(join(base, 'domains', 'manifest.json'))).toBe(true);
    expect(existsSync(join(base, 'explorer', 'graph-index.json'))).toBe(true);
  });

  it('forwards --incremental to the heavy layers and stays byte-identical to a full rebuild', async () => {
    const repo = makeGitFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();

    // Seed a full cache, then re-run incrementally (no changes) into the same base.
    expect(await run(['--repo-root', repo, '--out', base])).toBe(0);
    expect(await run(['--repo-root', repo, '--out', base, '--incremental', 'incremental'])).toBe(0);
    expect(errLines.join('')).toContain('heavy layers mode=incremental');

    // A fresh full rebuild of the same tree into a separate cache.
    const full = join(repo, '.kg-full');
    expect(await run(['--repo-root', repo, '--out', full])).toBe(0);

    // The incremental heavy artifacts must equal the fresh full ones, byte for byte.
    for (const layer of ['references', 'usages']) {
      for (const file of ['nodes.jsonl', 'edges.jsonl']) {
        expect(readFileSync(join(base, layer, file), 'utf8'))
          .toBe(readFileSync(join(full, layer, file), 'utf8'));
      }
    }
  });

  it('rejects an invalid --incremental value (exit 2)', async () => {
    const repo = makeFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();
    const code = await run(['--repo-root', repo, '--out', base, '--incremental', 'bogus']);
    expect(code).toBe(2);
    expect(errLines.join('')).toContain("--incremental must be 'off' or 'incremental'");
  });
});

describe('regenerate orchestrator — fail-fast', () => {
  it('stops at inventory when --repo-root does not exist (non-zero, no downstream artifacts)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cg-regen-out-'));
    const missing = join(tmpdir(), 'cg-regen-nope-does-not-exist-12345');
    const errLines = captureStderr();

    const code = await run(['--repo-root', missing, '--out', base]);
    expect(code).not.toBe(0);
    expect(code).toBe(2); // inventory reports a usage error for a missing repo root

    // Pipeline stopped at the very first layer — nothing downstream was written.
    expect(existsSync(join(base, 'imports', 'manifest.json'))).toBe(false);
    expect(existsSync(join(base, 'symbols', 'manifest.json'))).toBe(false);
    expect(existsSync(join(base, 'domains', 'manifest.json'))).toBe(false);

    expect(errLines.join('')).toContain('aborted at "inventory"');
  });

  it("aborts mid-pipeline with the failing layer's exit code and skips later layers", async () => {
    const repo = makeFixtureRepo();
    const base = join(repo, '.kg-cache');
    control.symbolsExit = 7; // force the symbols layer to fail
    const errLines = captureStderr();

    const code = await run(['--repo-root', repo, '--out', base]);
    expect(code).toBe(7); // fail-fast surfaces the layer's own exit code

    // inventory + imports ran (for real) before the forced symbols failure…
    expect(existsSync(join(base, 'inventory', 'manifest.json'))).toBe(true);
    expect(existsSync(join(base, 'imports', 'manifest.json'))).toBe(true);
    // …and domains (which comes after symbols) never ran.
    expect(existsSync(join(base, 'domains', 'manifest.json'))).toBe(false);

    expect(errLines.join('')).toContain('aborted at "symbols"');
  });
});

describe('regenerate orchestrator — --if-stale / --force', () => {
  it('skips the pipeline on an up-to-date cache (exit 0, no layers re-run)', async () => {
    const repo = makeGitFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();

    // First build records the repo's current revision in the cache.
    expect(await run(['--repo-root', repo, '--out', base])).toBe(0);
    expect(existsSync(join(base, 'inventory', 'manifest.json'))).toBe(true);
    errLines.length = 0; // discard first-build chatter

    // Second run: the cache matches HEAD, so --if-stale short-circuits.
    const code = await run(['--repo-root', repo, '--out', base, '--if-stale']);
    expect(code).toBe(0);
    const err = errLines.join('');
    expect(err).toContain('up to date');
    expect(err).toContain('skipping');
    // No layer banners were emitted → the pipeline never ran.
    expect(err).not.toContain('▶ inventory');
  });

  it('--force overrides --if-stale and rebuilds even when up to date', async () => {
    const repo = makeGitFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();
    expect(await run(['--repo-root', repo, '--out', base])).toBe(0);
    errLines.length = 0;

    const code = await run(['--repo-root', repo, '--out', base, '--if-stale', '--force']);
    expect(code).toBe(0);
    const err = errLines.join('');
    expect(err).not.toContain('skipping');
    expect(err).toContain('▶ inventory'); // layers ran
  });

  it('rebuilds when the recorded revision no longer matches HEAD', async () => {
    const repo = makeGitFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();
    expect(await run(['--repo-root', repo, '--out', base])).toBe(0);

    // Simulate staleness by rewriting the cached revision to a bogus value.
    const manifestPath = join(base, 'inventory', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const fake = '0'.repeat(40);
    manifest.vcs = { ...(manifest.vcs || {}), revision: fake };
    manifest.snapshotId = `snapshot:x:${fake}`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    errLines.length = 0;

    const code = await run(['--repo-root', repo, '--out', base, '--if-stale']);
    expect(code).toBe(0);
    const err = errLines.join('');
    expect(err).not.toContain('skipping');
    expect(err).toContain('▶ inventory'); // stale → full rebuild
  });

  it('--if-stale proceeds normally when staleness is unknown (no VCS)', async () => {
    const repo = makeFixtureRepo(); // plain dir, not a git repo
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();
    expect(await run(['--repo-root', repo, '--out', base])).toBe(0);
    errLines.length = 0;

    // No revision to compare → unknown, never definitively up-to-date → rebuild.
    const code = await run(['--repo-root', repo, '--out', base, '--if-stale']);
    expect(code).toBe(0);
    const err = errLines.join('');
    expect(err).not.toContain('skipping');
    expect(err).toContain('▶ inventory');
  });

  it('rebuilds when the cache lacks layers requested by this run', async () => {
    const repo = makeGitFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();

    expect(await run([
      '--repo-root', repo, '--out', base, '--skip-heavy', '--skip-explorer',
    ])).toBe(0);
    expect(existsSync(join(base, 'references', 'manifest.json'))).toBe(false);
    errLines.length = 0;

    expect(await run(['--repo-root', repo, '--out', base, '--if-stale'])).toBe(0);
    expect(errLines.join('')).toContain('▶ references');
    expect(existsSync(join(base, 'references', 'manifest.json'))).toBe(true);
    expect(existsSync(join(base, 'usages', 'manifest.json'))).toBe(true);
    expect(existsSync(join(base, 'explorer', 'graph-index.json'))).toBe(true);
  });

  it('rebuilds a clean-HEAD repo when its working tree changed', async () => {
    const repo = makeGitFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();
    expect(await run(['--repo-root', repo, '--out', base])).toBe(0);

    writeFileSync(join(repo, 'src', 'a.mjs'), 'export const a = 99;\n');
    errLines.length = 0;

    expect(await run(['--repo-root', repo, '--out', base, '--if-stale'])).toBe(0);
    expect(errLines.join('')).toContain('▶ inventory');
  });

  it('rebuilds when an external effective config changes at the same revision', async () => {
    const repo = makeGitFixtureRepo();
    const base = join(repo, '.kg-cache');
    const config = join(mkdtempSync(join(tmpdir(), 'cg-regen-config-')), 'loregraph.config.json');
    const errLines = captureStderr();
    writeFileSync(config, JSON.stringify({ entryPoints: [] }));
    expect(await run(['--repo-root', repo, '--out', base, '--config', config])).toBe(0);

    writeFileSync(config, JSON.stringify({ entryPoints: ['src/a.mjs'] }));
    errLines.length = 0;

    expect(await run([
      '--repo-root', repo, '--out', base, '--config', config, '--if-stale',
    ])).toBe(0);
    expect(errLines.join('')).toContain('▶ inventory');
  });
});
