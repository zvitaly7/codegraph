// Shared machinery for the incremental references/usages engine.
//
// The heavy layers type-check the whole repo. Incremental mode avoids re-walking
// files whose extracted edges cannot have changed, then MERGES fresh edges for
// the ones that could have — and the result MUST be byte-identical to a full
// rebuild (identity is the primary correctness gate; speed is secondary).
//
// The correctness pivot is the AFFECTED SET. A reference/usage edge originates
// in a file but resolves to symbols declared in the files it imports, so
// changing a declaration file B can change the edges of any file that imports B.
// Therefore the set of files whose edges might change is:
//
//     affected = changed  ∪  { files that (transitively) import a changed file }
//
// Everything outside `affected` keeps its cached edges verbatim (after a symbol
// membership filter that self-heals references to symbols that no longer exist —
// e.g. when a declaration file is deleted). Everything inside `affected` is
// re-extracted against a WHOLE-REPO program, so its resolution is identical to a
// full build. Widening `affected` only costs speed, never correctness.
//
// These are small, pure-ish helpers; the per-layer orchestration lives in each
// layer's run.mjs, and the end-to-end identity is proven by the equality-gate
// tests.

import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { readRepoFile } from './file_target.mjs';
import { safeRepoFilePath } from './repo_path.mjs';

/** `file:src/a.ts` → `src/a.ts` (or null if it is not a file id). */
function stripFilePrefix(id) {
  return typeof id === 'string' && id.startsWith('file:') ? id.slice('file:'.length) : null;
}

/** The declaring path of a Symbol id `sym:<path>#<name>` → `<path>`. */
export function symIdPath(symId) {
  const body = symId.slice('sym:'.length);
  const hash = body.lastIndexOf('#');
  return hash === -1 ? body : body.slice(0, hash);
}

/**
 * The revision an artifact was built from, parsed out of its manifest's
 * `basedOnSnapshot` (`snapshot:<name>:<rev>`). Returns null when it is absent,
 * 'unknown', or the no-revision sentinel — in which case the caller must fall
 * back to a full rebuild.
 */
export function revisionOfArtifactManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const snap = manifest?.basedOnSnapshot;
  if (typeof snap === 'string' && snap !== 'unknown') {
    const i = snap.lastIndexOf(':');
    if (i !== -1) {
      const rev = snap.slice(i + 1);
      if (rev && rev !== 'no-revision') return rev;
    }
  }
  return null;
}

/**
 * Reverse the IMPORTS graph: map each imported file to the set of files that
 * import it (internal file→file edges only). Reads `<cache>/imports/edges.jsonl`.
 * Missing/unreadable → an empty index (caller then sees every changed file as
 * having no importers, which is still safe — it just re-extracts fewer files).
 *
 * @returns {Map<string, Set<string>>} importedPath → Set(importerPath), POSIX.
 */
export function loadImportersIndex(importsEdgesPath) {
  const index = new Map();
  let text;
  try {
    text = readFileSync(importsEdgesPath, 'utf8');
  } catch {
    return index;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'IMPORTS' || e.properties?.kind !== 'internal') continue;
    const from = stripFilePrefix(e.from);
    const to = stripFilePrefix(e.to);
    if (!from || !to) continue;
    if (!index.has(to)) index.set(to, new Set());
    index.get(to).add(from);
  }
  return index;
}

/**
 * affected = changed ∪ (transitive importers of changed), via the reverse-import
 * index. A superset of every file whose extracted edges could differ.
 *
 * @param {Iterable<string>} changed POSIX paths.
 * @param {Map<string, Set<string>>} importersIndex from loadImportersIndex.
 * @returns {Set<string>}
 */
export function computeAffectedFiles(changed, importersIndex) {
  const affected = new Set(changed);
  const queue = [...affected];
  while (queue.length > 0) {
    const cur = queue.pop();
    const importers = importersIndex.get(cur);
    if (!importers) continue;
    for (const importer of importers) {
      if (!affected.has(importer)) {
        affected.add(importer);
        queue.push(importer);
      }
    }
  }
  return affected;
}

// Text signatures of GLOBAL injection: an ambient global augmentation or a UMD
// global. Files matching these can change the edges of files that DON'T import
// them, which the import-based affected set cannot capture — so a change to such
// a file forces a full rebuild.
const GLOBAL_INJECTION_RE = /\bdeclare\s+global\b|\bexport\s+as\s+namespace\b/;

/**
 * True when any changed file could inject globals (so incremental cannot
 * guarantee identity and the caller must fall back to full). Conservative:
 *   - any `.d.ts` in the change set (ambient by nature), or
 *   - any readable changed file whose text declares a global / UMD namespace.
 * Deleted files can only be judged by extension (they are gone). This closes the
 * common global-injection cases; ordinary module code never trips it.
 */
export function changedFilesRiskGlobals({ added = [], modified = [], deleted = [], repoRoot }) {
  for (const p of [...added, ...modified, ...deleted]) {
    if (p.endsWith('.d.ts')) return true;
  }
  for (const p of [...added, ...modified]) {
    const text = readRepoFile(repoRoot, p);
    if (text !== null && GLOBAL_INJECTION_RE.test(text)) return true;
  }
  return false;
}

/**
 * Build a whole-repo TypeScript program with persisted incremental state, so a
 * later run reuses unchanged files' parse/bind/check via `<cache>/.tsbuildinfo`.
 * `noEmit` keeps it from writing any JS/DTS; `emit()` still persists the build
 * info. Resolution is identical to `ts.createProgram` (verified by the equality
 * gate), so records walked against it match a full build exactly.
 *
 * @returns {import('typescript').Program}
 */
export function buildIncrementalProgram({ rootNames, options, tsBuildInfoFile }) {
  const opts = { ...options, incremental: true, tsBuildInfoFile, noEmit: true };
  const builder = ts.createIncrementalProgram({ rootNames: [...rootNames].sort(), options: opts });
  try {
    builder.emit(); // persist .tsbuildinfo (no JS emitted under noEmit)
  } catch {
    // Persisting build info is best-effort; the program is still usable.
  }
  return builder.getProgram();
}

/**
 * Map affected POSIX paths to absolute paths that actually exist and are part of
 * the current source set — the files to WALK. Deleted/absent affected files fall
 * away here (their cached edges are dropped by the caller instead).
 *
 * @param {Set<string>} affected POSIX paths.
 * @param {Set<string>} currentSourcePaths POSIX paths in the current inventory.
 * @param {string} repoRoot
 * @returns {string[]} sorted absolute paths.
 */
export function affectedFilesToWalk(affected, currentSourcePaths, repoRoot) {
  const out = [];
  for (const p of affected) {
    if (!currentSourcePaths.has(p)) continue;
    const abs = safeRepoFilePath(repoRoot, p);
    if (abs) out.push(abs);
  }
  return out.sort();
}
