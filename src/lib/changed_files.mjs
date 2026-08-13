// Which source files changed since a prior snapshot — the input the incremental
// engine uses to decide what to re-extract.
//
// We ask git two questions and union the answers:
//   * `git diff --name-status <sinceRevision>` — every TRACKED file that differs
//     between the snapshot commit and the CURRENT working tree. That already
//     folds together commits made since the snapshot AND uncommitted edits /
//     deletions to tracked files (git diffs the commit against the files on
//     disk, so staged and unstaged both show up).
//   * `git status --porcelain` — used only to pick up UNTRACKED new files (`??`),
//     which a diff against a commit cannot see.
//
// The result is a `{ ok, added, modified, deleted }` set of repo-relative POSIX
// paths. `ok:false` means "cannot decide reliably" (git unavailable, or the
// revision is missing / unknown) and the caller MUST fall back to a full
// rebuild. This function never throws.

import { execFileSync } from 'node:child_process';

const TIMEOUT = 15000;

/** Run git, returning stdout. Throws on non-zero exit or a missing binary. */
function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', timeout: TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A revision with no usable identity (absent, empty, or the sentinel). */
function isMissingRevision(rev) {
  return !rev || rev === 'no-revision';
}

const FAIL = () => ({ ok: false, added: [], modified: [], deleted: [] });

/**
 * @param {string} repoRoot absolute path to the repo.
 * @param {string} sinceRevision the commit the cache was built from.
 * @returns {{ ok: boolean, added: string[], modified: string[], deleted: string[] }}
 *          POSIX repo-relative paths; buckets are disjoint and sorted.
 */
export function changedFilesSince(repoRoot, sinceRevision) {
  if (isMissingRevision(sinceRevision)) return FAIL();

  // Tracked delta vs the snapshot commit. A failure here (git missing, or the
  // revision unknown to this repo) means we cannot decide → fall back to full.
  let diffOut;
  try {
    diffOut = git(repoRoot, [
      '-c', 'core.quotepath=false', 'diff', '--name-status', sinceRevision, '--',
    ]);
  } catch {
    return FAIL();
  }

  // Untracked files (best-effort; if it fails we still have the tracked delta).
  let statusOut = '';
  try {
    statusOut = git(repoRoot, ['-c', 'core.quotepath=false', 'status', '--porcelain']);
  } catch {
    statusOut = '';
  }

  const added = new Set();
  const modified = new Set();
  const deleted = new Set();

  // --- git diff --name-status --------------------------------------------
  // Columns are TAB-separated: `<status>\t<path>` (rename/copy carry two paths:
  // `<status>\t<old>\t<new>`), so paths containing spaces stay intact.
  for (const line of diffOut.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const code = cols[0];
    if (code.startsWith('R')) {          // rename: old is gone, new appears
      if (cols[1]) deleted.add(cols[1]);
      if (cols[2]) added.add(cols[2]);
    } else if (code.startsWith('C')) {   // copy: only the new path is added
      if (cols[2]) added.add(cols[2]);
    } else if (code === 'A') {
      added.add(cols[1]);
    } else if (code === 'D') {
      deleted.add(cols[1]);
    } else {                             // M, T (type change), U (unmerged), …
      modified.add(cols[1]);
    }
  }

  // --- git status --porcelain (untracked only) ---------------------------
  // Format: `XY <path>`. `??` marks an untracked file; other states are already
  // covered by the diff above.
  for (const line of statusOut.split('\n')) {
    if (line.startsWith('??')) added.add(line.slice(3));
  }

  // Reconcile so the buckets are disjoint: a re-added path counts as added, and
  // a path can never be both modified and deleted.
  for (const p of added) { deleted.delete(p); modified.delete(p); }
  for (const p of deleted) { modified.delete(p); }

  const sorted = (s) => [...s].sort();
  return {
    ok: true,
    added: sorted(added),
    modified: sorted(modified),
    deleted: sorted(deleted),
  };
}
