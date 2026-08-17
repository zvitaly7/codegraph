// How a file argument is matched against the paths a command knows about —
// ONE implementation, shared by `brief` (paths from the graph), `outline` and
// `show` (paths from a filesystem scan), so the three cannot drift apart.
//
// Two tiers, in order:
//   1. the exact repo-relative path   `src/checkout/Cart.tsx`
//   2. a trailing run of whole path segments  `Cart.tsx`, `checkout/Cart.tsx`
//
// Tier 2 may match more than once — that is reported as such, never guessed:
// printing the wrong `Cart.tsx` is worse than asking which one was meant.
//
// Pure: no I/O, no throwing. Inputs are repo-relative POSIX paths.

import { normPosix } from '../inventory/schema.mjs';

/** Normalize a user-typed target: backslashes → `/`, drop a leading `./`. */
function normTarget(target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  const norm = normPosix(target).replace(/^\.\//, '');
  return norm === '' || norm === '.' ? null : norm;
}

/** The path equal to `target`, or null. */
export function exactPathMatch(paths, target) {
  const needle = normTarget(target);
  if (needle === null) return null;
  for (const p of paths) {
    if (p === needle) return p;
  }
  return null;
}

/**
 * Paths ending in `/<target>` — i.e. matching on whole trailing segments, so
 * `Cart.tsx` hits `src/ui/Cart.tsx` but `art.tsx` hits nothing. Sorted; the
 * exact path itself is NOT included (that is tier 1's job).
 */
export function suffixPathMatches(paths, target) {
  const needle = normTarget(target);
  if (needle === null) return [];
  const suffix = `/${needle}`;
  return paths.filter((p) => typeof p === 'string' && p.endsWith(suffix)).sort();
}

/**
 * Tiered resolution of a file target.
 * @param {string[]} paths repo-relative POSIX paths to match against.
 * @param {string} target user-typed path, path suffix or basename.
 * @returns {{kind: 'exact'|'suffix'|'none', matches: string[]}} `matches.length > 1` means ambiguous.
 */
export function resolveFilePath(paths, target) {
  const exact = exactPathMatch(paths, target);
  if (exact !== null) return { kind: 'exact', matches: [exact] };
  const bySuffix = suffixPathMatches(paths, target);
  return bySuffix.length > 0
    ? { kind: 'suffix', matches: bySuffix }
    : { kind: 'none', matches: [] };
}
