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
const domain = (name) => ({ id: `domain:${name}`, labels: ['Domain'], properties: { name, kind: 'product' } });
const edge = (type, from, to, properties = {}) => ({ id: `edge:${from}:${type}:${to}`, type, from, to, properties });

/** src/a.ts ↔ src/b.ts (a file cycle) and ui ↔ server (a domain cycle). */
function seedCache() {
  const cache = mkdtempSync(join(tmpdir(), 'cg-cycles-cli-'));
  mkdirSync(join(cache, 'inventory'), { recursive: true });
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({
    projectId: 'project:demo', snapshotId: 'snapshot:demo:rev1', repoRoot: cache,
  }));
  writeLayer(cache, 'inventory', { nodes: [file('src/a.ts'), file('src/b.ts'), file('src/c.ts')] });
  writeLayer(cache, 'imports', {
    edges: [
      edge('IMPORTS', 'file:src/a.ts', 'file:src/b.ts', { kind: 'internal' }),
      edge('IMPORTS', 'file:src/b.ts', 'file:src/a.ts', { kind: 'internal' }),
      edge('IMPORTS', 'file:src/c.ts', 'file:src/a.ts', { kind: 'internal' }),
    ],
  });
  writeLayer(cache, 'domains', {
    nodes: [domain('ui'), domain('server')],
    edges: [
      edge('DEPENDS_ON', 'domain:ui', 'domain:server', { weight: 7 }),
      edge('DEPENDS_ON', 'domain:server', 'domain:ui', { weight: 1 }),
    ],
  });
  return cache;
}

let cache;
let out;
let err;
beforeEach(() => {
  cache = seedCache();
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation((s) => err.push(String(s)));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cache, { recursive: true, force: true });
});

const stdout = () => out.join('\n');
const stderr = () => err.join('\n');

describe('cycles CLI', () => {
  it('reports both scopes by default and exits 0', async () => {
    const code = await run(['--cache', cache, '--repo-root', cache]);
    expect(code).toBe(0);
    expect(stdout()).toContain('src/a.ts → src/b.ts → src/a.ts');
    expect(stdout()).toContain('server → ui → server');
  });

  it('--scope file leaves the domain section out', async () => {
    await run(['--cache', cache, '--repo-root', cache, '--scope', 'file', '--json']);
    const parsed = JSON.parse(stdout());
    expect(parsed.scope).toBe('file');
    expect(parsed.file.total).toBe(1);
    expect(parsed.domain).toBeUndefined();
    // Every --json answer says what shape it is (see lib/json_envelope.mjs).
    expect(parsed).toMatchObject({ schemaVersion: 1, tool: 'loregraph' });
  });

  it('--scope domain carries the hop weights', async () => {
    await run(['--cache', cache, '--repo-root', cache, '--scope', 'domain', '--json']);
    const parsed = JSON.parse(stdout());
    expect(parsed.domain.cycles[0].members).toEqual(['server', 'ui']);
    expect(parsed.domain.cycles[0].minWeight).toBe(1);
    expect(parsed.domain.cycles[0].totalWeight).toBe(8);
  });

  it('--json emits the structured report', async () => {
    await run(['--cache', cache, '--repo-root', cache, '--json']);
    const parsed = JSON.parse(stdout());
    expect(parsed.total).toBe(2);
    expect(parsed.file.cycles[0].members).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('rejects a non-positive --limit with exit 2', async () => {
    const code = await run(['--cache', cache, '--repo-root', cache, '--limit', '0']);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/--limit/);
  });

  it('rejects an unknown --scope with exit 2', async () => {
    const code = await run(['--cache', cache, '--repo-root', cache, '--scope', 'symbols']);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/--scope/);
  });

  it('exits 2 when the cache is missing', async () => {
    const code = await run(['--cache', join(cache, 'nope'), '--repo-root', cache]);
    expect(code).toBe(2);
    expect(stderr()).toMatch(/cache/i);
  });

  it('exits 0 and says so on an acyclic graph', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'cg-cycles-clean-'));
    writeLayer(clean, 'inventory', { nodes: [file('src/a.ts'), file('src/b.ts')] });
    writeLayer(clean, 'imports', {
      edges: [edge('IMPORTS', 'file:src/a.ts', 'file:src/b.ts', { kind: 'internal' })],
    });
    const code = await run(['--cache', clean, '--repo-root', clean]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/no cycles/i);
    rmSync(clean, { recursive: true, force: true });
  });
});
