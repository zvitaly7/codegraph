import { describe, it, expect } from 'vitest';
import { exactPathMatch, suffixPathMatches, resolveFilePath } from './path_match.mjs';

const PATHS = [
  'src/checkout/Cart.tsx',
  'src/ui/Cart.tsx',
  'src/core/util.ts',
  'index.ts',
];

describe('exactPathMatch', () => {
  it('matches a repo-relative path verbatim', () => {
    expect(exactPathMatch(PATHS, 'src/core/util.ts')).toBe('src/core/util.ts');
  });

  it('normalizes backslashes and a leading ./', () => {
    expect(exactPathMatch(PATHS, './src/core/util.ts')).toBe('src/core/util.ts');
    expect(exactPathMatch(PATHS, 'src\\core\\util.ts')).toBe('src/core/util.ts');
  });

  it('returns null when nothing matches exactly', () => {
    expect(exactPathMatch(PATHS, 'util.ts')).toBeNull();
    expect(exactPathMatch(PATHS, '')).toBeNull();
    expect(exactPathMatch(PATHS, undefined)).toBeNull();
  });
});

describe('suffixPathMatches', () => {
  it('matches on a basename, sorted', () => {
    expect(suffixPathMatches(PATHS, 'Cart.tsx')).toEqual([
      'src/checkout/Cart.tsx', 'src/ui/Cart.tsx',
    ]);
  });

  it('matches on a trailing path segment run', () => {
    expect(suffixPathMatches(PATHS, 'ui/Cart.tsx')).toEqual(['src/ui/Cart.tsx']);
  });

  it('only matches whole segments', () => {
    expect(suffixPathMatches(PATHS, 'art.tsx')).toEqual([]);
  });

  it('does not return the exact path as its own suffix match', () => {
    expect(suffixPathMatches(PATHS, 'index.ts')).toEqual([]);
  });
});

describe('resolveFilePath', () => {
  it('prefers an exact path over any suffix match', () => {
    const paths = ['Cart.tsx', 'src/ui/Cart.tsx'];
    expect(resolveFilePath(paths, 'Cart.tsx')).toEqual({ kind: 'exact', matches: ['Cart.tsx'] });
  });

  it('falls back to suffix matches', () => {
    expect(resolveFilePath(PATHS, 'util.ts')).toEqual({ kind: 'suffix', matches: ['src/core/util.ts'] });
  });

  it('reports every candidate when a suffix is ambiguous', () => {
    const r = resolveFilePath(PATHS, 'Cart.tsx');
    expect(r.kind).toBe('suffix');
    expect(r.matches).toHaveLength(2);
  });

  it('reports no match', () => {
    expect(resolveFilePath(PATHS, 'nope.ts')).toEqual({ kind: 'none', matches: [] });
  });
});
