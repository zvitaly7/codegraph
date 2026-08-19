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

// `.mts` / `.cts` are ordinary TypeScript module files — the inventory has
// classified them since the beginning, and the type-checking layers read them.
// The import resolver did not list them, so nothing could resolve onto one.
describe('module extensions', () => {
  it('resolves a relative import onto a .mts file', () => {
    const r = make(['src/a.ts', 'src/util.mts']);
    expect(r('./util', 'src/a.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:src/util.mts' });
  });

  it('resolves a relative import onto a .cts file', () => {
    const r = make(['src/a.ts', 'src/util.cts']);
    expect(r('./util', 'src/a.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:src/util.cts' });
  });

  it('resolves a directory import onto index.mts', () => {
    const r = make(['src/a.ts', 'src/util/index.mts']);
    expect(r('./util', 'src/a.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:src/util/index.mts' });
  });
});

describe('workspace packages', () => {
  function makeWs(fileSet, packages, tsconfig = NO_TS) {
    const set = new Set(fileSet);
    const byName = new Map(packages.map((p) => [p.name, p]));
    return (specifier, fromRel) =>
      resolveSpecifier(specifier, {
        fromAbsFile: `${REPO}/${fromRel}`,
        repoRoot: REPO,
        fileSet: set,
        tsconfig,
        workspaces: byName,
      });
  }

  it('resolves a sibling workspace package to its entry file, not pkg:', () => {
    const r = makeWs(
      ['packages/app/src/main.ts', 'packages/ui/src/index.ts'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/src/index.ts'], subpaths: {} }],
    );
    expect(r('@myorg/ui', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/src/index.ts' });
  });

  it('falls back to <dir>/index.<ext> when the manifest names no entry', () => {
    const r = makeWs(
      ['packages/ui/index.tsx'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: [], subpaths: {} }],
    );
    expect(r('@myorg/ui', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/index.tsx' });
  });

  it('tries each entry candidate until one is a known source', () => {
    const r = makeWs(
      ['packages/ui/src/index.ts'],
      [{
        name: '@myorg/ui',
        dir: 'packages/ui',
        entries: ['packages/ui/dist/index.js', 'packages/ui/src/index.ts'],
        subpaths: {},
      }],
    );
    expect(r('@myorg/ui', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/src/index.ts' });
  });

  it('resolves a subpath import to the file under the package', () => {
    const r = makeWs(
      ['packages/ui/button.ts', 'packages/ui/deep/nested/thing.ts'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: [], subpaths: {} }],
    );
    expect(r('@myorg/ui/button', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/button.ts' });
    expect(r('@myorg/ui/deep/nested/thing', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/deep/nested/thing.ts' });
  });

  it('prefers an explicit exports subpath over the plain directory join', () => {
    const r = makeWs(
      ['packages/ui/src/button.ts'],
      [{
        name: '@myorg/ui',
        dir: 'packages/ui',
        entries: [],
        subpaths: { button: ['packages/ui/src/button.ts'] },
      }],
    );
    expect(r('@myorg/ui/button', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/src/button.ts' });
  });

  it('an unscoped workspace name resolves too', () => {
    const r = makeWs(
      ['packages/ui/src/index.ts'],
      [{ name: 'ui', dir: 'packages/ui', entries: ['packages/ui/src/index.ts'], subpaths: {} }],
    );
    expect(r('ui', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/src/index.ts' });
  });

  // Knowing the package is ours and not knowing which file the import lands on
  // are two different answers. Reporting the second as "third-party" throws away
  // the first: the dependency stops looking internal, the domain layer loses the
  // edge, and the resolution rate counts a miss as a success. `unresolved` says
  // what actually happened — the same answer the tsconfig-alias branch gives.
  // Reporting the miss is not enough on its own: something has to say WHICH
  // package could not be reached, or the count is a number nobody can act on.
  it('names the package it could not reach', () => {
    const r = makeWs(
      ['packages/app/src/main.ts'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/dist/index.js'], subpaths: {} }],
    );
    expect(r('@myorg/ui/button', 'packages/app/src/main.ts')).toEqual({
      kind: 'unresolved',
      targetId: null,
      reason: 'workspace-unresolved',
      packageName: '@myorg/ui',
    });
  });

  it('a workspace package that resolves to no file is unresolved, not third-party', () => {
    const r = makeWs(
      ['packages/app/src/main.ts'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/dist/index.js'], subpaths: {} }],
    );
    expect(r('@myorg/ui', 'packages/app/src/main.ts'))
      .toMatchObject({ kind: 'unresolved', targetId: null });
    expect(r('@myorg/ui/ghost', 'packages/app/src/main.ts'))
      .toMatchObject({ kind: 'unresolved', targetId: null });
  });

  it('leaves a genuine third-party package alone', () => {
    const r = makeWs(
      ['packages/ui/src/index.ts'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/src/index.ts'], subpaths: {} }],
    );
    expect(r('react', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'external', targetId: 'pkg:react', packageName: 'react' });
  });

  // A workspace package that publishes build output names `dist` in its
  // manifest. `dist` is not indexed — it is generated, not authored — so the
  // declared entry points at a file the graph will never contain. Falling back
  // to the package's own source keeps the dependency visible instead of
  // demoting a sibling package to a third party.
  it('falls back to src/ when the manifest entry points at build output', () => {
    const r = makeWs(
      ['apps/web/src/main.ts', 'packages/ui/src/index.ts'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/dist/index.mjs'], subpaths: {} }],
    );
    expect(r('@myorg/ui', 'apps/web/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/src/index.ts' });
  });

  it('falls back to src/ for a subpath whose declared target is build output', () => {
    const r = makeWs(
      ['apps/web/src/main.ts', 'packages/ui/src/Button/index.ts'],
      [{
        name: '@myorg/ui',
        dir: 'packages/ui',
        entries: ['packages/ui/dist'],
        subpaths: { Button: ['packages/ui/dist/Button.mjs'] },
      }],
    );
    expect(r('@myorg/ui/Button', 'apps/web/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/src/Button/index.ts' });
  });

  // A manifest entry names the built file: `dist/export/index.mjs`. The authored
  // file it was built from usually sits at the same place under the source root,
  // so the same relative path is tried there before giving up. This reaches the
  // packages a bare `<dir>/src` fallback cannot — the ones whose entry is nested.
  it('follows a build entry back to the source file it was built from', () => {
    const r = makeWs(
      ['apps/web/src/main.ts', 'packages/core/src/export/index.ts'],
      [{
        name: '@myorg/core',
        dir: 'packages/core',
        entries: ['packages/core/dist/export/index.mjs'],
        subpaths: {},
      }],
    );
    expect(r('@myorg/core', 'apps/web/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/core/src/export/index.ts' });
  });

  it('follows a build subpath back to its source too', () => {
    const r = makeWs(
      ['apps/web/src/main.ts', 'packages/core/src/api/client.ts'],
      [{
        name: '@myorg/core',
        dir: 'packages/core',
        entries: ['packages/core/dist/index.mjs'],
        subpaths: { api: ['packages/core/dist/api/client.mjs'] },
      }],
    );
    expect(r('@myorg/core/api', 'apps/web/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/core/src/api/client.ts' });
  });

  it('tries the build path without its output directory as well', () => {
    const r = makeWs(
      ['apps/web/src/main.ts', 'packages/core/export/index.ts'],
      [{
        name: '@myorg/core',
        dir: 'packages/core',
        entries: ['packages/core/dist/export/index.mjs'],
        subpaths: {},
      }],
    );
    expect(r('@myorg/core', 'apps/web/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/core/export/index.ts' });
  });

  it('a declared entry that does resolve still wins over the src fallback', () => {
    const r = makeWs(
      ['packages/ui/lib/index.ts', 'packages/ui/src/index.ts'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/lib/index.ts'], subpaths: {} }],
    );
    expect(r('@myorg/ui', 'apps/web/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/lib/index.ts' });
  });

  it('a tsconfig alias still wins over the workspace map', () => {
    const tsconfig = { paths: { '@myorg/ui': ['packages/ui/src/aliased.ts'] }, pathsBase: REPO };
    const r = makeWs(
      ['packages/ui/src/index.ts', 'packages/ui/src/aliased.ts'],
      [{ name: '@myorg/ui', dir: 'packages/ui', entries: ['packages/ui/src/index.ts'], subpaths: {} }],
      tsconfig,
    );
    expect(r('@myorg/ui', 'packages/app/src/main.ts'))
      .toEqual({ kind: 'internal', targetId: 'file:packages/ui/src/aliased.ts' });
  });
});

describe('edge cases', () => {
  const r = make(['src/a.ts']);
  it('an absolute-path specifier is unresolved', () => {
    expect(r('/etc/passwd', 'src/a.ts')).toEqual({ kind: 'unresolved', targetId: null });
  });
});
