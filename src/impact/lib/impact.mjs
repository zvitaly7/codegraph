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

import { renderPathList, shownPaths } from '../../lib/path_compress.mjs';
import { moreMarker } from '../../lib/answer_budget.mjs';
import { fitAnswer } from '../../lib/answer_render.mjs';
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

/**
 * `a, b, c (+N more)` — or `—` when the list is empty.
 * @param {{budget?: boolean, dropped?: number}} [opts] see brief/lib/brief.mjs.
 */
function list(items, total, { budget = false, dropped = 0 } = {}) {
  const hidden = dropped > 0 ? dropped : (total ?? items.length) - items.length;
  const marker = moreMarker(hidden, { budget: budget || dropped > 0 });
  if (items.length === 0) return marker || '—';
  return [items.join(', '), marker].filter(Boolean).join(' ');
}

/** One path list as `label: …`, plus a compressed list's extra indented lines. */
function pushPathLine(lines, label, box, key, total, indent = '  ') {
  const hidden = total - shownPaths(box, key);
  const marker = moreMarker(hidden, { budget: (box?.budgetDropped ?? 0) > 0 });
  const { inline, lines: extra } = renderPathList(box, key, { marker, indent });
  lines.push(inline === '' ? `${label}:` : `${label}: ${inline}`);
  lines.push(...extra);
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
  for (const d of r.changed.byDomain) {
    pushPathLine(lines, `  ${d.domain} (${shownPaths(d, 'files')})`, d, 'files', shownPaths(d, 'files'), '    ');
  }
  const byDomainDropped = moreMarker(r.changed.byDomainDropped ?? 0, { budget: true });
  if (byDomainDropped) lines.push(`  ${byDomainDropped}`);
  else if (r.changed.byDomain.length === 0) lines.push('  —');

  const depth = r.blastRadius.depthCapReached ? ', depth cap hit' : '';
  pushPathLine(lines, `blast radius (${r.blastRadius.count}${depth})`, r.blastRadius, 'files', r.blastRadius.count);
  // The count is the untruncated one: a budget cut must not make the answer
  // look like it found fewer affected domains than it did.
  const domainCount = r.domains.length + (r.domainsDropped ?? 0);
  lines.push(`affected domains (${domainCount}): ${list(r.domains.map((d) => `${d.domain}(${d.files})`), null, { dropped: r.domainsDropped ?? 0 })}`);

  lines.push(`risky exports (${r.riskyExports.count}):`);
  for (const s of r.riskyExports.list) {
    lines.push(`  ${s.name} ${s.path}${s.line ? `:${s.line}` : ''} refs=${s.refs} <- ${list(s.files.slice(0, 3), s.refs)}`);
  }
  const riskyCut = (r.riskyExports.budgetDropped ?? 0) > 0;
  const riskyDropped = moreMarker(r.riskyExports.count - r.riskyExports.list.length, { budget: riskyCut });
  if (riskyCut && riskyDropped) lines.push(`  ${riskyDropped}`);
  else if (r.riskyExports.count === 0) lines.push('  —');

  pushPathLine(lines, `likely tests (${r.tests.count})`, r.tests, 'files', r.tests.count);
  return lines.join('\n');
}

// ---- path compression + token budget ------------------------------------

/**
 * The repo-path lists in an impact report. `riskyExports[].files` is left out on
 * purpose: the text rendering shows only the first three of each, so factoring a
 * prefix out of the whole list would buy nothing a reader can see.
 */
export function impactPathLists(r) {
  const lists = [
    { get: (p) => p.changed, key: 'files' },
    { get: (p) => p.blastRadius, key: 'files' },
    { get: (p) => p.tests, key: 'files' },
  ];
  (r?.changed?.byDomain ?? []).forEach((_, i) => {
    lists.push({ get: (p) => p.changed.byDomain[i], key: 'files' });
  });
  return lists;
}

/**
 * Budget sections for an impact report, least important first (higher `drop`
 * goes first). The ranking follows what a reviewer does with the answer: the
 * blast radius is the biggest list and the least specific; the risky exports and
 * affected domains are summaries of it; the tests to run are the action item;
 * and WHAT CHANGED is the one thing the report is about, so it is cut last.
 */
export function impactSections(r) {
  const sections = [
    { id: 'changedFiles', drop: 2, get: (p) => p.changed, key: 'files' },
    { id: 'changedByDomain', drop: 1, get: (p) => p.changed, key: 'byDomain', dropped: 'byDomainDropped' },
    { id: 'blastRadius', drop: 6, get: (p) => p.blastRadius, key: 'files' },
    { id: 'domains', drop: 4, get: (p) => p, key: 'domains', dropped: 'domainsDropped' },
    { id: 'riskyExports', drop: 5, get: (p) => p.riskyExports, key: 'list' },
    { id: 'tests', drop: 3, get: (p) => p.tests, key: 'files' },
  ];
  return r ? sections : [];
}

/**
 * An impact report, ready to emit.
 * @param {object} r from `buildImpact`. Mutated by the budget step.
 * @param {{mode?: 'text'|'json', compress?: boolean, maxTokens?: number|null}} [opts]
 */
export function fitImpact(r, opts = {}) {
  return fitAnswer(r, {
    ...opts,
    pathLists: impactPathLists(r),
    sections: impactSections(r),
    format: formatImpact,
  });
}
