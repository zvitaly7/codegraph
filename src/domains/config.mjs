// Resolve the domains overlay config for a run. Three sources, in priority:
//   1. cfg.domains is an object → use it directly (mode 'config').
//   2. cfg.domains is a string  → dynamic-import resolve(repoRoot, cfg.domains)
//      and read its three tables (named or default export) (mode 'config').
//   3. otherwise                → auto-derive from the file list (mode 'derived').
//
// The loaded tables are normalized and validated: `unassigned` (infra) is always
// present, and every ALIASES / AREA_BUCKETS target must be a known canonical
// domain — unknown targets are warned about and coerced to `unassigned`.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveDomainsConfig } from './derive.mjs';

/** Normalize CANONICAL_DOMAINS to `{ <id>: { kind } }`, accepting a few shapes. */
function normalizeCanonical(input) {
  const out = {};
  if (Array.isArray(input)) {
    for (const id of input) out[id] = { kind: 'product' };
  } else if (input && typeof input === 'object') {
    for (const [id, val] of Object.entries(input)) {
      if (val && typeof val === 'object') out[id] = { kind: val.kind ?? 'product' };
      else if (typeof val === 'string') out[id] = { kind: val };
      else out[id] = { kind: 'product' };
    }
  }
  if (!out.unassigned) out.unassigned = { kind: 'infra' };
  const sorted = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key];
  return sorted;
}

function validateAliases(aliases, canonical) {
  const out = {};
  for (const [key, target] of Object.entries(aliases ?? {})) {
    const k = String(key).toLowerCase();
    if (Object.hasOwn(canonical, target)) {
      out[k] = target;
    } else {
      console.warn(`domains: alias '${k}' targets unknown domain '${target}', coercing to 'unassigned'`);
      out[k] = 'unassigned';
    }
  }
  const sorted = {};
  for (const key of Object.keys(out).sort()) sorted[key] = out[key];
  return sorted;
}

function validateBuckets(buckets, canonical) {
  return (buckets ?? []).map(([prefix, target]) => {
    if (Object.hasOwn(canonical, target)) return [prefix, target];
    console.warn(`domains: area bucket '${prefix}' targets unknown domain '${target}', coercing to 'unassigned'`);
    return [prefix, 'unassigned'];
  });
}

function pickTables(mod) {
  const src = (mod?.CANONICAL_DOMAINS || mod?.ALIASES || mod?.AREA_BUCKETS) ? mod : (mod?.default ?? mod);
  return {
    CANONICAL_DOMAINS: src?.CANONICAL_DOMAINS,
    ALIASES: src?.ALIASES,
    AREA_BUCKETS: src?.AREA_BUCKETS,
  };
}

/**
 * @param {object} args
 * @param {{domains?: object|string|null, srcRoots?: string[]}} args.cfg
 * @param {string} args.repoRoot absolute repo root (for resolving a string path).
 * @param {string[]} args.relPaths repo-relative file paths (for derived mode).
 * @returns {Promise<{mode:'derived'|'config', CANONICAL_DOMAINS:object, ALIASES:object, AREA_BUCKETS:Array<[string,string]>}>}
 */
export async function loadDomainsConfig({ cfg, repoRoot, relPaths }) {
  const srcRoots = cfg?.srcRoots ?? ['src'];
  const domains = cfg?.domains;

  let mode;
  let raw;
  if (domains && typeof domains === 'object') {
    mode = 'config';
    raw = pickTables(domains);
  } else if (typeof domains === 'string') {
    mode = 'config';
    const abs = resolve(repoRoot, domains);
    const mod = await import(pathToFileURL(abs).href);
    raw = pickTables(mod);
  } else {
    mode = 'derived';
    raw = deriveDomainsConfig(relPaths, { srcRoots });
  }

  const CANONICAL_DOMAINS = normalizeCanonical(raw.CANONICAL_DOMAINS);
  const ALIASES = validateAliases(raw.ALIASES, CANONICAL_DOMAINS);
  const AREA_BUCKETS = validateBuckets(raw.AREA_BUCKETS, CANONICAL_DOMAINS);

  return { mode, CANONICAL_DOMAINS, ALIASES, AREA_BUCKETS };
}
