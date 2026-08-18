import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectGitMetadata } from './git.mjs';

/** @returns {'git'|'none'} */
export function detectVcs(repoRoot) {
  // Fast path: repoRoot is itself the top of a checkout.
  if (existsSync(join(repoRoot, '.git'))) return 'git';
  // repoRoot may sit *inside* a checkout — a service directory in a large
  // monorepo, or one package of a workspace. Only the top level carries a
  // `.git`, so guessing from its presence silently drops the revision (and
  // with it staleness detection and incremental rebuilds) for those repos.
  // git resolves this by walking up, so ask git instead of guessing.
  return collectGitMetadata(repoRoot).available ? 'git' : 'none';
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
  if (mode === 'git') return collectGitMetadata(repoRoot);
  if (mode !== 'auto') return noneMetadata();
  // auto: collect once and reuse, rather than detecting and collecting again.
  const git = collectGitMetadata(repoRoot);
  return git.available ? git : noneMetadata();
}
