// Decide whether a graph cache is older than the code it was built from.
//
// Each cache records, in its inventory manifest, the VCS revision of the
// snapshot it was built against. `checkStaleness` compares that recorded
// revision with the repo's CURRENT revision and reports one of four states:
//
//   no-cache         — no readable manifest (nothing has been built yet).
//   up-to-date       — recorded revision == current revision.
//   revision-changed — recorded revision != current revision (STALE).
//   vcs-unknown      — either revision is unknown / VCS unavailable, so
//                      staleness cannot be decided (this is NOT an error).
//
// The check is a pure decision over guarded I/O: it reads a file and shells
// out to git (via collectVcsMetadata), but never throws — any failure degrades
// to no-cache or vcs-unknown so callers can treat the result as data.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectVcsMetadata } from '../inventory/vcs/detect.mjs';

/** A revision that carries no usable identity (absent, empty, or the sentinel). */
function isMissingRevision(rev) {
  return !rev || rev === 'no-revision';
}

/**
 * The revision a cache was built from: prefer the manifest's `vcs.revision`,
 * else parse it out of the snapshotId. Snapshot ids are `snapshot:<project>:<rev>`
 * and a git revision never contains a colon, so the revision is whatever follows
 * the LAST colon. Returns null when neither source yields one.
 */
function cacheRevisionOf(manifest) {
  const rev = manifest?.vcs?.revision;
  if (typeof rev === 'string' && rev.length > 0) return rev;
  const snapshotId = manifest?.snapshotId;
  if (typeof snapshotId === 'string') {
    const i = snapshotId.lastIndexOf(':');
    if (i !== -1) return snapshotId.slice(i + 1);
  }
  return null;
}

/**
 * @param {string} cacheDir base cache dir (holds `inventory/manifest.json`).
 * @returns {{
 *   hasCache: boolean,
 *   stale: boolean|null,
 *   reason: 'no-cache'|'up-to-date'|'revision-changed'|'vcs-unknown',
 *   cacheRevision?: string|null,
 *   currentRevision?: string|null,
 * }}
 */
export function checkStaleness(cacheDir) {
  // --- Read the manifest (guarded: missing/corrupt → no-cache) -----------
  let manifest;
  try {
    const manifestPath = join(cacheDir, 'inventory', 'manifest.json');
    if (!existsSync(manifestPath)) {
      return { hasCache: false, stale: true, reason: 'no-cache' };
    }
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    // Unreadable path or invalid JSON — treat as no usable cache.
    return { hasCache: false, stale: true, reason: 'no-cache' };
  }

  const cacheRevision = cacheRevisionOf(manifest);
  const repoRoot = manifest?.repoRoot;

  // --- Resolve the repo's current revision (guarded) ---------------------
  let currentRevision = null;
  try {
    currentRevision = collectVcsMetadata(repoRoot, 'auto')?.revision ?? null;
  } catch {
    // e.g. repoRoot absent → path join throws → treat as VCS-unknown.
    currentRevision = null;
  }

  // --- Decide -------------------------------------------------------------
  if (isMissingRevision(cacheRevision) || isMissingRevision(currentRevision)) {
    return {
      hasCache: true,
      stale: null,
      reason: 'vcs-unknown',
      // Normalize the 'no-revision' sentinel to null for callers/UI.
      cacheRevision: isMissingRevision(cacheRevision) ? null : cacheRevision,
      currentRevision: isMissingRevision(currentRevision) ? null : currentRevision,
    };
  }

  const stale = cacheRevision !== currentRevision;
  return {
    hasCache: true,
    stale,
    cacheRevision,
    currentRevision,
    reason: stale ? 'revision-changed' : 'up-to-date',
  };
}
