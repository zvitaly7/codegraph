// Resolve a single import specifier from an importing file to a target:
//   internal    → a source file present in the inventory  (file:<relPath>)
//   external    → a third-party package                   (pkg:<name>)
//   unresolved  → a relative / aliased path we could not map to a source
//
// Precedence: relative → tsconfig alias → workspace package → external. The
// workspace step only ever claims a bare specifier that would otherwise be
// written off as third-party, so a repo with no workspaces resolves exactly as
// it always did.
//
// Resolution is purely lexical against the known inventory file set — we never
// touch the filesystem — so the result is deterministic and matches the graph
// nodes exactly (an internal edge always points at a File node we emit). The
// workspace map is filesystem-derived, but it is built once, up front, by
// lib/workspaces.mjs and passed in as plain data.

import { dirname, resolve as resolvePath, relative } from 'node:path';
import { fileId, normPosix } from '../../inventory/schema.mjs';

// Candidate extensions, tried in order (bundler-ish superset of TS + Node ESM).
const EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

function isRelative(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

/** Repo-relative POSIX path for an absolute path. */
function toRel(repoRoot, abs) {
  return normPosix(relative(repoRoot, abs));
}

/**
 * Given an absolute base path (no assumed extension), try the candidate forms
 * and return the repo-relative path of the first that is a known source, else
 * null. Order: exact → base+ext → base/index+ext.
 */
function matchSource(absBase, repoRoot, fileSet) {
  const candidates = [absBase];
  for (const ext of EXTS) candidates.push(absBase + ext);
  for (const ext of EXTS) candidates.push(`${absBase}/index${ext}`);
  for (const abs of candidates) {
    const rel = toRel(repoRoot, abs);
    if (fileSet.has(rel)) return rel;
  }
  return null;
}

/**
 * Return the ordered list of substitution paths for a specifier that matches a
 * tsconfig `paths` pattern, or null if nothing matches. Longest-prefix / exact
 * matches win, mirroring the TypeScript resolver's specificity ordering.
 */
function aliasSubstitutions(specifier, paths) {
  let best = null; // { score, substitutions: string[] }
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (specifier === pattern) {
        const score = pattern.length + 1; // exact matches are the most specific
        if (!best || score > best.score) best = { score, substitutions: targets.slice() };
      }
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
      const score = prefix.length;
      if (!best || score > best.score) {
        best = { score, substitutions: targets.map((t) => t.replace('*', matched)) };
      }
    }
  }
  return best ? best.substitutions : null;
}

/** Derive an npm package name from a bare specifier (@scope/name → two segments). */
function packageNameOf(specifier) {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : segments[0];
  }
  return segments[0];
}

/**
 * The ordered repo-relative bases to try for a workspace package specifier:
 * the package's declared entry targets (or, for a subpath, its explicit
 * `exports` targets) first, then the plain directory join — which `matchSource`
 * expands with the same extension / `index.<ext>` candidates as everything else.
 */
function workspaceBases(pkg, subpath) {
  // Declared targets first, then the conventions. A package that publishes
  // build output names `dist` in its manifest, and `dist` is generated rather
  // than authored, so the inventory does not carry it — the declared entry then
  // points at a file the graph will never contain. The source layout is the
  // only place left that can keep the dependency visible, and a candidate still
  // has to land on an indexed file to win.
  if (subpath === '') return [...pkg.entries, `${pkg.dir}/src`, pkg.dir];
  return [
    ...(pkg.subpaths?.[subpath] ?? []),
    `${pkg.dir}/src/${subpath}`,
    `${pkg.dir}/${subpath}`,
  ];
}

/**
 * @param {string} specifier raw import specifier.
 * @param {object} ctx
 * @param {string} ctx.fromAbsFile absolute path of the importing file.
 * @param {string} ctx.repoRoot    absolute repo root.
 * @param {Set<string>} ctx.fileSet repo-relative POSIX paths of source files.
 * @param {{paths:object, pathsBase?:string}} ctx.tsconfig alias config for this file.
 * @param {Map<string, {dir:string, entries:string[], subpaths:object}>} [ctx.workspaces]
 *   workspace packages by declared name (see lib/workspaces.mjs). Absent or
 *   empty → resolution is exactly what it was before workspaces existed.
 * @returns {{kind:'internal'|'external'|'unresolved', targetId:string|null, packageName?:string}}
 */
export function resolveSpecifier(specifier, { fromAbsFile, repoRoot, fileSet, tsconfig, workspaces }) {
  // 1. Relative — resolve against the importing file's directory.
  if (isRelative(specifier)) {
    const absBase = resolvePath(dirname(fromAbsFile), specifier);
    const rel = matchSource(absBase, repoRoot, fileSet);
    return rel ? { kind: 'internal', targetId: fileId(rel) } : { kind: 'unresolved', targetId: null };
  }

  // 2. tsconfig path alias — substitute, then resolve like a relative path.
  const paths = tsconfig?.paths ?? {};
  const base = tsconfig?.pathsBase;
  if (base && Object.keys(paths).length > 0) {
    const substitutions = aliasSubstitutions(specifier, paths);
    if (substitutions) {
      for (const sub of substitutions) {
        const absBase = resolvePath(base, sub);
        const rel = matchSource(absBase, repoRoot, fileSet);
        if (rel) return { kind: 'internal', targetId: fileId(rel) };
      }
      // Alias matched but nothing resolved: it was meant to be internal.
      return { kind: 'unresolved', targetId: null };
    }
  }

  // 3. Absolute filesystem paths are not classifiable as a package.
  if (specifier.startsWith('/')) return { kind: 'unresolved', targetId: null };

  const packageName = packageNameOf(specifier);

  // 4. A sibling workspace package is internal, not third-party — but only when
  //    it lands on a file the inventory actually knows. An unresolvable name
  //    falls through to step 5 rather than inventing an edge.
  const pkg = workspaces?.get(packageName);
  if (pkg) {
    const subpath = specifier.slice(packageName.length).replace(/^\//, '');
    for (const relBase of workspaceBases(pkg, subpath)) {
      const rel = matchSource(resolvePath(repoRoot, relBase), repoRoot, fileSet);
      if (rel) return { kind: 'internal', targetId: fileId(rel) };
    }
  }

  // 5. Bare specifier — external package.
  return { kind: 'external', targetId: `pkg:${packageName}`, packageName };
}
