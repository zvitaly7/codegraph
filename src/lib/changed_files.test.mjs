import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, rmSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFilesSince } from './changed_files.mjs';

/** Init a git repo with a first commit of three source files; return {repo, rev}. */
function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'cg-changed-'));
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
  writeFileSync(join(repo, 'src', 'c.ts'), 'export const c = 3;\n');
  g('add', '-A');
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });
  const rev = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { repo, rev, g };
}

describe('changedFilesSince', () => {
  let repo; let rev; let g;
  beforeEach(() => { ({ repo, rev, g } = makeGitRepo()); });

  it('detects an uncommitted modification', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 11;\n');
    const r = changedFilesSince(repo, rev);
    expect(r.ok).toBe(true);
    expect(r.modified).toContain('src/a.ts');
    expect(r.added).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  it('detects an untracked (new) file as added', () => {
    writeFileSync(join(repo, 'src', 'd.ts'), 'export const d = 4;\n');
    const r = changedFilesSince(repo, rev);
    expect(r.ok).toBe(true);
    expect(r.added).toContain('src/d.ts');
    expect(r.modified).toEqual([]);
  });

  it('detects a deletion', () => {
    rmSync(join(repo, 'src', 'c.ts'));
    const r = changedFilesSince(repo, rev);
    expect(r.ok).toBe(true);
    expect(r.deleted).toContain('src/c.ts');
  });

  it('detects committed changes since the revision', () => {
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 22;\n');
    writeFileSync(join(repo, 'src', 'e.ts'), 'export const e = 5;\n');
    g('add', '-A');
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'second'], { stdio: 'pipe' });
    const r = changedFilesSince(repo, rev);
    expect(r.ok).toBe(true);
    expect(r.modified).toContain('src/b.ts');
    expect(r.added).toContain('src/e.ts');
  });

  it('reports a full add+modify+delete set at once', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 111;\n'); // modify
    writeFileSync(join(repo, 'src', 'z.ts'), 'export const z = 9;\n');   // add (untracked)
    rmSync(join(repo, 'src', 'b.ts'));                                    // delete
    const r = changedFilesSince(repo, rev);
    expect(r.ok).toBe(true);
    expect(r.modified).toContain('src/a.ts');
    expect(r.added).toContain('src/z.ts');
    expect(r.deleted).toContain('src/b.ts');
    // Buckets are disjoint.
    const all = [...r.added, ...r.modified, ...r.deleted];
    expect(new Set(all).size).toBe(all.length);
  });

  it('reports a rename as delete(old) + add(new)', () => {
    g('mv', join('src', 'c.ts'), join('src', 'c2.ts'));
    const r = changedFilesSince(repo, rev);
    expect(r.ok).toBe(true);
    expect(r.deleted).toContain('src/c.ts');
    expect(r.added).toContain('src/c2.ts');
  });

  it('returns sorted arrays', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'zzz.ts'), 'export const z = 1;\n');
    writeFileSync(join(repo, 'aaa.ts'), 'export const q = 1;\n');
    const r = changedFilesSince(repo, rev);
    expect(r.added).toEqual([...r.added].sort());
    expect(r.modified).toEqual([...r.modified].sort());
  });

  it('ok:false when the revision is the no-revision sentinel', () => {
    expect(changedFilesSince(repo, 'no-revision')).toEqual({
      ok: false, added: [], modified: [], deleted: [],
    });
  });

  it('ok:false when the revision is missing/empty', () => {
    expect(changedFilesSince(repo, '').ok).toBe(false);
    expect(changedFilesSince(repo, null).ok).toBe(false);
    expect(changedFilesSince(repo, undefined).ok).toBe(false);
  });

  it('ok:false when the revision does not exist in the repo', () => {
    const r = changedFilesSince(repo, '0'.repeat(40));
    expect(r.ok).toBe(false);
  });

  it('ok:false on a non-git directory (never throws)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cg-nogit-'));
    const r = changedFilesSince(plain, 'HEAD');
    expect(r).toEqual({ ok: false, added: [], modified: [], deleted: [] });
  });
});
