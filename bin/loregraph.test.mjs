// End-to-end CLI tests for the `loregraph` dispatcher's `--help`/`-h` handling.
//
// Regression target: sub-commands used to ignore `--help`/`-h` entirely and run
// for real — failing with "no inventory found" when no cache existed, or WORSE,
// silently writing cache artifacts (e.g. `inventory --help` would walk the repo
// and write `.kg-cache/inventory/*`) when the command didn't need an upstream
// artifact first. `<cmd> --help` must now print that command's help and exit 0
// WITHOUT doing any work — checked here both by exit code / output content and,
// directly, by asserting the filesystem is untouched.
//
// `bin/loregraph.mjs` runs `main()` unconditionally at import time (and calls
// `process.exit`), so — like `src/mcp/run.test.mjs` — it can only be exercised
// by spawning it as a real subprocess, never by importing it.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('./loregraph.mjs', import.meta.url));

/** Run the real CLI as a subprocess. Never throws — inspect `.status` instead. */
function cli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? emptyDir(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A fresh, empty directory — where the default `--out` (./.kg-cache) would land. */
function emptyDir() {
  return mkdtempSync(join(tmpdir(), 'cg-cli-help-'));
}

// One flag per command that appears ONLY in that command's own help (never in
// another command's or the main usage block) — proof the right help was shown.
const DISTINCTIVE_FLAG = {
  init: '--dry-run',
  inventory: '--require-vcs',
  imports: '--require-resolution-rate',
  symbols: '--max-files',
  references: '--incremental',
  usages: '--symbols',
  domains: '--imports',
  brief: '--limit',
  outline: '<file>',
  show: '--context',
  impact: '--diff',
  cycles: '--scope file|domain|both',
  check: 'exit 1',
  describe: '--budget-tokens',
  explorer: '--serve',
  docs: '--out-docs',
  mcp: '--cache',
  regenerate: '--skip-heavy',
};

const ALL_COMMANDS = Object.keys(DISTINCTIVE_FLAG);

describe('loregraph <cmd> --help / -h', () => {
  it.each(ALL_COMMANDS)('%s --help prints that command\'s help, exits 0, and writes nothing', (cmd) => {
    const dir = emptyDir();
    const { status, stdout, stderr } = cli([cmd, '--help'], { cwd: dir });

    expect(status).toBe(0);
    expect(stdout).toContain(cmd);
    expect(stdout).toContain(DISTINCTIVE_FLAG[cmd]);
    // Never the failure mode this bug produced.
    expect(stderr).not.toContain('no inventory found');
    expect(stderr).not.toContain('no symbols found');
    expect(stderr).not.toContain('cache dir not found');
    // The whole point: an empty directory MUST stay empty. No `.kg-cache`, no
    // config file, no anything — a --help request does zero work.
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(ALL_COMMANDS)('%s -h behaves exactly like --help', (cmd) => {
    const dir = emptyDir();
    const { status, stdout } = cli([cmd, '-h'], { cwd: dir });

    expect(status).toBe(0);
    expect(stdout).toContain(cmd);
    expect(stdout).toContain(DISTINCTIVE_FLAG[cmd]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('--help later in the sub-command arg list still triggers help, not the command', () => {
    const dir = emptyDir();
    const { status, stdout } = cli(['impact', '--files', 'x.ts', '--help'], { cwd: dir });

    expect(status).toBe(0);
    expect(stdout).toContain('loregraph impact');
    expect(stdout).toContain('--diff');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('-h later in the sub-command arg list also triggers help', () => {
    const dir = emptyDir();
    const { status, stdout } = cli(['symbols', '--max-files', '5', '-h'], { cwd: dir });

    expect(status).toBe(0);
    expect(stdout).toContain('loregraph symbols');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('loregraph --help (no sub-command) is unchanged', () => {
  // The exact text the dispatcher printed before this fix — pinned literally
  // (not derived from the help registry) so a regression in the generator
  // itself cannot silently pass this test.
  const EXPECTED = `loregraph <command> [options]

Commands:
  init         Set a project up: config, ignore rule, MCP entry, npm scripts
  regenerate   Build the whole graph in dependency order
  inventory    Layer 1: files + directories
  imports      Layer 2a: file → file/package imports
  symbols      Layer 2b: declarations
  references   Layer 2c: file → symbol
  usages       Layer 2d: symbol → symbol
  domains      Layer 3: semantic domain overlay
  brief        Context pack for a file / domain / symbol
  outline      A file's declarations, without the bodies
  show         The source of exactly one symbol
  impact       Blast radius + likely tests for a diff
  cycles       Circular dependencies between files / domains
  check        CI gate: fail the build on rules from loregraph.config
  describe     Cached, model-written descriptions (the only paid command)
  explorer     Build (and optionally serve) the browser index
  docs         Generate AGENTS.md + Markdown docs from the graph
  mcp          Start the stdio MCP server

Global: --repo-root PATH  --out DIR  --config FILE  --help`;

  it('--help prints the exact command list and exits 0', () => {
    const { status, stdout } = cli(['--help']);
    expect(stdout.trimEnd()).toBe(EXPECTED);
    expect(status).toBe(0);
  });

  it('-h prints the exact same block and exits 0', () => {
    const { status, stdout } = cli(['-h']);
    expect(stdout.trimEnd()).toBe(EXPECTED);
    expect(status).toBe(0);
  });

  it('no args at all: same usage text, but exits 2', () => {
    const { status, stdout } = cli([]);
    expect(stdout.trimEnd()).toBe(EXPECTED);
    expect(status).toBe(2);
  });
});

describe('unknown command', () => {
  it('still exits 2 with the usage block', () => {
    const { status, stdout, stderr } = cli(['not-a-real-command']);
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown command: not-a-real-command');
    expect(stderr).toContain('Commands:');
    expect(stdout).toBe('');
  });

  it('is unaffected by a trailing --help — still an unknown-command error', () => {
    const { status, stderr } = cli(['not-a-real-command', '--help']);
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown command: not-a-real-command');
  });
});

describe('a real .kg-cache is left byte-for-byte untouched by --help', () => {
  it('inventory/imports/symbols/domains --help never touch a pre-existing cache', () => {
    const repo = emptyDir();
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.mjs'), "import { b } from './b.mjs';\nexport const a = b + 1;\n");
    writeFileSync(join(repo, 'src', 'b.mjs'), 'export const b = 1;\n');

    // Build one real, small layer of cache to have something at stake.
    const built = cli(['inventory'], { cwd: repo });
    expect(built.status).toBe(0);

    const cacheDir = join(repo, '.kg-cache', 'inventory');
    const snapshot = () => readdirSync(cacheDir).sort()
      .map((name) => [name, readFileSync(join(cacheDir, name), 'utf8')]);
    const before = snapshot();

    for (const cmd of ['inventory', 'imports', 'symbols', 'domains']) {
      const { status } = cli([cmd, '--help'], { cwd: repo });
      expect(status).toBe(0);
    }

    expect(snapshot()).toEqual(before);
  });
});
