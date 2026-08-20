// A successful `regenerate` records which graph layers were built with which
// effective configuration. Git revision alone cannot answer freshness: config
// may live outside the repo, a prior run may have skipped layers, and a failed
// run may have left a partial cache behind.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../inventory/write.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const TOOL_VERSION = pkg.version;
export const BUILD_STAMP_PATH = ['regenerate', 'manifest.json'];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = stable(value[key]);
    }
    return out;
  }
  return value;
}

/** Hash only configuration that can change graph artifacts. */
export function buildContextHash(cfg) {
  const ignored = new Set([
    'repoRoot', 'outDir', 'incremental', 'compressPaths', '_flags', '_positionals',
  ]);
  const graphConfig = {};
  for (const key of Object.keys(cfg).sort()) {
    if (!ignored.has(key)) graphConfig[key] = cfg[key];
  }
  return createHash('sha256')
    .update(JSON.stringify(stable({ toolVersion: TOOL_VERSION, graphConfig })))
    .digest('hex');
}

/** Guarded read: old caches and interrupted writes simply have no usable stamp. */
export function readBuildStamp(cacheDir) {
  try {
    return JSON.parse(readFileSync(join(cacheDir, ...BUILD_STAMP_PATH), 'utf8'));
  } catch {
    return null;
  }
}

export function writeBuildStamp(cacheDir, stamp) {
  writeJsonAtomic(join(cacheDir, ...BUILD_STAMP_PATH), stamp);
}
