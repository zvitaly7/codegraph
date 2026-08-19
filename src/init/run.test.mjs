import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { run } from './run.mjs';
import { HOOK_BEGIN, INIT_SCRIPTS } from './lib/writers.mjs';

let logs = [];
const created = [];

/** A scratch project: never the real repo, never anyone else's checkout. */
function project({ pkg = { name: 'demo', version: '1.0.0' }, git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lg-init-'));
  created.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  if (pkg) writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  if (git) mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  return dir;
}

const read = (dir, ...parts) => readFileSync(join(dir, ...parts), 'utf8');
const json = (dir, ...parts) => JSON.parse(read(dir, ...parts));
const output = () => logs.join('\n');

/** Checksums of every file in the tree (excluding VCS noise), for byte-equality. */
function snapshot(dir, base = dir, acc = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) snapshot(full, base, acc);
    else acc[full.slice(base.length + 1)] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return acc;
}

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true });
});

describe('init — a fresh project', () => {
  it('creates the config, the ignore entry, .mcp.json and the npm scripts', async () => {
    const dir = project();

    const code = await run(['--repo-root', dir, '--yes']);

    expect(code).toBe(0);
    expect(read(dir, 'loregraph.config.mjs')).toContain("srcRoots: ['src'],");
    expect(read(dir, '.gitignore')).toContain('.kg-cache/');
    expect(json(dir, '.mcp.json')).toEqual({
      mcpServers: { loregraph: { command: 'npx', args: ['-y', 'loregraph', 'mcp'] } },
    });
    expect(json(dir, 'package.json').scripts).toEqual(INIT_SCRIPTS);
    // The graph itself is not built unless asked for.
    expect(existsSync(join(dir, '.kg-cache'))).toBe(false);
  });

  it('reports what it detected before it does anything', async () => {
    const dir = project({ pkg: { name: 'shop' } });
    writeFileSync(join(dir, 'tsconfig.json'), '{}');

    await run(['--repo-root', dir, '--yes']);

    expect(output()).toContain('shop');
    expect(output()).toMatch(/source roots\s+src/);
    expect(output()).toMatch(/tsconfig\s+tsconfig\.json/);
  });

  it('lists every file it created in the summary', async () => {
    const dir = project();
    await run(['--repo-root', dir, '--yes']);

    for (const file of ['loregraph.config.mjs', '.gitignore', '.mcp.json', 'package.json']) {
      expect(output()).toContain(file);
    }
    expect(output()).toMatch(/created 3/);
    expect(output()).toMatch(/updated 1/);
  });

  it('never installs the git hook under --yes', async () => {
    const dir = project();
    await run(['--repo-root', dir, '--yes']);
    expect(existsSync(join(dir, '.git', 'hooks', 'post-merge'))).toBe(false);
  });
});

describe('init — idempotency', () => {
  it('changes nothing on a second run, byte for byte', async () => {
    const dir = project();

    expect(await run(['--repo-root', dir, '--yes'])).toBe(0);
    const before = snapshot(dir);

    logs = [];
    expect(await run(['--repo-root', dir, '--yes'])).toBe(0);
    const after = snapshot(dir);

    expect(after).toEqual(before);
    expect(output()).toContain('already');
    expect(output()).toMatch(/created 0/);
    expect(output()).toMatch(/updated 0/);
  });

  it('does not duplicate the gitignore line, the scripts or the hook block', async () => {
    const dir = project();
    await run(['--repo-root', dir, '--yes', '--hook']);
    await run(['--repo-root', dir, '--yes', '--hook']);

    const ignore = read(dir, '.gitignore');
    expect(ignore.match(/\.kg-cache/g)).toHaveLength(1);
    expect(read(dir, 'package.json').match(/"graph"/g)).toHaveLength(1);
    expect(read(dir, '.git', 'hooks', 'post-merge').match(new RegExp(HOOK_BEGIN, 'g'))).toHaveLength(1);
  });
});

