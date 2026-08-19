import { describe, it, expect } from 'vitest';
import { suggestPaths } from './paths_suggest.mjs';

/** A package record in the shape workspace discovery produces. */
function pkg(dir) {
  return { name: '@myorg/ui', dir, entries: [`${dir}/dist/index.js`], subpaths: {} };
}

describe('suggestPaths', () => {
  it('points at src/ when the package keeps its sources there', () => {
    expect(suggestPaths(pkg('packages/ui'), [
      'packages/ui/src/index.ts',
      'packages/ui/src/button.tsx',
      'packages/ui/dist/index.js',
    ])).toEqual({
      '@myorg/ui': ['packages/ui/src'],
      '@myorg/ui/*': ['packages/ui/src/*'],
    });
  });

  // A package that is itself a monorepo may or may not give its inner packages
  // a src/ of their own, and both layouts occur in the same tree. Ordered
  // candidates settle it without a second guess: the resolver takes the first
  // that lands on an indexed file.
  it('points into the nested packages of a package that is itself a monorepo', () => {
    expect(suggestPaths(pkg('packages/ui'), [
      'packages/ui/packages/button/src/index.ts',
      'packages/ui/packages/input/src/index.ts',
    ])).toEqual({
      // No entry for the bare name: it does not pick out one inner package, and
      // a wildcard in the target of a wildcard-free pattern means nothing.
      '@myorg/ui/*': ['packages/ui/packages/*/src', 'packages/ui/packages/*'],
    });
  });

  it('handles nested packages that keep no src/ of their own', () => {
    expect(suggestPaths(pkg('packages/ui'), [
      'packages/ui/packages/button/index.tsx',
      'packages/ui/packages/common/colors.ts',
    ])).toEqual({
      '@myorg/ui/*': ['packages/ui/packages/*/src', 'packages/ui/packages/*'],
    });
  });

  it('falls back to the package directory when sources sit at its root', () => {
    expect(suggestPaths(pkg('packages/ui'), [
      'packages/ui/index.ts',
      'packages/ui/button.ts',
    ])).toEqual({
      '@myorg/ui': ['packages/ui'],
      '@myorg/ui/*': ['packages/ui/*'],
    });
  });

  // A guess that cannot be checked is worse than no guess: it would be written
  // into a config file and quietly resolve nothing.
  it('suggests nothing when the package has no indexed sources at all', () => {
    expect(suggestPaths(pkg('packages/ui'), [
      'packages/ui/dist/index.js',
      'packages/ui/README.md',
    ])).toBeNull();
  });

  it('suggests nothing when the package directory is not in the index', () => {
    expect(suggestPaths(pkg('packages/ui'), ['apps/web/src/main.ts'])).toBeNull();
  });

  it('prefers src/ over the nested layout when a package has both', () => {
    expect(suggestPaths(pkg('packages/ui'), [
      'packages/ui/src/index.ts',
      'packages/ui/packages/button/src/index.ts',
    ])['@myorg/ui']).toEqual(['packages/ui/src']);
  });

  it('ignores tests and declaration files when deciding where the sources are', () => {
    expect(suggestPaths(pkg('packages/ui'), [
      'packages/ui/src/index.test.ts',
      'packages/ui/src/index.d.ts',
    ])).toBeNull();
  });
});
