import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

const TIMEOUT = 15000;

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', timeout: TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** @returns {{type:'git',available:boolean,root:string|null,branch:string|null,revision:string,hasLocalChanges:boolean|null,error?:string,warnings:string[]}} */
export function collectGitMetadata(repoRoot) {
  const meta = {
    type: 'git', available: false, root: null, branch: null,
    revision: 'no-revision', hasLocalChanges: null, warnings: [],
  };
  try {
    meta.root = git(repoRoot, ['rev-parse', '--show-toplevel']) || null;
    meta.available = true;
  } catch {
    meta.error = 'git not available or not a repository';
    return meta;
  }
  try {
    const b = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    meta.branch = b === 'HEAD' ? null : b; // detached
  } catch (e) { meta.warnings.push(`git branch failed: ${e.message}`); }
  try {
    meta.revision = git(repoRoot, ['rev-parse', 'HEAD']) || 'no-revision';
  } catch { meta.revision = 'no-revision'; meta.warnings.push('git rev-parse HEAD failed'); }
  try {
    meta.hasLocalChanges = git(repoRoot, ['status', '--porcelain']).length > 0;
  } catch (e) { meta.warnings.push(`git status failed: ${e.message}`); }
  return meta;
}

/**
 * Whether tracked/untracked changes remain after excluding generated paths.
 * Exclusions use top-anchored git pathspecs, so this also works when repoRoot is
 * a subdirectory of a larger checkout. Failure is conservatively "changed".
 */
export function hasRelevantLocalChanges(repoRoot, ignoredAbsPaths = []) {
  try {
    const reportedRoot = git(repoRoot, ['rev-parse', '--show-toplevel']);
    let root;
    try { root = realpathSync(reportedRoot); } catch { root = reportedRoot; }
    const args = ['status', '--porcelain', '--untracked-files=all', '--', '.'];
    for (const abs of ignoredAbsPaths) {
      let realAbs;
      try { realAbs = realpathSync(abs); } catch { realAbs = abs; }
      const rel = relative(root, realAbs).replaceAll('\\', '/');
      if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue;
      args.push(`:(top,exclude)${rel}`, `:(top,exclude)${rel}/**`);
    }
    return git(repoRoot, args).length > 0;
  } catch {
    return true;
  }
}
