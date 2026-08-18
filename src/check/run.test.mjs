import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const file = (path) => ({ id: `file:${path}`, labels: ['File'], properties: { path, name: path.split('/').pop(), kind: 'code' } });
const sym = (path, name) => ({ id: `sym:${path}#${name}`, labels: ['Symbol'], properties: { name, kind: 'function', exported: true, path, line: 1 } });
const domain = (name) => ({ id: `domain:${name}`, labels: ['Domain'], properties: { name, kind: 'product' } });
const edge = (type, from, to, properties = {}) => ({ id: `edge:${from}:${type}:${to}`, type, from, to, properties });

/** A repo whose cache holds a file cycle, a dead export and a ui → server edge. */
function seedRepo({ resolutionRate = 1 } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'cg-check-cli-'));
  const cache = join(repo, '.kg-cache');
  mkdirSync(join(cache, 'inventory'), { recursive: true });
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({
    projectId: 'project:demo', snapshotId: 'snapshot:demo:rev1', repoRoot: repo,
  }));
  writeLayer(cache, 'inventory', { nodes: [file('src/ui/a.ts'), file('src/ui/b.ts'), file('src/server/db.ts')] });
  writeLayer(cache, 'imports', {
    edges: [
      edge('IMPORTS', 'file:src/ui/a.ts', 'file:src/ui/b.ts', { kind: 'internal' }),
      edge('IMPORTS', 'file:src/ui/b.ts', 'file:src/ui/a.ts', { kind: 'internal' }),
      edge('IMPORTS', 'file:src/ui/a.ts', 'file:src/server/db.ts', { kind: 'internal' }),
    ],
  });
  writeFileSync(join(cache, 'imports', 'manifest.json'), JSON.stringify({ resolutionRate }));
  writeLayer(cache, 'symbols', {
    nodes: [sym('src/server/db.ts', 'unusedThing')],
    edges: [edge('DECLARES', 'file:src/server/db.ts', 'sym:src/server/db.ts#unusedThing')],
  });
  writeLayer(cache, 'references', {
    edges: [edge('REFERENCES', 'file:src/server/db.ts', 'sym:src/server/db.ts#unusedThing', { sameFile: true })],
  });
  writeLayer(cache, 'domains', {
    nodes: [domain('ui'), domain('server')],
    edges: [
      edge('BELONGS_TO', 'file:src/ui/a.ts', 'domain:ui'),
      edge('BELONGS_TO', 'file:src/ui/b.ts', 'domain:ui'),
      edge('BELONGS_TO', 'file:src/server/db.ts', 'domain:server'),
      edge('DEPENDS_ON', 'domain:ui', 'domain:server', { weight: 1 }),
    ],
  });
  return { repo, cache };
}

/** Write a `loregraph.config.mjs` exporting `{ check }` at the repo root. */
function writeConfig(repo, check) {
  writeFileSync(
    join(repo, 'loregraph.config.mjs'),
    `export default ${JSON.stringify({ check }, null, 2)};\n`,
  );
}

let repo;
let cache;
let out;
let err;
beforeEach(() => {
  ({ repo, cache } = seedRepo());
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation((s) => err.push(String(s)));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

const stdout = () => out.join('\n');
const stderr = () => err.join('\n');
const args = (...extra) => ['--repo-root', repo, '--cache', cache, ...extra];

describe('check CLI — exit codes', () => {
  it('exits 1 when a rule is violated', async () => {
    writeConfig(repo, { noCycles: true });
    const code = await run(args());
    expect(code).toBe(1);
    expect(stdout()).toContain('FAIL');
  });

  it('exits 0 when every rule passes', async () => {
    writeConfig(repo, { maxDeadExports: 5, minResolutionRate: 0.5 });
    const code = await run(args());
    expect(code).toBe(0);
    expect(stdout()).toContain('PASS');
    expect(stdout()).not.toContain('FAIL');
  });

  it('exits 2 when the cache is missing', async () => {
    writeConfig(repo, { noCycles: true });
    const code = await run(['--repo-root', repo, '--cache', join(repo, 'no-such-cache')]);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/cache/i);
  });

  it('exits 2 on a mistyped rule name rather than quietly ignoring it', async () => {
    writeConfig(repo, { noCycle: true });
    const code = await run(args());
    expect(code).toBe(2);
    expect(stderr()).toContain('noCycle');
    expect(stderr()).toContain('noCycles');
  });

  it('exits 2 when a configured rule needs a layer the cache does not have', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'cg-check-bare-'));
    writeLayer(bare, 'inventory', { nodes: [file('src/a.ts')] });
    writeConfig(repo, { maxDeadExports: 0 });
    const code = await run(['--repo-root', repo, '--cache', bare]);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/references/);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('check CLI — nothing configured', () => {
  it('exits 0 but says plainly that nothing was checked, and what could be', async () => {
    const code = await run(args());
    expect(code).toBe(0);
    expect(stdout()).toMatch(/nothing/i);
    expect(stdout()).toContain('noCycles');
    expect(stdout()).toContain('maxDeadExports');
    expect(stdout()).toContain('minResolutionRate');
    expect(stdout()).toContain('domainRules');
  });

  it('does not claim to have passed anything', async () => {
    await run(args());
    expect(stdout()).not.toContain('PASS');
  });
});

describe('check CLI — the rules', () => {
  it('domainRules names the offending files', async () => {
    writeConfig(repo, { domainRules: [{ from: 'ui', mustNotDependOn: ['server'] }] });
    const code = await run(args());
    expect(code).toBe(1);
    expect(stdout()).toContain('src/ui/a.ts → src/server/db.ts');
  });

  it('minResolutionRate reads the rate the imports layer recorded', async () => {
    const low = seedRepo({ resolutionRate: 0.4 });
    writeConfig(low.repo, { minResolutionRate: 0.95 });
    const code = await run(['--repo-root', low.repo, '--cache', low.cache]);
    expect(code).toBe(1);
    expect(stdout()).toContain('0.4');
    rmSync(low.repo, { recursive: true, force: true });
  });

  it('maxDeadExports fails at 0 and passes at 1', async () => {
    // Two repos: Node caches a config module by path, so the same file cannot
    // hold two different values inside one process.
    writeConfig(repo, { maxDeadExports: 0 });
    expect(await run(args())).toBe(1);

    const lenient = seedRepo();
    writeConfig(lenient.repo, { maxDeadExports: 1 });
    expect(await run(['--repo-root', lenient.repo, '--cache', lenient.cache])).toBe(0);
    rmSync(lenient.repo, { recursive: true, force: true });
  });
});

describe('check CLI — --json', () => {
  it('emits a machine-readable report with a verdict per rule', async () => {
    writeConfig(repo, { noCycles: true, maxDeadExports: 5 });
    const code = await run(args('--json'));
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout());
    expect(parsed.ok).toBe(false);
    expect(parsed.configured).toBe(true);
    expect(parsed.counts).toEqual({ evaluated: 2, passed: 1, failed: 1 });
    const byId = Object.fromEntries(parsed.rules.map((r) => [r.id, r]));
    expect(byId.noCycles.ok).toBe(false);
    expect(byId.noCycles.offenders.length).toBeGreaterThan(0);
    expect(byId.maxDeadExports.ok).toBe(true);
  });

  it('emits the nothing-configured shape as JSON too', async () => {
    await run(args('--json'));
    const parsed = JSON.parse(stdout());
    expect(parsed.configured).toBe(false);
    expect(parsed.ok).toBe(true);
    expect(parsed.rules).toEqual([]);
    expect(parsed.available).toContain('noCycles');
  });
});
