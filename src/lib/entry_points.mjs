// Which files are ENTRY POINTS — consumed across a boundary the static import
// graph cannot see.
//
// A Module-Federation remote, a dynamic-import target, a CLI script and a
// library's public entry are all imported by somebody, just not by anything in
// this repo. The references layer would report every symbol they export as a
// dead export, which is the single biggest source of false positives in that
// answer. Anything named here is held back instead — and counted, so the user
// can tell "not dead" from "hidden".
//
// Two sources, both optional:
//   * the `entryPoints` config knob — an array of globs, matched with the same
//     gitignore-style semantics the inventory walker already uses (a bare
//     `remote.ts` matches at any depth, `src/mf/*` at one level, `**` at any),
//   * auto-detection — the `main` / `module` / `exports` / `bin` targets of the
//     repo's package.json, and of every workspace package when the caller
//     passes a discovery result. Most repos therefore need no config at all.
//
// A declared target that resolves to no known source file is dropped: pointing
// `main` at a build output is normal, and inventing an entry point out of it
// would hide nothing but confuse everything.

import ignore from 'ignore';
import { readPackageManifest } from './workspaces.mjs';
import { SOURCE_EXTS } from './source_files.mjs';

/**
 * Resolve a declared target against the known source files: exact first, then
 * with each source extension appended, then as a directory index.
 */
function matchKnownSource(target, fileSet) {
  if (fileSet.has(target)) return target;
  for (const ext of SOURCE_EXTS) {
    if (fileSet.has(target + ext)) return target + ext;
  }
  for (const ext of SOURCE_EXTS) {
    if (fileSet.has(`${target}/index${ext}`)) return `${target}/index${ext}`;
  }
  return null;
}

/** Repo-relative label for the package.json a target came from. */
function manifestLabel(dir) {
  return dir === '.' ? 'package.json' : `${dir}/package.json`;
}

/**
 * Collect this repo's entry-point files.
 *
 * @param {object} args
 * @param {string} args.repoRoot absolute repo root.
 * @param {string[]} [args.patterns] the `entryPoints` config globs.
 * @param {string[]} [args.filePaths] the known source paths (repo-relative POSIX).
 * @param {{packages: object[]}} [args.workspaces] `discoverWorkspaces` result.
 * @returns {{paths: string[], reasons: Record<string, string>}} sorted paths,
 *   each mapped to where it came from (`config` or `<dir>/package.json`).
 */
export function collectEntryPoints({ repoRoot, patterns = [], filePaths = [], workspaces = null } = {}) {
  const fileSet = new Set(filePaths);
  const reasons = {};
  const remember = (path, reason) => {
    if (path && !(path in reasons)) reasons[path] = reason;
  };

  // 1. Config globs — declared explicitly, so they win the attribution.
  if (Array.isArray(patterns) && patterns.length > 0) {
    const matcher = ignore().add(patterns.filter((p) => typeof p === 'string'));
    for (const path of filePaths) {
      let matched = false;
      try {
        matched = matcher.ignores(path);
      } catch {
        matched = false; // a malformed pattern matches nothing
      }
      if (matched) remember(path, 'config');
    }
  }

  // 2. Auto-detection — the root package, then each workspace package.
  const dirs = ['.', ...(workspaces?.packages ?? []).map((p) => p.dir)];
  for (const dir of dirs) {
    const pkg = dir === '.' ? readPackageManifest(repoRoot, '.') : null;
    const manifest = pkg ?? (workspaces?.packages ?? []).find((p) => p.dir === dir);
    if (!manifest) continue;
    const targets = [
      ...manifest.entries,
      ...Object.values(manifest.subpaths ?? {}).flat(),
      ...manifest.bin,
    ];
    for (const target of targets) {
      remember(matchKnownSource(target, fileSet), manifestLabel(dir));
    }
  }

  return { paths: Object.keys(reasons).sort(), reasons };
}
