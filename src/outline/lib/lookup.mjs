// The I/O half of `outline`: resolve a file argument, read it, parse it.
//
// Split out so the CLI and the MCP tool run the SAME steps — the pure parser
// lives in ./outline.mjs and never touches the filesystem.

import { resolveFileTarget, readRepoFile } from '../../lib/file_target.mjs';
import { buildOutline, DEFAULT_LIMIT } from './outline.mjs';

/**
 * Outline the file `target` names.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot absolute repo root.
 * @param {string} opts.target repo-relative path or path suffix.
 * @param {number} [opts.limit] cap for the declaration / member lists.
 * @param {string} [opts.ignoreFile] ignore file to honour while scanning.
 * @returns {object} an `outline`, or an `ambiguous` / `not-found` /
 *   `unsupported` / `unreadable` payload — all of them answers, not failures.
 */
export function outlineTarget({ repoRoot, target, limit = DEFAULT_LIMIT, ignoreFile } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return { kind: 'not-found', target: target ?? null, error: 'no repo root to resolve against', candidates: [] };
  }
  const found = resolveFileTarget(repoRoot, target, ignoreFile ? { ignoreFile } : undefined);
  if (found.kind !== 'file') return { ...found, target };

  const text = readRepoFile(repoRoot, found.path);
  if (text === null) return { kind: 'unreadable', target, path: found.path };

  return buildOutline(found.path, text, { limit });
}
