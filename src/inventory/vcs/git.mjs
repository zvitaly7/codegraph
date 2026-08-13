import { execFileSync } from 'node:child_process';

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
