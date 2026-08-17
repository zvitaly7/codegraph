import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';

function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

const file = (path, kind = 'code') => ({ id: `file:${path}`, labels: ['File'], properties: { path, name: path.split('/').pop(), language: 'TypeScript', kind, sizeBytes: 42 } });
const edge = (type, from, to, properties = {}) => ({ id: `edge:${from}:${type}:${to}`, type, from, to, properties });

/** src/a.ts ← src/b.ts ← test/b.test.ts, all in domain core. */
function seedCache(repoRoot) {
  const cache = mkdtempSync(join(tmpdir(), 'cg-impact-cli-'));
  mkdirSync(join(cache, 'inventory'), { recursive: true });
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({
    projectId: 'project:demo', snapshotId: 'snapshot:demo:rev1', repoRoot,
  }));
  writeLayer(cache, 'inventory', { nodes: [file('src/a.ts'), file('src/b.ts'), file('test/b.test.ts', 'test')] });
  writeLayer(cache, 'imports', {
    edges: [
      edge('IMPORTS', 'file:src/b.ts', 'file:src/a.ts', { kind: 'internal' }),
      edge('IMPORTS', 'file:test/b.test.ts', 'file:src/b.ts', { kind: 'internal' }),
    ],
  });
  writeLayer(cache, 'symbols', {
    nodes: [{ id: 'sym:src/a.ts#alpha', labels: ['Symbol'], properties: { name: 'alpha', kind: 'function', exported: true, path: 'src/a.ts', line: 1 } }],
    edges: [edge('DECLARES', 'file:src/a.ts', 'sym:src/a.ts#alpha')],
  });
  writeLayer(cache, 'references', {
    edges: [edge('REFERENCES', 'file:src/b.ts', 'sym:src/a.ts#alpha', { sameFile: false })],
  });
  writeLayer(cache, 'domains', {
    nodes: [{ id: 'domain:core', labels: ['Domain'], properties: { name: 'core', kind: 'platform' } }],
    edges: [
      edge('BELONGS_TO', 'file:src/a.ts', 'domain:core'),
      edge('BELONGS_TO', 'file:src/b.ts', 'domain:core'),
      edge('BELONGS_TO', 'file:test/b.test.ts', 'domain:core'),
    ],
  });
  return cache;
}

/** A git repo whose HEAD commit matches the seeded cache. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'cg-impact-repo-'));
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export function alpha() {}\n');
  writeFileSync(join(repo, 'src', 'b.ts'), 'import { alpha } from "./a";\nalpha();\n');
  writeFileSync(join(repo, 'test', 'b.test.ts'), 'import "../src/b";\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return repo;
}

let repo;
let cache;
let out;
let err;
let warn;
beforeEach(() => {
  repo = makeRepo();
  cache = seedCache(repo);
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation((s) => err.push(String(s)));
  // The seeded manifest records a fake revision, so every run emits the stale
  // warning — capture it instead of letting it noise up the test output.
  warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const stdout = () => out.join('\n');

describe('impact CLI — explicit --files', () => {
  it('prints a compact report and exits 0', async () => {
    const code = await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo]);
    expect(code).toBe(0);
    expect(stdout()).toContain('IMPACT  1 changed file(s)');
    expect(stdout()).toContain('core (1): src/a.ts');
    expect(stdout()).toContain('blast radius (2)');
    expect(stdout()).toContain('likely tests (1): test/b.test.ts');
    expect(stdout().split('\n').length).toBeLessThan(60);
  });

  it('accepts a comma-separated list', async () => {
    await run(['--files', 'src/a.ts,src/b.ts', '--cache', cache, '--repo-root', repo, '--json']);
    expect(JSON.parse(stdout()).changed.count).toBe(2);
  });

  it('--json emits the structured object', async () => {
    await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo, '--json']);
    const parsed = JSON.parse(stdout());
    expect(parsed.riskyExports.list[0]).toMatchObject({ name: 'alpha', refs: 1 });
    expect(parsed.source).toBe('files');
  });

  it('honors --max-depth and --limit', async () => {
    await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo, '--max-depth', '1', '--json']);
    const parsed = JSON.parse(stdout());
    expect(parsed.blastRadius.files).toEqual(['src/b.ts']);
    expect(parsed.blastRadius.depthCapReached).toBe(true);
  });
});

describe('impact CLI — --diff', () => {
  it('defaults to HEAD and picks up uncommitted edits', async () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    const code = await run(['--cache', cache, '--repo-root', repo, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.source).toBe('diff HEAD');
    expect(parsed.changed.files).toEqual(['src/a.ts']);
    expect(parsed.tests.files).toEqual(['test/b.test.ts']);
  });

  it('includes deletions — their importers are exactly what breaks', async () => {
    rmSync(join(repo, 'src', 'a.ts'));
    await run(['--cache', cache, '--repo-root', repo, '--json']);
    expect(JSON.parse(stdout()).changed.files).toEqual(['src/a.ts']);
  });

  it('reports an empty change set instead of failing', async () => {
    const code = await run(['--cache', cache, '--repo-root', repo]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/no changed files/i);
  });

  it('exits 1 when the revision cannot be resolved', async () => {
    const code = await run(['--diff', 'no-such-ref', '--cache', cache, '--repo-root', repo]);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/--files/);
  });
});

describe('impact CLI — guards', () => {
  it('warns on stderr about a stale cache but still answers', async () => {
    // The manifest records revision `rev1`, which is not the repo's HEAD.
    const code = await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo]);
    expect(code).toBe(0);
    expect(warn.mock.calls.flat().join('')).toMatch(/stale|regenerate/i);
    expect(stdout()).toContain('IMPACT');
  });

  it('exits 2 on a bad --max-depth', async () => {
    expect(await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo, '--max-depth', 'deep'])).toBe(2);
  });

  it('exits 2 when the cache holds no graph artifacts', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cg-impact-empty-'));
    expect(await run(['--files', 'src/a.ts', '--cache', empty, '--repo-root', repo])).toBe(2);
    expect(err.join('\n')).toMatch(/regenerate/);
  });
});

describe('impact CLI — --max-tokens and --compress-paths', () => {
  it('exits 2 on a non-positive --max-tokens', async () => {
    expect(await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo, '--max-tokens', '0'])).toBe(2);
    expect(err.join('\n')).toMatch(/--max-tokens must be a positive integer/);
  });

  it('exits 2 on a non-numeric --max-tokens', async () => {
    expect(await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo, '--max-tokens', 'small'])).toBe(2);
  });

  it('keeps a tiny --max-tokens answer valid and marked, not crashed', async () => {
    const code = await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo, '--max-tokens', '30']);
    expect(code).toBe(0);
    expect(stdout()).toContain('IMPACT');
    expect(stdout()).toMatch(/--max-tokens/);
  });

  it('accepts --compress-paths and --no-compress-paths without changing the answer set', async () => {
    expect(await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo, '--compress-paths'])).toBe(0);
    const packed = stdout();
    out.length = 0;
    expect(await run(['--files', 'src/a.ts', '--cache', cache, '--repo-root', repo, '--no-compress-paths'])).toBe(0);
    const plain = stdout();
    // Whatever the rendering, both name the same blast-radius size.
    const size = (text) => text.match(/blast radius \((\d+)/)?.[1];
    expect(size(packed)).toBe(size(plain));
  });
});
