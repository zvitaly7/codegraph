import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
  it('runs inventory→imports→symbols→domains and writes all four manifests (exit 0)', async () => {
    const repo = makeFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();

    const code = await run(['--repo-root', repo, '--out', base]);
    expect(code).toBe(0);

    for (const layer of LAYERS) {
      expect(existsSync(join(base, layer, 'manifest.json'))).toBe(true);
    }

    const err = errLines.join('');
    for (const layer of LAYERS) {
      expect(err).toContain(`▶ ${layer}`); // "▶ <layer>"
    }
    expect(err).toContain(`Explore/query: codegraph mcp --cache ${base}`);

    // Orchestrator chatter must never touch stdout (would corrupt layer artifacts).
    const out = stdoutSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).not.toContain('▶');
    expect(out).not.toContain('Explore/query');
  });

  it('honors --skip-explorer by omitting the explorer hint (still exit 0)', async () => {
    const repo = makeFixtureRepo();
    const base = join(repo, '.kg-cache');
    const errLines = captureStderr();

    const code = await run(['--repo-root', repo, '--out', base, '--skip-explorer']);
    expect(code).toBe(0);
    const err = errLines.join('');
    expect(err).toContain('Explore/query: codegraph mcp --cache');
    expect(err).not.toContain('codegraph explorer');
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
