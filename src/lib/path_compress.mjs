// Path-prefix factoring for answers that list many paths.
//
// A deep monorepo path — `scenarios/6-mf-ssr/apps/shell/src/features/Cart.tsx`
// — costs ~17 tokens, and thirty of them in one blast radius repeat the same
// prefix thirty times. This module factors that prefix out ONCE.
//
// Two rules govern everything here:
//
//   1. LOSSLESS AND UNAMBIGUOUS. `expandPathGroups(compressPaths(x))` yields
//      exactly `x` — same paths, same count. Every factored line names its own
//      prefix (`under <prefix>: …`), so a reader can rebuild each full path from
//      the line it is on and nothing else. Paths that were not factored are
//      printed in full, on their own line, FIRST — so the reader meets the plain
//      form before the relative one.
//
//   2. ONLY WHEN IT PAYS. Compression that saves four characters and costs a
//      line of explanation is a net loss twice over: in tokens and in clarity.
//      A group must clear three floors — `MIN_PATHS` members, `MIN_PREFIX_CHARS`
//      of prefix, and enough total saving to earn back `GROUP_OVERHEAD_CHARS`.
//      When nothing clears them, `compressPaths` returns null and the caller
//      prints the list exactly as it always did.
//
// Prefixes are whole DIRECTORY prefixes (they always end in `/`), never
// arbitrary character prefixes: `src/checkout/` may be factored, `src/check`
// never can. That is what keeps a suffix readable as a path rather than as a
// fragment.
//
// Grouping is one level deep and never recursive: a group is not itself
// re-compressed. Nested factoring would save a little more and cost a reader
// having to compose two prefixes to know what file is being talked about.
//
// Pure: no I/O, no throwing. Inputs are repo-relative POSIX paths.

/** A list must hold at least this many paths, and so must every group. */
export const MIN_PATHS = 3;

/** Shortest prefix worth factoring — `a/` never is, `src/` may be. */
export const MIN_PREFIX_CHARS = 4;

/**
 * What a group costs to carry, in characters, beyond the prefix itself: the
 * `under …: ` label in text, or `{"pathPrefix":"…","paths":[]}` in JSON. Set to
 * the larger (JSON) of the two so a group that pays in one rendering pays in
 * both — being conservative here means we never compress for a loss.
 */
export const GROUP_OVERHEAD_CHARS = 24;

/** Every directory prefix of `path`, each including its trailing slash. */
function dirPrefixes(path) {
  const out = [];
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    out.push(path.slice(0, i + 1));
  }
  return out;
}

/** Characters saved by factoring `prefix` out of `count` paths, overhead included. */
function savingOf(prefix, count, overheadChars) {
  return (count - 1) * prefix.length - overheadChars;
}

/**
 * Factor shared directory prefixes out of a path list.
 *
 * Greedy and deterministic: repeatedly take the prefix that saves the most
 * characters over the paths not yet grouped (ties → the longer prefix, then the
 * lexicographically smaller one), until no candidate clears the floors.
 *
 * @param {string[]} paths repo-relative POSIX paths.
 * @param {{minPaths?: number, minPrefixChars?: number, overheadChars?: number}} [opts]
 * @returns {Array<{pathPrefix: string, paths: string[]}>|null} groups — `""`
 *   first when some paths stayed whole, then one group per prefix, ascending.
 *   `null` means "not worth it, print the list as-is".
 */
export function compressPaths(paths, opts = {}) {
  const minPaths = Number.isInteger(opts.minPaths) && opts.minPaths > 1 ? opts.minPaths : MIN_PATHS;
  const minPrefixChars = Number.isInteger(opts.minPrefixChars) && opts.minPrefixChars > 0
    ? opts.minPrefixChars : MIN_PREFIX_CHARS;
  const overheadChars = Number.isInteger(opts.overheadChars) && opts.overheadChars >= 0
    ? opts.overheadChars : GROUP_OVERHEAD_CHARS;

  if (!Array.isArray(paths) || paths.length < minPaths) return null;
  if (!paths.every((p) => typeof p === 'string' && p.length > 0)) return null;

  let rest = paths;
  const groups = [];
  for (;;) {
    const counts = new Map();
    for (const p of rest) {
      for (const prefix of dirPrefixes(p)) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }

    let best = null;
    for (const [prefix, count] of counts) {
      if (count < minPaths || prefix.length < minPrefixChars) continue;
      const saving = savingOf(prefix, count, overheadChars);
      if (saving <= 0) continue;
      const better = best === null
        || saving > best.saving
        || (saving === best.saving && prefix.length > best.prefix.length)
        || (saving === best.saving && prefix.length === best.prefix.length && prefix < best.prefix);
      if (better) best = { prefix, saving };
    }
    if (best === null) break;

    groups.push({
      pathPrefix: best.prefix,
      paths: rest.filter((p) => p.startsWith(best.prefix)).map((p) => p.slice(best.prefix.length)),
    });
    rest = rest.filter((p) => !p.startsWith(best.prefix));
  }

  if (groups.length === 0) return null;
  groups.sort((a, b) => (a.pathPrefix < b.pathPrefix ? -1 : 1));
  if (rest.length > 0) groups.unshift({ pathPrefix: '', paths: rest });
  return groups;
}

/**
 * `compressPaths` behind an on/off switch — the shape every caller wants.
 * @param {string[]} paths
 * @param {{compress?: boolean}} [opts] plus any `compressPaths` threshold.
 * @returns {Array<{pathPrefix: string, paths: string[]}>|null}
 */
export function pathGroupsOf(paths, opts = {}) {
  return opts.compress === true ? compressPaths(paths, opts) : null;
}

/**
 * The inverse of `compressPaths`: every full path back, in group order.
 * @param {Array<{pathPrefix?: string, paths?: string[]}>} groups
 * @returns {string[]}
 */
export function expandPathGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => (Array.isArray(g?.paths) ? g.paths : [])
    .map((p) => `${g?.pathPrefix ?? ''}${p}`));
}

/**
 * Render groups as the lines that go under a list's label.
 *
 * A line either starts with `under <prefix>: ` — every entry on it is relative
 * to that prefix — or holds full paths and starts with neither. There is no
 * third case, which is the whole reason the rendering cannot be misread.
 *
 * @param {Array<{pathPrefix: string, paths: string[]}>|null} groups
 * @returns {{lines: string[]}}
 */
export function renderPathGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return { lines: [] };
  return {
    lines: groups.map((g) => (g.pathPrefix === ''
      ? g.paths.join(', ')
      : `under ${g.pathPrefix}: ${g.paths.join(', ')}`)),
  };
}
