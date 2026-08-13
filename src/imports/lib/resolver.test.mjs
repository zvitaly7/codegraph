import { describe, it, expect } from 'vitest';
import { resolveSpecifier } from './resolver.mjs';

const REPO = '/repo';
const NO_TS = { paths: {}, pathsBase: undefined };

function make(fileSet, tsconfig = NO_TS) {
  const set = new Set(fileSet);
  return (specifier, fromRel) =>
    resolveSpecifier(specifier, {
      fromAbsFile: `${REPO}/${fromRel}`,
      repoRoot: REPO,
      fileSet: set,
      tsconfig,
    });
}

describe('relative specifiers', () => {
  const r = make(['src/a.ts', 'src/util/index.ts', 'src/b.mjs']);

  it('resolves an extensionless sibling via candidate extensions', () => {
    expect(r('./a', 'src/entry.ts')).toEqual({ kind: 'internal', targetId: 'file:src/a.ts' });
  });

  it('resolves an explicit extension as-is (.mjs)', () => {
    expect(r('./b.mjs', 'src/entry.ts')).toEqual({ kind: 'internal', targetId: 'file:src/b.mjs' });
  });

  it('resolves a directory via /index', () => {
    expect(r('./util', 'src/entry.ts')).toEqual({ kind: 'internal', targetId: 'file:src/util/index.ts' });
  });

  it('resolves .. against the parent directory', () => {
    expect(r('../a', 'src/util/deep.ts')).toEqual({ kind: 'internal', targetId: 'file:src/a.ts' });
  });

  it('marks a relative miss as unresolved', () => {
    expect(r('./nope', 'src/entry.ts')).toEqual({ kind: 'unresolved', targetId: null });
    // A non-source target (e.g. ./styles.css) is never in the source file set.
    expect(r('./styles.css', 'src/entry.ts')).toEqual({ kind: 'unresolved', targetId: null });
  });
});

describe('tsconfig path aliases', () => {
  const ts = {
    paths: {
      '@app/*': ['src/app/*'],
      '@app/special/*': ['src/special/*'],
      '@lib': ['src/lib/index.ts'],
      '@multi/*': ['does/not/exist/*', 'src/app/*'],
    },
    pathsBase: '/repo',
  };
  const r = make(['src/app/util.ts', 'src/special/x.ts', 'src/lib/index.ts'], ts);

  it('substitutes a wildcard alias and resolves internal', () => {
    expect(r('@app/util', 'src/entry.ts')).toEqual({ kind: 'internal', targetId: 'file:src/app/util.ts' });
  });

  it('prefers the longest-prefix matching alias', () => {
    expect(r('@app/special/x', 'src/entry.ts')).toEqual({ kind: 'internal', targetId: 'file:src/special/x.ts' });
  });

  it('resolves an exact (non-wildcard) alias', () => {
    expect(r('@lib', 'src/entry.ts')).toEqual({ kind: 'internal', targetId: 'file:src/lib/index.ts' });
  });

  it('tries each substitution target until one resolves', () => {
    expect(r('@multi/util', 'src/entry.ts')).toEqual({ kind: 'internal', targetId: 'file:src/app/util.ts' });
  });

  it('an alias that matches but resolves nowhere is unresolved (not external)', () => {
    expect(r('@app/ghost', 'src/entry.ts')).toEqual({ kind: 'unresolved', targetId: null });
  });
});

describe('bare specifiers → external packages', () => {
  const r = make([]);

  it('unscoped package uses the first path segment', () => {
    expect(r('react', 'src/a.ts')).toEqual({ kind: 'external', targetId: 'pkg:react', packageName: 'react' });
    expect(r('lodash/fp', 'src/a.ts')).toEqual({ kind: 'external', targetId: 'pkg:lodash', packageName: 'lodash' });
  });

  it('scoped package uses the first two segments', () => {
    expect(r('@scope/pkg', 'src/a.ts')).toEqual({ kind: 'external', targetId: 'pkg:@scope/pkg', packageName: '@scope/pkg' });
    expect(r('@scope/pkg/sub/deep', 'src/a.ts')).toEqual({ kind: 'external', targetId: 'pkg:@scope/pkg', packageName: '@scope/pkg' });
  });

  it('classifies node: builtins as external packages', () => {
    expect(r('node:fs', 'src/a.ts')).toEqual({ kind: 'external', targetId: 'pkg:node:fs', packageName: 'node:fs' });
  });

  it('does not treat a bare specifier as an alias when no tsconfig paths match', () => {
    expect(r('@app/util', 'src/a.ts')).toEqual({ kind: 'external', targetId: 'pkg:@app/util', packageName: '@app/util' });
  });
});

describe('edge cases', () => {
  const r = make(['src/a.ts']);
  it('an absolute-path specifier is unresolved', () => {
    expect(r('/etc/passwd', 'src/a.ts')).toEqual({ kind: 'unresolved', targetId: null });
  });
});
