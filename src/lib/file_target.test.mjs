import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFileTarget, readRepoFile } from './file_target.mjs';
import { listSourceFiles } from './source_files.mjs';

let repo;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'lg-file-target-'));
  mkdirSync(join(repo, 'src', 'ui'), { recursive: true });
  mkdirSync(join(repo, 'src', 'checkout'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(repo, 'src', 'ui', 'Cart.tsx'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'checkout', 'Cart.tsx'), 'export const b = 2;\n');
  writeFileSync(join(repo, 'src', 'util.ts'), 'export const c = 3;\n');
  writeFileSync(join(repo, 'README.md'), '# hi\n');
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
  mkdirSync(join(repo, 'ignored'), { recursive: true });
  writeFileSync(join(repo, 'ignored', 'skip.ts'), 'export const d = 4;\n');
});

describe('listSourceFiles', () => {
  it('lists JS/TS files, honouring ignore rules and hard skips', () => {
    expect(listSourceFiles(repo)).toEqual([
      'src/checkout/Cart.tsx', 'src/ui/Cart.tsx', 'src/util.ts',
    ]);
  });
});

describe('resolveFileTarget', () => {
  it('takes an exact repo-relative path', () => {
    expect(resolveFileTarget(repo, 'src/util.ts')).toEqual({ kind: 'file', path: 'src/util.ts' });
  });

  it('takes a bare basename', () => {
    expect(resolveFileTarget(repo, 'util.ts')).toEqual({ kind: 'file', path: 'src/util.ts' });
  });

  it('reports every candidate for an ambiguous basename', () => {
    const r = resolveFileTarget(repo, 'Cart.tsx');
    expect(r.kind).toBe('ambiguous');
    expect(r.candidates).toEqual(['src/checkout/Cart.tsx', 'src/ui/Cart.tsx']);
  });

  it('disambiguates with a longer suffix', () => {
    expect(resolveFileTarget(repo, 'ui/Cart.tsx')).toEqual({ kind: 'file', path: 'src/ui/Cart.tsx' });
  });

  it('suggests near-misses when nothing matches', () => {
    const r = resolveFileTarget(repo, 'cart');
    expect(r.kind).toBe('not-found');
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('flags an existing file the TS parser cannot read', () => {
    expect(resolveFileTarget(repo, 'README.md')).toMatchObject({ kind: 'unsupported', path: 'README.md' });
  });

  it('resolves an explicit path even when it is ignored or hard-skipped', () => {
    expect(resolveFileTarget(repo, 'ignored/skip.ts')).toEqual({ kind: 'file', path: 'ignored/skip.ts' });
    expect(resolveFileTarget(repo, 'node_modules/dep/index.js').kind).toBe('file');
  });

  it('refuses to escape the repo root', () => {
    expect(resolveFileTarget(repo, '../../etc/passwd').kind).toBe('not-found');
  });
});

describe('readRepoFile', () => {
  it('reads a repo-relative file', () => {
    expect(readRepoFile(repo, 'src/util.ts')).toContain('export const c');
  });

  it('returns null outside the repo root or for a missing file', () => {
    expect(readRepoFile(repo, '../outside.ts')).toBeNull();
    expect(readRepoFile(repo, 'nope.ts')).toBeNull();
  });
});
