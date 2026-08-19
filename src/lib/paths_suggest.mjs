// Propose a `paths` mapping for a package the repo owns but no import could be
// traced into.
//
// The report already names such packages; a name alone still leaves the reader
// to work out where that package keeps its sources. This does that reading for
// them — but only from files the inventory actually holds, so a suggestion that
// would resolve nothing is never made. A guess written into a config file and
// silently resolving nothing is worse than no guess at all.
//
// Three layouts, checked in order:
//   1. `<dir>/src/…`                 — the ordinary package,
//   2. `<dir>/packages/<pkg>/src/…`  — a package that is itself a monorepo,
//   3. `<dir>/…`                     — sources at the package root.

/** Extensions the import graph can actually land on. */
const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Directories holding generated output. The inventory already leaves most of
 * them out, but a suggestion that points at a build is wrong even when someone
 * hands us one — that is the very mistake being corrected here.
 */
const GENERATED = new Set(['dist', 'build', 'out', '.next', 'coverage', 'storybook-static', '__generated__']);

/**
 * A file that can be the target of an import: real source, not a declaration
 * file (nothing imports a `.d.ts` for its value), not generated, not a test.
 */
function isImportable(path) {
  if (path.split('/').some((seg) => GENERATED.has(seg))) return false;
  if (/\.d\.(ts|mts|cts)$/.test(path)) return false;
  if (/(^|\/)__tests__\//.test(path)) return false;
  if (/\.(test|spec)\.[a-z]+$/.test(path)) return false;
  return SOURCE_EXTS.some((ext) => path.endsWith(ext));
}

/**
 * Suggest a `paths` table for one package.
 *
 * @param {{name: string, dir: string}} pkg the package, as workspace discovery
 *   reports it — `dir` is repo-relative POSIX.
 * @param {Iterable<string>} sourcePaths every repo-relative path the inventory
 *   holds.
 * @returns {Record<string, string[]>|null} a `paths` fragment, or null when no
 *   layout could be confirmed against the index.
 */
export function suggestPaths(pkg, sourcePaths) {
  const prefix = `${pkg.dir}/`;
  const inside = [];
  for (const path of sourcePaths) {
    if (path.startsWith(prefix) && isImportable(path)) inside.push(path.slice(prefix.length));
  }
  if (inside.length === 0) return null;

  const entry = (bare, star) => ({ [pkg.name]: bare, [`${pkg.name}/*`]: star });

  if (inside.some((rel) => rel.startsWith('src/'))) {
    return entry([`${pkg.dir}/src`], [`${pkg.dir}/src/*`]);
  }

  // A package that is itself a monorepo: one wildcard segment stands for the
  // inner package in both patterns. Whether those inner packages keep a src/ of
  // their own varies inside a single tree, so both are offered in order and the
  // resolver takes the first that lands on an indexed file.
  if (inside.some((rel) => /^packages\/[^/]+\//.test(rel))) {
    // Only the subpath pattern: the bare name does not pick out one inner
    // package, and a wildcard in the target of a wildcard-free pattern is not a
    // substitution — it is a directory called `*`. A bare import of such a
    // package stays unresolved, and the report keeps saying so.
    return { [`${pkg.name}/*`]: [`${pkg.dir}/packages/*/src`, `${pkg.dir}/packages/*`] };
  }

  return entry([pkg.dir], [`${pkg.dir}/*`]);
}

/**
 * Suggestions for several packages at once, merged into one `paths` table.
 * Packages whose layout could not be confirmed are simply absent.
 *
 * @param {Array<{name: string, dir: string}>} packages
 * @param {Iterable<string>} sourcePaths
 * @returns {Record<string, string[]>}
 */
export function suggestPathsFor(packages, sourcePaths) {
  const paths = [...sourcePaths];
  const out = {};
  for (const pkg of packages) {
    Object.assign(out, suggestPaths(pkg, paths) ?? {});
  }
  return out;
}