describe('init — existing files are never damaged', () => {
  it('adds our server next to another one and keeps unrelated keys', async () => {
    const dir = project();
    writeFileSync(join(dir, '.mcp.json'), `${JSON.stringify({
      $schema: 'https://example.com/mcp.json',
      mcpServers: { other: { command: 'node', args: ['other.js'], env: { A: '1' } } },
    }, null, 2)}\n`);

    await run(['--repo-root', dir, '--yes']);

    const cfg = json(dir, '.mcp.json');
    expect(cfg.mcpServers.other).toEqual({ command: 'node', args: ['other.js'], env: { A: '1' } });
    expect(cfg.mcpServers.loregraph).toEqual({ command: 'npx', args: ['-y', 'loregraph', 'mcp'] });
    expect(cfg.$schema).toBe('https://example.com/mcp.json');
  });

  it('leaves a .gitignore that already covers the cache untouched', async () => {
    const dir = project();
    const existing = 'node_modules/\n/.kg-cache\n';
    writeFileSync(join(dir, '.gitignore'), existing);

    await run(['--repo-root', dir, '--yes']);

    expect(read(dir, '.gitignore')).toBe(existing);
    expect(output()).toMatch(/\.gitignore.*already/i);
  });

  it('leaves an existing post-merge hook alone and prints the snippet instead', async () => {
    const dir = project();
    const hook = join(dir, '.git', 'hooks', 'post-merge');
    const existing = '#!/bin/sh\necho "mine"\n';
    writeFileSync(hook, existing);

    await run(['--repo-root', dir, '--yes', '--hook']);

    expect(read(dir, '.git', 'hooks', 'post-merge')).toBe(existing);
    expect(output()).toContain('npx loregraph regenerate --if-stale');
  });

  it('leaves an existing `graph` script alone but still adds the missing one', async () => {
    const dir = project({ pkg: { name: 'demo', scripts: { graph: 'my-own-thing' } } });

    await run(['--repo-root', dir, '--yes']);

    const scripts = json(dir, 'package.json').scripts;
    expect(scripts.graph).toBe('my-own-thing');
    expect(scripts['graph:explore']).toBe(INIT_SCRIPTS['graph:explore']);
    expect(output()).toContain('my-own-thing');
  });

  it('leaves an existing loregraph.config.mjs exactly as it is', async () => {
    const dir = project();
    const existing = "export default { srcRoots: ['lib'] };\n";
    writeFileSync(join(dir, 'loregraph.config.mjs'), existing);

    await run(['--repo-root', dir, '--yes']);

    expect(read(dir, 'loregraph.config.mjs')).toBe(existing);
    expect(output()).toMatch(/loregraph\.config\.mjs.*already/i);
  });

  it('skips a package.json it cannot parse instead of rewriting it', async () => {
    const dir = project({ pkg: null });
    const broken = '{ "name": "demo",, }';
    writeFileSync(join(dir, 'package.json'), broken);

    const code = await run(['--repo-root', dir, '--yes']);

    expect(code).toBe(0);
    expect(read(dir, 'package.json')).toBe(broken);
    expect(output()).toMatch(/package\.json/);
  });

  it('does nothing about scripts when there is no package.json at all', async () => {
    const dir = project({ pkg: null });

    const code = await run(['--repo-root', dir, '--yes']);

    expect(code).toBe(0);
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
    expect(existsSync(join(dir, 'loregraph.config.mjs'))).toBe(true);
  });
});

