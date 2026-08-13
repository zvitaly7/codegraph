// Zero-config auto-derivation of the domains overlay tables from a repo's file
// list. Product domains come from the first path segment under a src root;
// infra "area buckets" come from every other top-level directory; a catch-all
// `unassigned` infra domain is always present. Output is fully sorted so the
// same file list always yields byte-identical tables.
//
// Three tables are produced (the same shape a user override supplies):
//   CANONICAL_DOMAINS : { <id>: { kind: 'product' | 'infra' } }
//   ALIASES           : { <lowercased path segment>: <canonical id> }
//   AREA_BUCKETS      : [ [pathPrefix, domainId], ... ]  (ordered)

import { normPosix } from '../inventory/schema.mjs';

/**
 * Turn a raw path segment into a canonical, url-safe domain id:
 *   camelCase / PascalCase boundaries become dashes, separators collapse to a
 *   single dash, everything lowercases. Degenerate input → 'unassigned'.
 */
export function kebab(segment) {
  const out = String(segment ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'unassigned';
}

/**
 * Given a repo-relative path, return the first path segment that sits directly
 * under one of `srcRoots`, or null if the path is not under a src root (or is a
 * src root directory itself). Longer roots are matched first so nested roots
 * (e.g. 'app/src') win over shorter ones.
 */
export function segmentAfterSrcRoot(relPath, srcRoots = ['src']) {
  const p = normPosix(relPath);
  const roots = srcRoots.map(normPosix).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (p === root) continue; // the src root directory itself — nothing under it
    if (p.startsWith(`${root}/`)) {
      const first = p.slice(root.length + 1).split('/')[0];
      if (first.length > 0) return first;
    }
  }
  return null;
}

function sortedObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/**
 * @param {string[]} relPaths repo-relative POSIX file paths.
 * @param {{srcRoots?: string[]}} [opts]
 * @returns {{CANONICAL_DOMAINS: object, ALIASES: object, AREA_BUCKETS: Array<[string,string]>}}
 */
export function deriveDomainsConfig(relPaths, { srcRoots = ['src'] } = {}) {
  const canonical = {}; // id -> { kind }
  const aliases = {};   // lowercased segment -> canonical id
  const buckets = new Map(); // pathPrefix -> domainId

  for (const raw of relPaths) {
    const p = normPosix(raw);
    const seg = segmentAfterSrcRoot(p, srcRoots);
    if (seg !== null) {
      const id = kebab(seg);
      canonical[id] = { kind: 'product' };
      aliases[seg.toLowerCase()] = id;
      continue;
    }
    const parts = p.split('/');
    if (parts.length > 1) {
      // A file inside a top-level directory that is not a src root → infra area.
      const topDir = parts[0];
      const id = kebab(topDir);
      canonical[id] = { kind: 'infra' };
      buckets.set(topDir, id);
    }
    // Otherwise a bare top-level file → falls through to `unassigned` at assign time.
  }

  canonical.unassigned = { kind: 'infra' };

  const AREA_BUCKETS = [...buckets.entries()]
    .map(([prefix, domainId]) => [prefix, domainId])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    CANONICAL_DOMAINS: sortedObject(canonical),
    ALIASES: sortedObject(aliases),
    AREA_BUCKETS,
  };
}
