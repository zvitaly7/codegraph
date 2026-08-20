// Filesystem containment for every semantic source read. Lexical `..` checks
// are not enough: a path can sit under repoRoot while a symlink redirects its
// bytes elsewhere. File symlinks are intentionally rejected altogether; the
// inventory may still catalogue the link itself as metadata.

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Absolute lexical path for a real regular file contained by repoRoot. */
export function safeRepoFilePath(repoRoot, relPath) {
  try {
    const root = resolve(repoRoot);
    const abs = resolve(root, relPath);
    if (!inside(root, abs)) return null;

    // Reject the final component when it is a link, even if its current target
    // happens to be internal. That keeps reads deterministic if the link moves.
    if (lstatSync(abs).isSymbolicLink()) return null;

    const realRoot = realpathSync(root);
    const realAbs = realpathSync(abs);
    if (!inside(realRoot, realAbs) || !statSync(realAbs).isFile()) return null;
    return abs;
  } catch {
    return null;
  }
}
