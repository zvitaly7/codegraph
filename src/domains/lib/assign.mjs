// Assign a single repo-relative file path to a canonical domain id, using the
// resolved domains config. Precedence is fixed and deterministic:
//   (a) file under a src root      → first segment via ALIASES, else soft kebab
//   (b) first matching AREA_BUCKET → its domain id (segment-safe prefix match)
//   (c) otherwise                  → 'unassigned'

import { normPosix } from '../../inventory/schema.mjs';
import { kebab, segmentAfterSrcRoot } from '../derive.mjs';

/**
 * @param {string} relPath repo-relative POSIX path.
 * @param {{ALIASES: object, AREA_BUCKETS: Array<[string,string]>}} domainsConfig
 * @param {{srcRoots?: string[]}} [opts]
 * @returns {string} canonical domain id.
 */
export function assignDomain(relPath, domainsConfig, { srcRoots = ['src'] } = {}) {
  const p = normPosix(relPath);
  const { ALIASES = {}, AREA_BUCKETS = [] } = domainsConfig;

  // (a) Under a src root: alias lookup wins, else a soft kebab-derived id.
  const seg = segmentAfterSrcRoot(p, srcRoots);
  if (seg !== null) {
    return ALIASES[seg.toLowerCase()] ?? kebab(seg);
  }

  // (b) First area bucket whose prefix matches on a path-segment boundary.
  for (const [prefix, domainId] of AREA_BUCKETS) {
    const pre = normPosix(prefix).replace(/\/+$/, '');
    if (p === pre || p.startsWith(`${pre}/`)) return domainId;
  }

  // (c) Catch-all.
  return 'unassigned';
}
