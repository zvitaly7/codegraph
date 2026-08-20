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
import { hasRelevantLocalChanges } from '../inventory/vcs/git.mjs';
import { readBuildStamp } from './build_context.mjs';

const LAYER_ARTIFACTS = {
  inventory: [
    ['inventory', 'manifest.json'], ['inventory', 'nodes.jsonl'],
    ['inventory', 'edges.jsonl'], ['inventory', 'files.jsonl'],
  ],
  imports: [
    ['imports', 'manifest.json'], ['imports', 'nodes.jsonl'], ['imports', 'edges.jsonl'],
  ],
  symbols: [
    ['symbols', 'manifest.json'], ['symbols', 'nodes.jsonl'], ['symbols', 'edges.jsonl'],
  ],
  domains: [
    ['domains', 'manifest.json'], ['domains', 'nodes.jsonl'], ['domains', 'edges.jsonl'],
  ],
  references: [
    ['references', 'manifest.json'], ['references', 'nodes.jsonl'], ['references', 'edges.jsonl'],
  ],
  usages: [
    ['usages', 'manifest.json'], ['usages', 'nodes.jsonl'], ['usages', 'edges.jsonl'],
  ],
  explorer: [['explorer', 'graph-index.json'], ['explorer', 'index.html']],
};

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
export function checkStaleness(cacheDir, { requiredLayers = [], contextHash = null } = {}) {
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

  // A revision match is insufficient when this particular command needs
  // artifacts a prior light/partial run never produced.
  const missingArtifacts = [];
  for (const layer of requiredLayers) {
    for (const parts of LAYER_ARTIFACTS[layer] ?? []) {
      if (!existsSync(join(cacheDir, ...parts))) missingArtifacts.push(parts.join('/'));
    }
  }
  if (missingArtifacts.length > 0) {
    return {
      hasCache: true, stale: true, reason: 'incomplete-cache',
      cacheRevision, currentRevision: null, missingArtifacts,
    };
  }

  // Every downstream layer must describe the same inventory snapshot. This
  // catches a light rebuild at a new revision leaving old heavy artifacts in
  // place, even though all expected files still exist.
  const mismatchedLayers = [];
  for (const layer of requiredLayers) {
    if (layer === 'inventory') continue;
    try {
      const artifact = layer === 'explorer'
        ? JSON.parse(readFileSync(join(cacheDir, 'explorer', 'graph-index.json'), 'utf8'))
        : JSON.parse(readFileSync(join(cacheDir, layer, 'manifest.json'), 'utf8'));
      const snapshot = layer === 'explorer' ? artifact?.meta?.snapshot : artifact?.basedOnSnapshot;
      if (snapshot !== manifest?.snapshotId) mismatchedLayers.push(layer);
    } catch {
      mismatchedLayers.push(layer);
    }
  }
  if (mismatchedLayers.length > 0) {
    return {
      hasCache: true, stale: true, reason: 'layer-snapshot-mismatch',
      cacheRevision, currentRevision: null, mismatchedLayers,
    };
  }

  // The orchestrator's stamp is deliberately per-layer: a light rebuild may
  // preserve heavy artifacts, but only when they were built with this exact
  // effective graph config and tool version.
  const stamp = readBuildStamp(cacheDir);
  if (stamp && !stamp.complete) {
    return {
      hasCache: true, stale: true, reason: 'build-incomplete',
      cacheRevision, currentRevision: null,
    };
  }
  if (contextHash) {
    if (!stamp) {
      return {
        hasCache: true, stale: true, reason: 'build-context-missing',
        cacheRevision, currentRevision: null,
      };
    }
    const contextMismatches = requiredLayers.filter(
      (layer) => stamp.layerContexts?.[layer] !== contextHash,
    );
    if (contextMismatches.length > 0) {
      return {
        hasCache: true, stale: true, reason: 'build-context-changed',
        cacheRevision, currentRevision: null, mismatchedLayers: contextMismatches,
      };
    }
  }

  // --- Resolve the repo's current revision (guarded) ---------------------
  let currentRevision = null;
  let hasLocalChanges = null;
  try {
    const current = collectVcsMetadata(repoRoot, 'auto');
    currentRevision = current?.revision ?? null;
    hasLocalChanges = current?.hasLocalChanges === true
      ? hasRelevantLocalChanges(repoRoot, [cacheDir])
      : current?.hasLocalChanges ?? null;
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
  if (stale) {
    return {
      hasCache: true, stale: true, cacheRevision, currentRevision,
      reason: 'revision-changed',
    };
  }

  // HEAD does not move for uncommitted edits. Check this after the revision so
  // callers that explain an older committed snapshot keep the more precise
  // `revision-changed` reason when both conditions are true.
  if (hasLocalChanges === true) {
    return {
      hasCache: true, stale: true, reason: 'working-tree-changed',
      cacheRevision, currentRevision,
    };
  }

  return {
    hasCache: true,
    stale: false,
    cacheRevision,
    currentRevision,
    reason: 'up-to-date',
  };
}