describe('init — agent config detection', () => {
  it('extends the configs the project already has, and creates none of the others', async () => {
    const dir = project();
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(join(dir, '.cursor', 'mcp.json'), '{}\n');

    await run(['--repo-root', dir, '--yes']);

    expect(json(dir, '.cursor', 'mcp.json').mcpServers.loregraph).toBeTruthy();
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
  });

  it('writes `servers` for VS Code and `mcpServers` for Claude Code and Cursor', async () => {
    const dir = project();
    mkdirSync(join(dir, '.vscode'), { recursive: true });
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(join(dir, '.vscode', 'mcp.json'), `${JSON.stringify({ inputs: [] }, null, 2)}\n`);
    writeFileSync(join(dir, '.cursor', 'mcp.json'), '{}\n');
    writeFileSync(join(dir, '.mcp.json'), '{}\n');

    await run(['--repo-root', dir, '--yes']);

    const vscode = json(dir, '.vscode', 'mcp.json');
    expect(Object.keys(vscode)).toEqual(['inputs', 'servers']);
    expect(vscode.servers.loregraph).toEqual({ command: 'npx', args: ['-y', 'loregraph', 'mcp'] });
    expect(vscode.mcpServers).toBeUndefined();

    expect(json(dir, '.cursor', 'mcp.json').mcpServers.loregraph).toBeTruthy();
    expect(json(dir, '.mcp.json').mcpServers.loregraph).toBeTruthy();
  });

  it('leaves an existing loregraph entry that differs from ours', async () => {
    const dir = project();
    const existing = `${JSON.stringify({ mcpServers: { loregraph: { command: 'loregraph', args: ['mcp'] } } }, null, 2)}\n`;
    writeFileSync(join(dir, '.mcp.json'), existing);

    await run(['--repo-root', dir, '--yes']);

    expect(read(dir, '.mcp.json')).toBe(existing);
    expect(output()).toMatch(/\.mcp\.json/);
  });

  it('refuses to touch an agent config it cannot parse', async () => {
    const dir = project();
    const broken = '{ oops';
    writeFileSync(join(dir, '.mcp.json'), broken);

    const code = await run(['--repo-root', dir, '--yes']);

    expect(code).toBe(0);
    expect(read(dir, '.mcp.json')).toBe(broken);
  });
});

describe('init — --dry-run', () => {
  it('prints the plan and writes absolutely nothing', async () => {
    const dir = project();
    const before = snapshot(dir);

    const code = await run(['--repo-root', dir, '--yes', '--dry-run', '--hook', '--build']);

    expect(code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, 'loregraph.config.mjs'))).toBe(false);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    expect(existsSync(join(dir, '.kg-cache'))).toBe(false);
    expect(output()).toMatch(/dry run/i);
    expect(output()).toMatch(/would create.*loregraph\.config\.mjs/i);
  });
});

describe('init — non-interactive by default', () => {
  it('takes every default without prompting when stdin is not a TTY', async () => {
    const dir = project();
    const isTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      // No --yes: it must still finish on its own rather than wait for input.
      const code = await run(['--repo-root', dir]);
      expect(code).toBe(0);
      expect(existsSync(join(dir, 'loregraph.config.mjs'))).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    }
  });
});

describe('init — git hook', () => {
  it('installs an executable sentinel-marked hook when asked', async () => {
    const dir = project();

    await run(['--repo-root', dir, '--yes', '--hook']);

    const hook = read(dir, '.git', 'hooks', 'post-merge');
    expect(hook).toContain(HOOK_BEGIN);
    expect(hook).toContain('npx loregraph regenerate --if-stale');
    // Windows has no execute bit to set, so the mode says nothing there; the
    // hook's content is what matters and is asserted above either way.
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, '.git', 'hooks', 'post-merge')).mode & 0o111).toBeTruthy();
    }
  });

  it('says so, without failing, when the project is not a git repo', async () => {
    const dir = project({ git: false });

    const code = await run(['--repo-root', dir, '--yes', '--hook']);

    expect(code).toBe(0);
    expect(output()).toMatch(/git/i);
  });
});

