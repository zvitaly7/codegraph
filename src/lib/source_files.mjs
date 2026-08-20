// "What are this repo's source files?" — answered WITHOUT the graph.
//
// `outline` and `show` must work on a repo that has never been indexed, so they
// need their own file list. It honours the same ignore rules the inventory layer
// walks with (`.gitignore` + `.kgignore`, plus the hard-skips) and keeps only the
// JS/TS family — the files the TypeScript parser can actually read.
//
// The only I/O is `readdirSync`; the result is sorted, so two runs over the same
// tree return the same list in the same order.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IgnoreRules } from '../inventory/ignore.mjs';

/** Extensions the TS parser handles — the universe `outline`/`show` search. */
export const SOURCE_EXTS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
];

/** True when a path ends in one of `SOURCE_EXTS`. */
export function isSourcePath(relPath) {
  return typeof relPath === 'string' && SOURCE_EXTS.some((ext) => relPath.toLowerCase().endsWith(ext));
}

/**
 * Every JS/TS source file under `repoRoot`, as sorted repo-relative POSIX paths.
 * @param {string} repoRoot
 * @param {{ignoreFile?: string, ignoreRules?: IgnoreRules}} [opts]
 * @returns {string[]}
 */
export function listSourceFiles(repoRoot, { ignoreFile = '.gitignore', ignoreRules } = {}) {
  const rules = ignoreRules ?? IgnoreRules.fromRepo(repoRoot, { ignoreFile });
  const out = [];

  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory → no children
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      const isDir = entry.isDirectory();
      if (rules.shouldSkip(rel, isDir)) continue;
      if (isDir) walk(join(absDir, entry.name), rel);
      else if (isSourcePath(rel)) out.push(rel);
    }
  };

  walk(repoRoot, '');
  return out.sort();
}
