import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';

function gitInit(dir) {
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  return g;
}

function readLines(p) {
  return readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

let cleanRepo;
let dirtyRepo;
let plainDir;
let outRoot;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  outRoot = mkdtempSync(join(tmpdir(), 'cg-run-out-'));

  cleanRepo = mkdtempSync(join(tmpdir(), 'cg-run-clean-'));
  let g = gitInit(cleanRepo);
  mkdirSync(join(cleanRepo, 'src'));
  writeFileSync(join(cleanRepo, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(cleanRepo, 'README.md'), '# demo\n');
  writeFileSync(join(cleanRepo, 'secret.key'), 'PRIVATE');
  mkdirSync(join(cleanRepo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(cleanRepo, 'node_modules', 'dep', 'i.js'), 'x');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');

  dirtyRepo = mkdtempSync(join(tmpdir(), 'cg-run-dirty-'));
  g = gitInit(dirtyRepo);
  writeFileSync(join(dirtyRepo, 'a.txt'), 'hi');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  writeFileSync(join(dirtyRepo, 'b.txt'), 'uncommitted'); // untracked → dirty

  plainDir = mkdtempSync(join(tmpdir(), 'cg-run-plain-'));
  writeFileSync(join(plainDir, 'a.txt'), 'hi');
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const d of [outRoot, cleanRepo, dirtyRepo, plainDir]) rmSync(d, { recursive: true, force: true });
});

describe('run() success on a git repo', () => {
  it('writes 4 artifacts, exit 0, git vcs, no leaks, consistent counts', async () => {
    const out = join(outRoot, 'base');
    const code = await run(['--repo-root', cleanRepo, '--out', out, '--project-name', 'demo']);
    expect(code).toBe(0);

    const inv = join(out, 'inventory');
    for (const f of ['nodes.jsonl', 'edges.jsonl', 'files.jsonl', 'manifest.json']) {
      expect(existsSync(join(inv, f))).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(join(inv, 'manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.vcs.type).toBe('git');
    expect(manifest.vcs.available).toBe(true);
    expect(manifest.vcs.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.projectId).toBe('project:demo');
    expect(typeof manifest.generatedAt).toBe('string');

    const files = readLines(join(inv, 'files.jsonl'));
    const edges = readLines(join(inv, 'edges.jsonl'));
    expect(manifest.counts.files).toBe(files.length);
    expect(manifest.counts.edges).toBe(edges.length);
    expect(manifest.counts.projects).toBe(1);
    expect(manifest.counts.snapshots).toBe(1);

    // no-leak + security
    const blob = files.join('\n');
    expect(blob).not.toMatch(/node_modules|\.git\/|\.kg-cache/);
    expect(blob).not.toContain('secret.key');
    expect(blob).toContain('src/index.ts');
  });

  it('is deterministic: nodes.jsonl byte-identical across runs', async () => {
    const outA = join(outRoot, 'detA');
    const outB = join(outRoot, 'detB');
    await run(['--repo-root', cleanRepo, '--out', outA, '--project-name', 'demo']);
    await run(['--repo-root', cleanRepo, '--out', outB, '--project-name', 'demo']);
    const a = readFileSync(join(outA, 'inventory', 'nodes.jsonl'), 'utf8');
    const b = readFileSync(join(outB, 'inventory', 'nodes.jsonl'), 'utf8');
    expect(a).toBe(b);
  });

  it('--no-hash yields null sha256 in rows', async () => {
    const out = join(outRoot, 'nohash');
    await run(['--repo-root', cleanRepo, '--out', out, '--no-hash', '--project-name', 'demo']);
    const rows = readLines(join(out, 'inventory', 'files.jsonl')).map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.sha256).toBeNull();
    // rows never carry hashError
    expect(readFileSync(join(out, 'inventory', 'files.jsonl'), 'utf8')).not.toContain('hashError');
  });
});

describe('run() policy + usage exit codes', () => {
  it('--require-vcs on a non-git dir → 1', async () => {
    const out = join(outRoot, 'reqvcs');
    expect(await run(['--repo-root', plainDir, '--out', out, '--require-vcs'])).toBe(1);
  });

  it('--require-clean on a dirty repo → 1', async () => {
    const out = join(outRoot, 'reqclean');
    expect(await run(['--repo-root', dirtyRepo, '--out', out, '--require-clean'])).toBe(1);
  });

  it('nonexistent --repo-root → 2', async () => {
    const out = join(outRoot, 'nope');
    expect(await run(['--repo-root', join(tmpdir(), 'cg-does-not-exist-zzz'), '--out', out])).toBe(2);
  });

  it('non-git dir without --require-vcs still succeeds (exit 0, vcs none)', async () => {
    const out = join(outRoot, 'plainok');
    expect(await run(['--repo-root', plainDir, '--out', out])).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, 'inventory', 'manifest.json'), 'utf8'));
    expect(manifest.vcs.type).toBe('none');
    expect(manifest.vcs.available).toBe(false);
  });
});
