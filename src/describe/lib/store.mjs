// The description cache: `<cache>/descriptions/{domains,files,symbols}.jsonl`.
//
// One row per described target:
//   { targetId, kind, contentHash, text, model, provider, generatedAt }
//
// `contentHash` is what makes re-runs cheap AND correct: it is the hash of the
// material the description was generated FROM (see ../lib/targets.mjs). A row
// whose `contentHash` still matches the target's current hash is reused; one
// that no longer matches is re-described. Nothing else is ever re-spent on.
//
// Every row carries `model` + `provider` + `generatedAt` because a description
// is GENERATED TEXT, not a fact the graph proved. Those three fields travel with
// the text everywhere it surfaces, so no consumer can present it as proven.
//
// Rows live in one file per kind so `--scope domains` never rewrites the file
// `--scope symbols` owns.

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonlAtomic } from '../../inventory/write.mjs';

/** Subdirectory of the graph cache that holds the JSONL files. */
export const DESCRIPTIONS_DIR = 'descriptions';

/** The three describable kinds, in `--scope all` order. */
export const KINDS = ['domain', 'file', 'symbol'];

/** `domain` → `domains.jsonl`. */
export function fileForKind(kind) {
  return `${kind}s.jsonl`;
}

/** Absolute path of the JSONL file holding one kind's rows. */
export function pathForKind(cacheDir, kind) {
  return join(cacheDir, DESCRIPTIONS_DIR, fileForKind(kind));
}

/** A row is usable only when it carries everything a labelled consumer needs. */
function isUsableRow(row) {
  return row
    && typeof row.targetId === 'string' && row.targetId.length > 0
    && typeof row.text === 'string' && row.text.length > 0
    && typeof row.contentHash === 'string';
}

function readRows(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const row = JSON.parse(line);
      if (isUsableRow(row)) out.push(row);
    } catch {
      // A corrupt line loses one description, never the whole cache.
    }
  }
  return out;
}

/**
 * Read every cached description under `cacheDir`.
 *
 * Never throws: a missing directory, a missing file or a corrupt line yields
 * fewer descriptions, not an error — a consumer that cannot read them should
 * simply show none.
 *
 * @param {string} cacheDir the graph cache directory.
 * @param {{kinds?: string[]}} [opts] restrict which kind files are read.
 * @returns {{size: number, get: (id: string) => object|undefined, all: () => object[], byKind: (kind: string) => object[]}}
 */
export function loadDescriptions(cacheDir, { kinds = KINDS } = {}) {
  const byId = new Map();
  if (typeof cacheDir === 'string' && cacheDir.length > 0) {
    for (const kind of kinds) {
      for (const row of readRows(pathForKind(cacheDir, kind))) {
        byId.set(row.targetId, { kind, ...row });
      }
    }
  }
  return {
    size: byId.size,
    get: (id) => byId.get(id),
    all: () => [...byId.values()],
    byKind: (kind) => [...byId.values()].filter((r) => r.kind === kind),
  };
}

/**
 * Merge freshly generated rows over what is already on disk and write one kind's
 * file back, atomically.
 *
 * @param {string} cacheDir graph cache directory.
 * @param {string} kind `domain` | `file` | `symbol`.
 * @param {object[]} rows the rows generated in this run.
 * @param {{keepIds?: Set<string>}} [opts] when given, existing rows whose
 *   `targetId` is NOT in the set are dropped — that is how a description for a
 *   file that no longer exists stops being carried forever. Omit it to keep
 *   every existing row.
 * @returns {{path: string, written: number, pruned: number}}
 */
export function writeDescriptions(cacheDir, kind, rows, { keepIds } = {}) {
  const path = pathForKind(cacheDir, kind);
  const merged = new Map();
  let pruned = 0;
  for (const row of readRows(path)) {
    if (keepIds && !keepIds.has(row.targetId)) {
      pruned += 1;
      continue;
    }
    merged.set(row.targetId, row);
  }
  for (const row of rows) {
    if (isUsableRow(row)) merged.set(row.targetId, row);
  }
  // Sorted by id so two runs that generated the same descriptions produce a
  // byte-identical file.
  const sorted = [...merged.values()].sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0));
  writeJsonlAtomic(path, sorted);
  return { path, written: sorted.length, pruned };
}

/**
 * Is `target` already described, by the exact material it would be described
 * from now?
 * @returns {boolean} true → reuse the cached row, spend nothing.
 */
export function isFresh(row, target) {
  return Boolean(row) && row.contentHash === target?.contentHash;
}

/**
 * The one label every consumer prints. Never render a description without it —
 * a generated sentence that reads like a proven fact is the failure mode this
 * whole layer is designed to avoid.
 * @returns {string} e.g. `generated by claude-opus-5 via anthropic, 2026-08-17`
 */
export function generatedLabel(row) {
  const model = row?.model || 'unspecified model';
  const provider = row?.provider || 'unknown provider';
  const when = typeof row?.generatedAt === 'string' ? row.generatedAt.slice(0, 10) : null;
  return `generated by ${model} via ${provider}${when ? `, ${when}` : ''}`;
}
