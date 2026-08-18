import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectVcs, collectVcsMetadata } from './detect.mjs';

let gitRepo;
let plainDir;
beforeAll(() => {
  gitRepo = mkdtempSync(join(tmpdir(), 'cg-detect-git-'));
  const g = (...a) => execFileSync('git', ['-C', gitRepo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  execFileSync('git', ['-C', gitRepo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });

  plainDir = mkdtempSync(join(tmpdir(), 'cg-detect-none-'));
  mkdirSync(join(plainDir, 'sub'));
});
afterAll(() => {
  rmSync(gitRepo, { recursive: true, force: true });
  rmSync(plainDir, { recursive: true, force: true });
});

describe('detectVcs', () => {
  it('detects git', () => { expect(detectVcs(gitRepo)).toBe('git'); });
  it('returns none otherwise', () => { expect(detectVcs(plainDir)).toBe('none'); });
});

describe('collectVcsMetadata', () => {
  it('auto → git metadata for a git repo', () => {
    const m = collectVcsMetadata(gitRepo, 'auto');
    expect(m.type).toBe('git');
    expect(m.available).toBe(true);
    expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('auto → none shape for a plain dir', () => {
    const m = collectVcsMetadata(plainDir, 'auto');
    expect(m).toEqual({
      type: 'none', available: false, root: null, branch: null,
      revision: 'no-revision', hasLocalChanges: null, warnings: [],
    });
  });

  it('mode none forces the none shape even inside a git repo', () => {
    const m = collectVcsMetadata(gitRepo, 'none');
    expect(m.type).toBe('none');
    expect(m.available).toBe(false);
    expect(m.revision).toBe('no-revision');
  });

  it('mode git forces git collection', () => {
    expect(collectVcsMetadata(gitRepo, 'git').type).toBe('git');
  });
});

describe('a repoRoot inside a checkout (monorepo service dir, workspace package)', () => {
  it('detects git even though only the top level carries a .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-sub-'));
    const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    const nested = join(root, 'services', 'myapp');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'a.txt'), 'hi');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');

    expect(existsSync(join(nested, '.git'))).toBe(false);
    expect(detectVcs(nested)).toBe('git');

    const meta = collectVcsMetadata(nested, 'auto');
    expect(meta.type).toBe('git');
    expect(meta.available).toBe(true);
    expect(meta.revision).toMatch(/^[0-9a-f]{40}$/);
  });
});