describe('init — interactive', () => {
  /**
   * A fake TTY stdin that answers one question at a time: every prompt written
   * to `output` releases the next answer, so the answers cannot race ahead of
   * the questions. Running out of answers ends stdin instead of hanging.
   */
  function tty(answers) {
    const input = new PassThrough();
    input.isTTY = true;
    const queue = [...answers];
    const output = new Writable({
      write(_chunk, _enc, cb) {
        setImmediate(() => {
          if (queue.length > 0) input.write(`${queue.shift()}\n`);
          else input.end();
        });
        cb();
      },
    });
    return { input, output };
  }

  it('skips every step the user declines, writing nothing', async () => {
    const dir = project();
    const before = snapshot(dir);

    //           config, gitignore, mcp,    scripts, hook, build
    const io = tty(['n', 'n', 'none', 'n', 'n', 'n']);
    const code = await run(['--repo-root', dir], io);

    expect(code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(output()).toMatch(/declined/);
    expect(output()).toMatch(/skipped 4/);
  });

  it('accepts Enter for every default and takes the offered source roots', async () => {
    const dir = project();
    mkdirSync(join(dir, 'packages'), { recursive: true });

    //              config, srcRoots, gitignore, mcp,  scripts, hook
    const io = tty(['', '', '', '', '', '']);
    const code = await run(['--repo-root', dir, '--no-build'], io);

    expect(code).toBe(0);
    expect(read(dir, 'loregraph.config.mjs')).toContain("srcRoots: ['src', 'packages'],");
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    // The hook question defaults to NO.
    expect(existsSync(join(dir, '.git', 'hooks', 'post-merge'))).toBe(false);
  });

  it('honours source roots typed at the prompt', async () => {
    const dir = project();

    const io = tty(['y', 'server, client', 'n', 'none', 'n', 'n']);
    await run(['--repo-root', dir, '--no-build'], io);

    expect(read(dir, 'loregraph.config.mjs')).toContain("srcRoots: ['server', 'client'],");
  });

  it('installs the hook when the user opts in at the prompt', async () => {
    const dir = project();

    const io = tty(['n', 'n', 'none', 'n', 'y']);
    await run(['--repo-root', dir, '--no-build'], io);

    expect(read(dir, '.git', 'hooks', 'post-merge')).toContain(HOOK_BEGIN);
  });
});

describe('init — usage', () => {
  it('rejects a repo root that does not exist', async () => {
    const code = await run(['--repo-root', join(tmpdir(), 'lg-init-nope-1234')]);
    expect(code).toBe(2);
  });

  it('rejects stray positional arguments', async () => {
    const dir = project();
    expect(await run(['--repo-root', dir, 'oops', '--yes'])).toBe(2);
    expect(existsSync(join(dir, 'loregraph.config.mjs'))).toBe(false);
  });
});

describe('init — building the graph', () => {
  // Setting a project up and then handing it a graph with its cross-package
  // dependencies missing is the failure this whole step exists to prevent. The
  // build knows which packages fell out; init turns that into one answer.
  it('offers the paths mapping for packages the first build could not reach', async () => {
    const dir = project({ pkg: { name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'] } });
    mkdirSync(join(dir, 'packages', 'ui', 'packages', 'button'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'ui', 'package.json'),
      JSON.stringify({ name: '@myorg/ui', main: 'dist/index.js' }),
    );
    writeFileSync(join(dir, 'packages', 'ui', 'packages', 'button', 'index.ts'), 'export const b = 1;\n');
    // A package that is itself a monorepo is imported by subpath — the bare name
    // does not pick out one of its inner packages.
    writeFileSync(join(dir, 'src', 'a.mjs'), "import b from '@myorg/ui/button';\nexport const a = b;\n");

    const code = await run(['--repo-root', dir, '--yes', '--build']);
    expect(code).toBe(0);

    const cfg = read(dir, 'loregraph.config.mjs');
    expect(cfg).toContain("'@myorg/ui/*'");
    expect(cfg).toContain('packages/ui/packages/*');
    expect(cfg).not.toContain('// paths: null,');
    expect(output()).toMatch(/paths/);
  }, 60_000);

  it('writes no paths block when the build reached everything', async () => {
    const dir = project();
    await run(['--repo-root', dir, '--yes', '--build']);
    expect(read(dir, 'loregraph.config.mjs')).toContain('// paths: null,');
  }, 60_000);

  it('builds on request and points at the next commands', async () => {
    const dir = project();

    const code = await run(['--repo-root', dir, '--yes', '--build']);

    expect(code).toBe(0);
    expect(existsSync(join(dir, '.kg-cache', 'inventory', 'nodes.jsonl'))).toBe(true);
    expect(output()).toContain('loregraph explorer --serve');
  }, 60_000);
});
