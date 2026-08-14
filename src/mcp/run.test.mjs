import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const BIN = fileURLToPath(new URL('../../bin/loregraph.mjs', import.meta.url));

/** A minimal two-layer cache: one File node + one IMPORTS edge. */
function buildCache() {
  const cache = mkdtempSync(join(tmpdir(), 'cg-mcp-run-'));
  const inv = join(cache, 'inventory');
  mkdirSync(inv, { recursive: true });
  writeFileSync(join(inv, 'nodes.jsonl'), [
    JSON.stringify({ id: 'file:src/run.mjs', labels: ['File'], properties: { path: 'src/run.mjs', name: 'run.mjs' } }),
    JSON.stringify({ id: 'file:src/dep.mjs', labels: ['File'], properties: { path: 'src/dep.mjs', name: 'dep.mjs' } }),
  ].join('\n'));
  writeFileSync(join(inv, 'edges.jsonl'), '');
  const imp = join(cache, 'imports');
  mkdirSync(imp, { recursive: true });
  writeFileSync(join(imp, 'nodes.jsonl'), '');
  writeFileSync(join(imp, 'edges.jsonl'), JSON.stringify({
    id: 'edge:file:src/run.mjs:IMPORTS:file:src/dep.mjs', type: 'IMPORTS',
    from: 'file:src/run.mjs', to: 'file:src/dep.mjs', properties: { kind: 'internal', specifier: './dep.mjs' },
  }));
  return cache;
}

/** A temp git repo with a single commit; returns { repo, head }. */
function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'cg-mcp-git-'));
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { repo, head };
}

/** Add an inventory manifest to `cache` recording `revision` built from `repoRoot`. */
function writeManifest(cache, repoRoot, revision) {
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({
    repoRoot, snapshotId: `snapshot:proj:${revision}`,
    vcs: { type: 'git', available: true, revision },
  }));
}

/** Spawn the CLI, feed `lines` to stdin, resolve with {code, stdout, stderr}. */
function runMcp(cache, lines) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, 'mcp', '--cache', cache], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

let cache;
beforeEach(() => { cache = buildCache(); });

describe('loregraph mcp (end-to-end CLI)', () => {
  it('serves tools/list and tools/call over stdio, then exits 0 on EOF', async () => {
    const { code, stdout, stderr } = await runMcp(cache, [
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_node","arguments":{"query":"run.mjs"}}}',
    ]);

    expect(code).toBe(0);
    const out = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(1);
    expect(out[0].result.tools.length).toBeGreaterThanOrEqual(11);

    expect(out[1].id).toBe(2);
    const payload = JSON.parse(out[1].result.content[0].text);
    expect(payload.results.map((n) => n.id)).toContain('file:src/run.mjs');

    // Diagnostics go to stderr, never stdout.
    expect(stderr).toContain('[loregraph mcp]');
    expect(stderr).toContain('layers=inventory,imports');
  }, 20000);

  it('warns on stderr (not stdout) when the graph cache is stale, then still serves', async () => {
    const { repo } = makeGitRepo();
    // Record a revision that differs from the repo's HEAD → revision-changed.
    writeManifest(cache, repo, 'deadbeefcafe');

    const { code, stdout, stderr } = await runMcp(cache, [
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    ]);
    expect(code).toBe(0);
    expect(stderr).toContain('[loregraph] warning: graph cache is at deadbeefcafe');
    expect(stderr).toContain('run `loregraph regenerate` to refresh');
    // The warning must never leak onto the protocol stream.
    expect(stdout).not.toContain('warning');
    // Serving is not blocked — tools/list still answered.
    expect(JSON.parse(stdout.split('\n').filter(Boolean)[0]).id).toBe(1);
  }, 20000);

  it('does not warn when the cache matches the current revision', async () => {
    const { repo, head } = makeGitRepo();
    writeManifest(cache, repo, head);
    const { code, stderr } = await runMcp(cache, [
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    ]);
    expect(code).toBe(0);
    expect(stderr).not.toContain('warning: graph cache is at');
  }, 20000);

  it('reports "graph empty" on stderr for a missing cache but still serves', async () => {
    const emptyCache = join(tmpdir(), 'cg-mcp-run-empty-does-not-exist');
    const { code, stdout, stderr } = await runMcp(emptyCache, [
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"find_node","arguments":{"query":"x"}}}',
    ]);
    expect(code).toBe(0);
    expect(stderr).toContain('graph empty');
    const payload = JSON.parse(JSON.parse(stdout).result.content[0].text);
    expect(payload.note).toMatch(/graph empty/);
  }, 20000);
});
