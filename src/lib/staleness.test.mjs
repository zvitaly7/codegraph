import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStaleness } from './staleness.mjs';

/** Run a git command inside `repo`, returning trimmed stdout. */
function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Write an inventory manifest under `cacheDir`. */
function writeManifest(cacheDir, manifest) {
  const inv = join(cacheDir, 'inventory');
  mkdirSync(inv, { recursive: true });
  writeFileSync(join(inv, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

let gitRepo;
let plainDir;
let headRev;

beforeAll(() => {
  gitRepo = mkdtempSync(join(tmpdir(), 'cg-stale-git-'));
  git(gitRepo, 'init', '-q', '-b', 'main');
  git(gitRepo, 'config', 'user.email', 't@t');
  git(gitRepo, 'config', 'user.name', 't');
  git(gitRepo, 'commit', '-q', '--allow-empty', '-m', 'init');
  headRev = git(gitRepo, 'rev-parse', 'HEAD');

  plainDir = mkdtempSync(join(tmpdir(), 'cg-stale-plain-'));
});

afterAll(() => {
  rmSync(gitRepo, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

describe('checkStaleness — no cache', () => {
  it('missing inventory/manifest.json → hasCache:false, stale:true, no-cache', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-stale-empty-'));
    expect(checkStaleness(cache)).toEqual({ hasCache: false, stale: true, reason: 'no-cache' });
    rmSync(cache, { recursive: true, force: true });
  });

  it('a non-existent cache dir also reads as no-cache (never throws)', () => {
    const cache = join(tmpdir(), 'cg-stale-nope-does-not-exist-98765');
    expect(() => checkStaleness(cache)).not.toThrow();
    expect(checkStaleness(cache)).toEqual({ hasCache: false, stale: true, reason: 'no-cache' });
  });

  it('a corrupt manifest is guarded (never throws) → no-cache', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-stale-corrupt-'));
    mkdirSync(join(cache, 'inventory'), { recursive: true });
    writeFileSync(join(cache, 'inventory', 'manifest.json'), '{ not valid json ');
    expect(() => checkStaleness(cache)).not.toThrow();
    expect(checkStaleness(cache)).toEqual({ hasCache: false, stale: true, reason: 'no-cache' });
    rmSync(cache, { recursive: true, force: true });
  });
});

describe('checkStaleness — revision comparison against a real git repo', () => {
  it('cache revision equals HEAD → up-to-date (stale:false)', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-stale-fresh-'));
    writeManifest(cache, {
      repoRoot: gitRepo,
      snapshotId: `snapshot:proj:${headRev}`,
      vcs: { type: 'git', available: true, revision: headRev },
    });
    expect(checkStaleness(cache)).toEqual({
      hasCache: true, stale: false, reason: 'up-to-date',
      cacheRevision: headRev, currentRevision: headRev,
    });
    rmSync(cache, { recursive: true, force: true });
  });

  it('parses the cache revision from snapshotId when vcs.revision is absent', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-stale-fromsid-'));
    writeManifest(cache, {
      repoRoot: gitRepo,
      snapshotId: `snapshot:proj:${headRev}`,
      // No vcs.revision on purpose — must fall back to the snapshotId tail.
      vcs: { type: 'git', available: false },
    });
    const res = checkStaleness(cache);
    expect(res.stale).toBe(false);
    expect(res.reason).toBe('up-to-date');
    expect(res.cacheRevision).toBe(headRev);
    rmSync(cache, { recursive: true, force: true });
  });

  it('a new commit moves HEAD → stale:true, revision-changed', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-stale-changed-'));
    writeManifest(cache, {
      repoRoot: gitRepo,
      snapshotId: `snapshot:proj:${headRev}`,
      vcs: { type: 'git', available: true, revision: headRev },
    });
    // Move HEAD forward.
    git(gitRepo, 'commit', '-q', '--allow-empty', '-m', 'second');
    const newRev = git(gitRepo, 'rev-parse', 'HEAD');
    expect(newRev).not.toBe(headRev);

    const res = checkStaleness(cache);
    expect(res).toEqual({
      hasCache: true, stale: true, reason: 'revision-changed',
      cacheRevision: headRev, currentRevision: newRev,
    });
    rmSync(cache, { recursive: true, force: true });
  });
});

describe('checkStaleness — vcs unknown (not an error)', () => {
  it('repoRoot is not a git repo → stale:null, vcs-unknown', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-stale-novcs-'));
    writeManifest(cache, {
      repoRoot: plainDir,
      snapshotId: 'snapshot:proj:deadbeefcafe',
      vcs: { type: 'git', available: true, revision: 'deadbeefcafe' },
    });
    const res = checkStaleness(cache);
    expect(res.hasCache).toBe(true);
    expect(res.stale).toBeNull();
    expect(res.reason).toBe('vcs-unknown');
    expect(res.cacheRevision).toBe('deadbeefcafe');
    expect(res.currentRevision).toBeNull(); // 'no-revision' normalized away
    rmSync(cache, { recursive: true, force: true });
  });

  it("cache 'no-revision' → vcs-unknown regardless of the current repo", () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-stale-norev-'));
    writeManifest(cache, {
      repoRoot: gitRepo,
      snapshotId: 'snapshot:proj:no-revision',
      vcs: { type: 'none', available: false },
    });
    const res = checkStaleness(cache);
    expect(res.stale).toBeNull();
    expect(res.reason).toBe('vcs-unknown');
    rmSync(cache, { recursive: true, force: true });
  });

  it('missing repoRoot is guarded (never throws) → vcs-unknown', () => {
    const cache = mkdtempSync(join(tmpdir(), 'cg-stale-noroot-'));
    writeManifest(cache, { snapshotId: 'snapshot:proj:abc123' }); // no repoRoot, no vcs
    expect(() => checkStaleness(cache)).not.toThrow();
    const res = checkStaleness(cache);
    expect(res.hasCache).toBe(true);
    expect(res.stale).toBeNull();
    expect(res.reason).toBe('vcs-unknown');
    rmSync(cache, { recursive: true, force: true });
  });
});
