import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

import { createProgramCache, programKey, buildProgram } from './program_cache.mjs';
import { defaultCompilerOptions } from './ts_resolve.mjs';

describe('programKey', () => {
  const base = { kind: 'full', rootNames: ['/a/b.ts', '/a/a.ts'], options: { allowJs: true } };

  it('is stable across root-name ORDER (the program sorts them anyway)', () => {
    expect(programKey(base)).toBe(programKey({ ...base, rootNames: ['/a/a.ts', '/a/b.ts'] }));
  });

  it('is stable across option KEY order', () => {
    const a = { ...base, options: { allowJs: true, checkJs: false, target: 99 } };
    const b = { ...base, options: { target: 99, checkJs: false, allowJs: true } };
    expect(programKey(a)).toBe(programKey(b));
  });

  it('differs when the file SET differs (a --max-files cap on one layer)', () => {
    expect(programKey(base)).not.toBe(programKey({ ...base, rootNames: ['/a/a.ts'] }));
  });

  it('differs when a compiler option VALUE differs', () => {
    expect(programKey(base)).not.toBe(programKey({ ...base, options: { allowJs: false } }));
  });

  it('differs when a compiler option is added', () => {
    expect(programKey(base)).not.toBe(programKey({ ...base, options: { allowJs: true, jsx: 1 } }));
  });

  it('differs on nested option values (tsconfig `paths`)', () => {
    const a = { ...base, options: { paths: { '@app/*': ['src/*'] } } };
    const b = { ...base, options: { paths: { '@app/*': ['lib/*'] } } };
    expect(programKey(a)).not.toBe(programKey(b));
  });

  it('differs between full and incremental mode', () => {
    expect(programKey(base)).not.toBe(programKey({ ...base, kind: 'incremental' }));
  });

  it('differs on the `extra` bag (e.g. a different .tsbuildinfo)', () => {
    const a = { ...base, extra: { tsBuildInfoFile: '/x/.tsbuildinfo' } };
    const b = { ...base, extra: { tsBuildInfoFile: '/y/.tsbuildinfo' } };
    expect(programKey(a)).not.toBe(programKey(b));
  });
});

describe('createProgramCache', () => {
  const req = { kind: 'full', rootNames: ['/a/a.ts'], options: { allowJs: true } };

  it('builds once and reuses the SAME object for an identical request', () => {
    const cache = createProgramCache();
    const first = cache.get(req, () => ({ id: 1 }));
    const second = cache.get({ ...req }, () => ({ id: 2 }));

    expect(first.shared).toBe(false);
    expect(second.shared).toBe(true);
    expect(second.program).toBe(first.program);
    expect(cache.stats()).toEqual({ builds: 1, hits: 1 });
  });

  it('REBUILDS rather than sharing when the file set differs', () => {
    const cache = createProgramCache();
    const first = cache.get(req, () => ({ id: 1 }));
    const second = cache.get({ ...req, rootNames: ['/a/a.ts', '/a/b.ts'] }, () => ({ id: 2 }));

    expect(second.shared).toBe(false);
    expect(second.program).not.toBe(first.program);
    expect(cache.stats()).toEqual({ builds: 2, hits: 0 });
  });

  it('REBUILDS rather than sharing when the compiler options differ', () => {
    const cache = createProgramCache();
    cache.get(req, () => ({ id: 1 }));
    const second = cache.get({ ...req, options: { allowJs: false } }, () => ({ id: 2 }));

    expect(second.shared).toBe(false);
    expect(cache.stats()).toEqual({ builds: 2, hits: 0 });
  });

  it('REBUILDS rather than sharing across full/incremental modes', () => {
    const cache = createProgramCache();
    cache.get(req, () => ({ id: 1 }));
    const second = cache.get({ ...req, kind: 'incremental' }, () => ({ id: 2 }));

    expect(second.shared).toBe(false);
    expect(cache.stats()).toEqual({ builds: 2, hits: 0 });
  });

  it('clear() drops the program so the next identical request rebuilds', () => {
    const cache = createProgramCache();
    cache.get(req, () => ({ id: 1 }));
    cache.clear();
    const after = cache.get(req, () => ({ id: 2 }));

    expect(after.shared).toBe(false);
    expect(cache.stats()).toEqual({ builds: 2, hits: 0 });
  });
});

describe('buildProgram', () => {
  it('produces a program equivalent to ts.createProgram on the same inputs', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cg-progcache-'));
    try {
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'a.ts'), "export const a = 1;\n");
      writeFileSync(join(repo, 'src', 'b.ts'), "import { a } from './a';\nexport const b = a + 1;\n");
      const roots = [join(repo, 'src', 'b.ts'), join(repo, 'src', 'a.ts')];
      const options = defaultCompilerOptions();

      const mine = buildProgram({ rootNames: roots, options });
      const theirs = ts.createProgram([...roots].sort(), options);

      const names = (p) => p.getSourceFiles().map((sf) => sf.fileName).sort();
      expect(names(mine)).toEqual(names(theirs));
      expect(mine.getRootFileNames()).toEqual(theirs.getRootFileNames());
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
