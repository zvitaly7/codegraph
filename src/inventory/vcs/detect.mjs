import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectGitMetadata } from './git.mjs';

/** @returns {'git'|'none'} */
export function detectVcs(repoRoot) {
  return existsSync(join(repoRoot, '.git')) ? 'git' : 'none';
}

function noneMetadata() {
  return {
    type: 'none', available: false, root: null, branch: null,
    revision: 'no-revision', hasLocalChanges: null, warnings: [],
  };
}

/**
 * @param {string} repoRoot
 * @param {'auto'|'git'|'none'|'arc'} [mode='auto']
 * Arc support is a later optional add — for now anything that isn't git
 * (after resolving 'auto') yields the 'none' shape.
 */
export function collectVcsMetadata(repoRoot, mode = 'auto') {
  const resolved = mode === 'auto' ? detectVcs(repoRoot) : mode;
  if (resolved === 'git') return collectGitMetadata(repoRoot);
  return noneMetadata();
}
