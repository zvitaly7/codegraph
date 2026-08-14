// `impact` — PR/branch review context: what does this change touch, and what
// might it break?
//
// `buildImpact(graph, changedPaths, opts)` is PURE. Given the changed files it
// answers, in one compact object:
//   * the changed files grouped by domain (and which paths the graph has never
//     seen — usually a new file, i.e. a hint the cache is behind),
//   * the blast radius: every file that transitively imports a changed one,
//   * the affected domains, ranked by how many impacted files each holds,
//   * the risky public surface: exported symbols of the changed files that some
//     OTHER file references, with reference counts,
//   * the likely tests to run: `kind === 'test'` files that reach the change.
//
// Everything is capped by `limit` (default 10) while the reported counts stay
// untruncated — the caller gets the true size plus a readable sample.

import {
  toFileId, fileIdToPath, domainOfFile, symbolsOfFile, referencingFiles,
  transitiveImporters, capped,
} from '../../lib/graph_query.mjs';

/** Default cap for every list in an impact report. */
export const DEFAULT_LIMIT = 10;

/** Rank descending by `key`, ties broken by name for determinism. */
function byCountThenName(key, nameKey) {
  return (a, b) => b[key] - a[key] || (a[nameKey] < b[nameKey] ? -1 : a[nameKey] > b[nameKey] ? 1 : 0);
}

const EMPTY = {
  changed: { count: 0, files: [], unknown: [], byDomain: [] },
  blastRadius: { count: 0, files: [], depthCapReached: false },
  domains: [],
  riskyExports: { count: 0, list: [] },
  tests: { count: 0, files: [] },
};

/**
 * @param {object} graph a loaded graph (see lib/graph_load.mjs).
 * @param {string[]} changedPaths repo-relative paths (or `file:` ids).
 * @param {{limit?: number, maxDepth?: number, source?: string}} [opts]
 * @returns {object} the structured impact report.
 */
export function buildImpact(graph, changedPaths = [], opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const source = opts.source ?? null;

  const ids = [...new Set((changedPaths ?? []).map(toFileId).filter(Boolean))].sort();
  if (ids.length === 0) {
    return { source, ...EMPTY, note: 'no changed files — nothing to review' };
  }

  const known = ids.filter((id) => graph.nodesById.has(id));
  const unknown = ids.filter((id) => !graph.nodesById.has(id)).map(fileIdToPath);

  // --- changed files, grouped by domain ----------------------------------
  const domainFiles = new Map(); // domain name → paths
  for (const id of known) {
    const name = domainOfFile(graph, id)?.name ?? '(no domain)';
    const list = domainFiles.get(name);
    if (list) list.push(fileIdToPath(id));
    else domainFiles.set(name, [fileIdToPath(id)]);
  }
  const byDomain = [...domainFiles.entries()]
    .map(([domain, files]) => ({ domain, files: files.sort() }))
    .sort((a, b) => b.files.length - a.files.length || (a.domain < b.domain ? -1 : 1));

  // --- blast radius -------------------------------------------------------
  const { byId: radius, depthCapReached } = transitiveImporters(graph, known, { maxDepth: opts.maxDepth });
  const radiusIds = [...radius.keys()].sort();
  const capRadius = capped(radiusIds.map(fileIdToPath), limit);

  // --- affected domains (changed ∪ radius) --------------------------------
  const impactedIds = [...new Set([...known, ...radiusIds])];
  const domainCounts = new Map();
  for (const id of impactedIds) {
    const name = domainOfFile(graph, id)?.name;
    if (!name) continue;
    domainCounts.set(name, (domainCounts.get(name) ?? 0) + 1);
  }
  const domains = [...domainCounts.entries()]
    .map(([domain, files]) => ({ domain, files }))
    .sort(byCountThenName('files', 'domain'))
    .slice(0, limit);

  // --- risky public surface ----------------------------------------------
  // An exported symbol of a changed file that some OTHER file references: change
  // its shape and those call sites break.
  const risky = [];
  for (const id of known) {
    for (const s of symbolsOfFile(graph, id)) {
      if (s.properties?.exported !== true) continue;
      const files = referencingFiles(graph, s.id);
      if (files.length === 0) continue;
      risky.push({
        symbol: s.id,
        name: s.properties?.name,
        kind: s.properties?.kind ?? null,
        path: s.properties?.path ?? fileIdToPath(id),
        line: s.properties?.line ?? null,
        refs: files.length,
        files: files.slice(0, limit),
      });
    }
  }
  risky.sort(byCountThenName('refs', 'symbol'));
  const capRisky = capped(risky, limit);

  // --- likely tests -------------------------------------------------------
  // Tests inside the blast radius, plus any changed file that is itself a test.
  const isTest = (id) => graph.getNode(id)?.properties?.kind === 'test';
  const testIds = [...new Set([...radiusIds, ...known].filter(isTest))].sort();
  const capTests = capped(testIds.map(fileIdToPath), limit);

  return {
    source,
    changed: {
      count: ids.length,
      files: known.map(fileIdToPath).slice(0, limit),
      unknown,
      byDomain,
    },
    blastRadius: { count: capRadius.count, files: capRadius.items, depthCapReached },
    domains,
    riskyExports: { count: capRisky.count, list: capRisky.items },
    tests: { count: capTests.count, files: capTests.items },
  };
}

// ---- formatting ---------------------------------------------------------

/** `a, b, c (+N more)` — or `—` when the list is empty. */
function list(items, total) {
  if (items.length === 0) return '—';
  const more = (total ?? items.length) - items.length;
  return items.join(', ') + (more > 0 ? ` (+${more} more)` : '');
}

/** Render an impact report as compact human-readable text. */
export function formatImpact(r) {
  if (!r) return '';
  const head = `IMPACT  ${r.changed.count} changed file(s)${r.source ? `  (${r.source})` : ''}`;
  if (r.changed.count === 0) return `${head} — ${r.note ?? 'nothing to review'}`;

  const lines = [head];
  if (r.changed.unknown.length > 0) {
    lines.push(`not in graph (${r.changed.unknown.length}): ${list(r.changed.unknown)}  <- regenerate?`);
  }
  lines.push('changed by domain:');
  for (const d of r.changed.byDomain) lines.push(`  ${d.domain} (${d.files.length}): ${list(d.files)}`);
  if (r.changed.byDomain.length === 0) lines.push('  —');

  const depth = r.blastRadius.depthCapReached ? ', depth cap hit' : '';
  lines.push(`blast radius (${r.blastRadius.count}${depth}): ${list(r.blastRadius.files, r.blastRadius.count)}`);
  lines.push(`affected domains (${r.domains.length}): ${list(r.domains.map((d) => `${d.domain}(${d.files})`))}`);

  lines.push(`risky exports (${r.riskyExports.count}):`);
  for (const s of r.riskyExports.list) {
    lines.push(`  ${s.name} ${s.path}${s.line ? `:${s.line}` : ''} refs=${s.refs} <- ${list(s.files.slice(0, 3), s.refs)}`);
  }
  if (r.riskyExports.count === 0) lines.push('  —');

  lines.push(`likely tests (${r.tests.count}): ${list(r.tests.files, r.tests.count)}`);
  return lines.join('\n');
}
