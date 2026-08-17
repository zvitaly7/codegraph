// Turn a user-typed file argument into one real file on disk — the shared
// front door for `outline` and `show` (CLI and MCP alike).
//
// An exact repo-relative path that exists wins immediately, so an explicit path
// always works (even for an ignored file like `dist/bundle.js`). Otherwise the
// repo's source files are listed and matched with lib/path_match.mjs, the same
// forgiving suffix rule `brief` uses — and more than one match is reported as
// ambiguous, never guessed.
//
// The resolved file is always INSIDE the repo root: `../../etc/passwd` resolves
// to nothing. `outline`/`show` are also served over MCP, where the caller is a
// model, so "stay in the repo" is enforced here rather than trusted upstream.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { normPosix } from '../inventory/schema.mjs';
import { resolveFilePath } from './path_match.mjs';
import { listSourceFiles, isSourcePath } from './source_files.mjs';

/** How many near-misses a `not-found` carries. */
export const SUGGESTION_CAP = 8;

/** True when `abs` is `root` itself or lives under it. */
function insideRoot(root, abs) {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Substring near-misses over the known file list. */
function suggest(files, target) {
  const needle = String(target).toLowerCase();
  return files.filter((p) => p.toLowerCase().includes(needle)).slice(0, SUGGESTION_CAP);
}

/**
 * Resolve `target` against `repoRoot`.
 *
 * @param {string} repoRoot absolute repo root.
 * @param {string} target repo-relative path, path suffix or basename.
 * @param {{files?: string[], ignoreFile?: string}} [opts] `files` skips the disk scan.
 * @returns {{kind: 'file', path: string}
 *   | {kind: 'unsupported', target: string, path: string}
 *   | {kind: 'ambiguous', target: string, total: number, candidates: string[]}
 *   | {kind: 'not-found', target: string, candidates: string[]}}
 */
export function resolveFileTarget(repoRoot, target, { files, ignoreFile } = {}) {
  if (typeof target !== 'string' || target.trim().length === 0) {
    return { kind: 'not-found', target: target ?? null, candidates: [] };
  }
  const root = resolve(repoRoot);
  const rel = normPosix(target).replace(/^\.\//, '');

  const abs = resolve(root, rel);
  if (insideRoot(root, abs) && existsSync(abs) && statSync(abs).isFile()) {
    const path = normPosix(abs.slice(root.length + 1));
    return isSourcePath(path) ? { kind: 'file', path } : { kind: 'unsupported', target, path };
  }

  const known = files ?? listSourceFiles(root, ignoreFile ? { ignoreFile } : undefined);
  const { matches } = resolveFilePath(known, rel);
  if (matches.length === 1) return { kind: 'file', path: matches[0] };
  if (matches.length > 1) {
    return { kind: 'ambiguous', target, total: matches.length, candidates: matches };
  }
  return { kind: 'not-found', target, candidates: suggest(known, rel) };
}

/**
 * Read a repo-relative file. Returns null when it is missing, unreadable or
 * outside the repo root.
 */
export function readRepoFile(repoRoot, relPath) {
  const root = resolve(repoRoot);
  const abs = resolve(root, relPath);
  if (!insideRoot(root, abs)) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
