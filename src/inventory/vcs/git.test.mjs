import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGitMetadata } from './git.mjs';

let repo;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'cg-git-'));
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'hi');
  g('add', '-A'); g('commit', '-q', '-m', 'init');
});

describe('collectGitMetadata', () => {
  it('reports branch, revision, clean tree', () => {
    const m = collectGitMetadata(repo);
    expect(m.type).toBe('git');
    expect(m.available).toBe(true);
    expect(m.branch).toBe('main');
    expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(m.hasLocalChanges).toBe(false);
  });

  it('never throws on a non-git dir', () => {
    const m = collectGitMetadata(tmpdir() + '/definitely-not-a-repo-xyz');
    expect(m.available).toBe(false);
    expect(m.warnings).toBeInstanceOf(Array);
    expect(m.revision).toBe('no-revision');
  });
});
