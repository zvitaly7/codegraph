// `brief` — one call that answers "what do I need to know before touching X".
//
// `buildBrief(graph, target, opts)` is PURE: it resolves `target` to a file, a
// domain or a symbol and returns a compact structured digest. `formatBrief` then
// renders that object as a few dense lines. The point is token economy: an agent
// reads ONE small block instead of opening ten files, so every list is capped
// (`limit`, default 10) and reports its untruncated total.
//
// Target resolution is tiered — the first tier that matches wins, and a tier
// matching more than once is reported as `ambiguous` rather than guessed:
//   1. an exact node id            (file:… / domain:… / sym:…)
//   2. an exact repo-relative path (src/a/b.ts)
//   3. an exact domain name        (checkout)
//   4. a path suffix / basename    (Cart.tsx)
//   5. an exact symbol name        (useCart)
// Nothing matched → `not-found`, with substring near-misses as suggestions.

import { exactPathMatch, suffixPathMatches } from '../../lib/path_match.mjs';
import { generatedLabel } from '../../describe/lib/store.mjs';
import { renderPathList, shownPaths } from '../../lib/path_compress.mjs';
import { moreMarker } from '../../lib/answer_budget.mjs';
import { fitAnswer } from '../../lib/answer_render.mjs';
import {
  toFileId, fileIdToPath, domainOfFile, symbolsOfFile, referencingFiles,
  directImporters, transitiveImporters, importsOfFile, filesOfDomain, capped,
} from '../../lib/graph_query.mjs';

/** Default cap for every list in a brief. */
export const DEFAULT_LIMIT = 10;

/** How many near-miss suggestions a `not-found` carries. */
const SUGGESTION_CAP = 8;

// ---- target resolution --------------------------------------------------

/** The brief kind a node id denotes. */
function kindOfId(id) {
  if (id.startsWith('file:')) return 'file';
  if (id.startsWith('domain:')) return 'domain';
  if (id.startsWith('sym:')) return 'symbol';
  return 'node';
}

/** Compact candidate projection for ambiguity / suggestion lists. */
function candidate(graph, id) {
  const node = graph.getNode(id);
  const kind = kindOfId(id);
  const out = { id, kind };
  const path = node?.properties?.path;
  const name = node?.properties?.name;
  if (kind === 'file') out.path = path ?? fileIdToPath(id);
  else if (name) out.name = name;
  if (kind === 'symbol' && path) out.path = path;
  return out;
}

/** Repo-relative paths of every File node in the graph. */
function filePathsOf(graph) {
  return graph.byLabel('File')
    .map((n) => n.properties?.path)
    .filter((p) => typeof p === 'string');
}

/**
 * Ordered resolution tiers; the first non-empty one decides. Exported because
 * the MCP `describe` tool must resolve a target EXACTLY the way `brief` does —
 * two different answers to "which node did you mean" would be a bug.
 * @returns {string[]} matching node ids (empty = no match, >1 = ambiguous).
 */
export function resolveTarget(graph, target) {
  if (graph.nodesById.has(target)) return [target];

  // Tiers 2 and 4 are the FILE tiers, and `outline` / `show` must match a file
  // argument exactly the same way — so both come from lib/path_match.mjs
  // rather than being spelled out a second time here.
  const paths = filePathsOf(graph);
  const exact = exactPathMatch(paths, target);
  if (exact !== null) return [toFileId(exact)];

  const asDomain = `domain:${target}`;
  if (graph.nodesById.has(asDomain)) return [asDomain];

  const bySuffix = suffixPathMatches(paths, target);
  if (bySuffix.length > 0) return bySuffix.map(toFileId);

  const byName = graph.byLabel('Symbol')
    .filter((n) => n.properties?.name === target)
    .map((n) => n.id)
    .sort();
  return byName;
}

/** Substring near-misses over file paths, domain names and symbol names. */
function suggest(graph, target) {
  const needle = target.toLowerCase();
  const ids = [];
  for (const node of graph.nodesById.values()) {
    const path = node.properties?.path;
    const name = node.properties?.name;
    if ((typeof path === 'string' && path.toLowerCase().includes(needle))
      || (typeof name === 'string' && name.toLowerCase().includes(needle))) {
      ids.push(node.id);
    }
  }
  return ids.sort().slice(0, SUGGESTION_CAP).map((id) => candidate(graph, id));
}

// ---- per-kind briefs ----------------------------------------------------

function fileBrief(graph, id, { limit, maxDepth }) {
  const node = graph.getNode(id);
  const props = node?.properties ?? {};
  const domain = domainOfFile(graph, id);

  const { internal, external } = importsOfFile(graph, id);
  const importers = directImporters(graph, id).map(fileIdToPath);
  const { byId: radius, depthCapReached } = transitiveImporters(graph, [id], { maxDepth });
  const radiusPaths = [...radius.keys()].map(fileIdToPath).sort();

  const symbols = symbolsOfFile(graph, id).map((s) => {
    const refs = referencingFiles(graph, s.id).length;
    return {
      name: s.properties?.name,
      kind: s.properties?.kind ?? null,
      exported: s.properties?.exported === true,
      line: s.properties?.line ?? null,
      refs,
    };
  });

  const capInternal = capped(internal, limit);
  const capExternal = capped(external, limit);
  const capImporters = capped(importers, limit);
  const capRadius = capped(radiusPaths, limit);
  const capSymbols = capped(symbols, limit);

  return {
    kind: 'file',
    id,
    path: props.path ?? fileIdToPath(id),
    language: props.language ?? null,
    fileKind: props.kind ?? null,
    sizeBytes: props.sizeBytes ?? null,
    domain: domain?.name ?? null,
    imports: {
      counts: { internal: capInternal.count, external: capExternal.count },
      internal: capInternal.items,
      external: capExternal.items,
    },
    importedBy: { count: capImporters.count, files: capImporters.items },
    symbols: { count: capSymbols.count, list: capSymbols.items },
    blastRadius: { count: capRadius.count, files: capRadius.items, depthCapReached },
  };
}

function domainBrief(graph, id, { limit }) {
  const node = graph.getNode(id);
  const fileIds = filesOfDomain(graph, id);
  const shortName = (domainId) => graph.getNode(domainId)?.properties?.name
    ?? domainId.replace(/^domain:/, '');

  const byWeight = (edges, endpoint) => edges
    .map((e) => ({ domain: shortName(e[endpoint]), weight: e.properties?.weight ?? 1 }))
    .sort((a, b) => b.weight - a.weight || (a.domain < b.domain ? -1 : 1))
    .slice(0, limit);

  // Rank the domain's files by how many files import them.
  const topFiles = fileIds
    .map((fid) => ({ path: fileIdToPath(fid), importedBy: directImporters(graph, fid).length }))
    .sort((a, b) => b.importedBy - a.importedBy || (a.path < b.path ? -1 : 1))
    .slice(0, limit);

  // External packages used inside the domain, ranked by how many files use them.
  const pkgFiles = new Map();
  for (const fid of fileIds) {
    for (const name of importsOfFile(graph, fid).external) {
      pkgFiles.set(name, (pkgFiles.get(name) ?? 0) + 1);
    }
  }
  const packages = [...pkgFiles.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1))
    .slice(0, limit);

  return {
    kind: 'domain',
    id,
    name: node?.properties?.name ?? id.replace(/^domain:/, ''),
    domainKind: node?.properties?.kind ?? null,
    files: { count: fileIds.length },
    dependsOn: byWeight(graph.neighbors(id, { dir: 'out', type: 'DEPENDS_ON' }), 'to'),
    dependedOnBy: byWeight(graph.neighbors(id, { dir: 'in', type: 'DEPENDS_ON' }), 'from'),
    topFiles,
    packages,
  };
}

function symbolBrief(graph, id, { limit }) {
  const node = graph.getNode(id);
  const props = node?.properties ?? {};
  const path = props.path ?? id.slice('sym:'.length, id.lastIndexOf('#'));
  const refFiles = referencingFiles(graph, id);
  const capRefs = capped(refFiles, limit);
  const domain = domainOfFile(graph, toFileId(path));

  const edgeIds = (dir, endpoint) => [...new Set(
    graph.neighbors(id, { dir, type: 'USES' }).map((e) => e[endpoint]),
  )].sort().slice(0, limit);

  return {
    kind: 'symbol',
    id,
    name: props.name ?? id.slice(id.lastIndexOf('#') + 1),
    symbolKind: props.kind ?? null,
    path,
    line: props.line ?? null,
    exported: props.exported === true,
    domain: domain?.name ?? null,
    referencedBy: { count: capRefs.count, files: capRefs.items },
    uses: edgeIds('out', 'to'),
    usedBy: edgeIds('in', 'from'),
    dead: props.exported === true && refFiles.length === 0,
  };
}

/**
 * The cached, MODEL-GENERATED description of a node — as its own field, never
 * merged into `properties`. `generated: true` and the label travel with the
 * text so no consumer can mistake it for something the graph proved.
 */
function describedBy(descriptions, id) {
  const row = descriptions?.get?.(id);
  if (!row) return null;
  return {
    generated: true,
    text: row.text,
    model: row.model ?? null,
    provider: row.provider ?? null,
    generatedAt: row.generatedAt ?? null,
    label: generatedLabel(row),
  };
}

/**
 * Build the context pack for `target`.
 * @param {object} graph a loaded graph (see lib/graph_load.mjs).
 * @param {string} target file path / path suffix, domain name, symbol name, or node id.
 * @param {{limit?: number, maxDepth?: number, descriptions?: object}} [opts]
 *   `descriptions` is a store from describe/lib/store.mjs; when given, the brief
 *   carries the target's generated description in a clearly-labelled field.
 * @returns {object} one of the `file` / `domain` / `symbol` / `ambiguous` / `not-found` shapes.
 */
export function buildBrief(graph, target, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const settings = { limit, maxDepth: opts.maxDepth };

  if (typeof target !== 'string' || target.length === 0) {
    return { kind: 'not-found', target: target ?? null, error: 'target must be a non-empty string', candidates: [] };
  }

  const matches = resolveTarget(graph, target);
  if (matches.length === 0) {
    return { kind: 'not-found', target, candidates: suggest(graph, target) };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      target,
      total: matches.length,
      candidates: matches.slice(0, limit).map((id) => candidate(graph, id)),
    };
  }

  const id = matches[0];
  const brief = kindOfId(id) === 'domain' ? domainBrief(graph, id, settings)
    : kindOfId(id) === 'symbol' ? symbolBrief(graph, id, settings)
      : kindOfId(id) === 'file' ? fileBrief(graph, id, settings)
        : { kind: 'node', id, node: graph.getNode(id) };

  const description = describedBy(opts.descriptions, id);
  return { target, ...brief, ...(description ? { description } : {}) };
}

// ---- formatting ---------------------------------------------------------

function humanBytes(n) {
  if (typeof n !== 'number') return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `a, b, c (+N more)` — or `—` when the list is empty.
 * @param {{budget?: boolean, dropped?: number}} [opts] `budget` marks the
 *   `(+N more)` as a `--max-tokens` cut; `dropped` supplies the count for the
 *   lists that carry no untruncated total of their own.
 */
function list(items, total, { budget = false, dropped = 0 } = {}) {
  const hidden = dropped > 0 ? dropped : (total ?? items.length) - items.length;
  const marker = moreMarker(hidden, { budget: budget || dropped > 0 });
  if (items.length === 0) return marker || '—';
  return [items.join(', '), marker].filter(Boolean).join(' ');
}

/**
 * One path list as `label: …`, plus the extra indented lines a compressed list
 * needs. Push both onto `lines`.
 */
function pushPathLine(lines, label, box, key, total) {
  const hidden = total - shownPaths(box, key);
  const marker = moreMarker(hidden, { budget: (box?.budgetDropped ?? 0) > 0 });
  const { inline, lines: extra } = renderPathList(box, key, { marker });
  lines.push(inline === '' ? `${label}:` : `${label}: ${inline}`);
  lines.push(...extra);
}

/** `sym:src/a.ts#foo` → `foo@src/a.ts` (ids are too long to print raw). */
function shortSym(id) {
  if (typeof id !== 'string' || !id.startsWith('sym:')) return String(id);
  const body = id.slice('sym:'.length);
  const hash = body.lastIndexOf('#');
  return hash === -1 ? body : `${body.slice(hash + 1)}@${body.slice(0, hash)}`;
}

function formatFile(b) {
  const meta = [b.language, b.fileKind, humanBytes(b.sizeBytes)].filter(Boolean).join(', ');
  const lines = [`FILE ${b.path}${meta ? `  (${meta})` : ''}`];
  lines.push(`domain: ${b.domain ?? '—'}`);
  pushPathLine(lines, `imports (${b.imports.counts.internal} internal)`, b.imports, 'internal', b.imports.counts.internal);
  lines.push(`packages (${b.imports.counts.external}): ${list(b.imports.external, b.imports.counts.external, { budget: (b.imports.externalDropped ?? 0) > 0 })}`);
  pushPathLine(lines, `imported by (${b.importedBy.count})`, b.importedBy, 'files', b.importedBy.count);
  pushPathLine(lines, `blast radius (${b.blastRadius.count})`, b.blastRadius, 'files', b.blastRadius.count);
  lines.push(`symbols (${b.symbols.count}):`);
  for (const s of b.symbols.list) {
    const tags = [s.kind, s.exported ? 'exported' : null, s.line ? `L${s.line}` : null, `refs=${s.refs}`]
      .filter(Boolean).join(' ');
    lines.push(`  ${s.name} ${tags}${s.exported && s.refs === 0 ? ' DEAD?' : ''}`);
  }
  const hidden = b.symbols.count - b.symbols.list.length;
  const marker = moreMarker(hidden, { budget: (b.symbols.budgetDropped ?? 0) > 0 });
  if (marker) lines.push(`  ${marker}`);
  return lines.join('\n');
}

function formatDomain(b) {
  const pair = (d) => `${d.domain}(${d.weight})`;
  const lines = [
    `DOMAIN ${b.name}${b.domainKind ? `  (${b.domainKind})` : ''}`,
    `files: ${b.files.count}`,
    `depends on: ${list(b.dependsOn.map(pair), null, { dropped: b.dependsOnDropped ?? 0 })}`,
    `depended on by: ${list(b.dependedOnBy.map(pair), null, { dropped: b.dependedOnByDropped ?? 0 })}`,
    `packages: ${list(b.packages.map((p) => `${p.name}(${p.files})`), null, { dropped: b.packagesDropped ?? 0 })}`,
    `top files (by importers):`,
  ];
  // One per line: each carries a metric, so an inline list would run very wide.
  for (const f of b.topFiles) lines.push(`  <-${f.importedBy}  ${f.path}`);
  const dropped = moreMarker(b.topFilesDropped ?? 0, { budget: true });
  if (dropped) lines.push(`  ${dropped}`);
  else if (b.topFiles.length === 0) lines.push('  —');
  return lines.join('\n');
}

function formatSymbol(b) {
  const meta = [b.symbolKind, b.exported ? 'exported' : 'local'].filter(Boolean).join(', ');
  const lines = [
    `SYMBOL ${b.name}${meta ? `  (${meta})` : ''}${b.dead ? '  DEAD?' : ''}`,
    `declared: ${b.path}${b.line ? `:${b.line}` : ''}   domain: ${b.domain ?? '—'}`,
  ];
  pushPathLine(lines, `referenced by (${b.referencedBy.count})`, b.referencedBy, 'files', b.referencedBy.count);
  lines.push(`uses: ${list(b.uses.map(shortSym), null, { dropped: b.usesDropped ?? 0 })}`);
  lines.push(`used by: ${list(b.usedBy.map(shortSym), null, { dropped: b.usedByDropped ?? 0 })}`);
  return lines.join('\n');
}

/**
 * The one line a generated description is ever printed on. It names the model
 * every single time — an unlabelled hallucination would poison the one thing
 * this tool is for, which is not guessing.
 */
function formatDescription(d) {
  return d ? `description (${d.label}): ${d.text}` : null;
}

/** Render a brief as compact human-readable text. */
export function formatBrief(b) {
  if (!b) return '';
  const withDescription = (text) => {
    const line = formatDescription(b.description);
    return line ? `${text}\n${line}` : text;
  };
  switch (b.kind) {
    case 'file': return withDescription(formatFile(b));
    case 'domain': return withDescription(formatDomain(b));
    case 'symbol': return withDescription(formatSymbol(b));
    case 'ambiguous':
      return [`ambiguous target "${b.target}" — ${b.total} candidates:`]
        .concat(b.candidates.map((c) => `  ${c.id}`))
        .concat(b.total > b.candidates.length ? [`  (+${b.total - b.candidates.length} more)`] : [])
        .join('\n');
    case 'not-found':
      return [`no match for "${b.target}"`]
        .concat(b.candidates.length > 0
          ? ['did you mean:', ...b.candidates.map((c) => `  ${c.id}`)]
          : [])
        .join('\n');
    default:
      return JSON.stringify(b, null, 2);
  }
}

// ---- path compression + token budget ------------------------------------

/**
 * Which of a brief's lists hold repo-relative paths, and may therefore have a
 * shared directory prefix factored out. Only genuine path lists are here:
 * `packages` are package names, and `uses` / `usedBy` are symbol ids whose
 * prefix an agent may well paste straight back into another tool.
 */
export function briefPathLists(b) {
  switch (b?.kind) {
    case 'file': return [
      { get: (p) => p.imports, key: 'internal' },
      { get: (p) => p.importedBy, key: 'files' },
      { get: (p) => p.blastRadius, key: 'files' },
    ];
    case 'symbol': return [{ get: (p) => p.referencedBy, key: 'files' }];
    default: return [];
  }
}

/**
 * Budget sections, with the order `--max-tokens` cuts them in. HIGHER `drop`
 * goes first, and the ranking is a claim worth arguing with:
 *
 *   - the blast radius is the longest list in a brief and the most derivable
 *     elsewhere (`impact` answers it in full), so it goes first;
 *   - the symbol table goes next — `outline` answers that question better;
 *   - then packages, then importers;
 *   - what the file itself imports survives longest, because it is the shortest
 *     path to understanding the file you asked about.
 *
 * The header, the domain line and any generated description are never cut.
 */
export function briefSections(b) {
  switch (b?.kind) {
    case 'file': return [
      { id: 'imports', drop: 1, get: (p) => p.imports, key: 'internal' },
      { id: 'packages', drop: 3, get: (p) => p.imports, key: 'external', dropped: 'externalDropped' },
      { id: 'importedBy', drop: 2, get: (p) => p.importedBy, key: 'files' },
      { id: 'blastRadius', drop: 5, get: (p) => p.blastRadius, key: 'files' },
      { id: 'symbols', drop: 4, get: (p) => p.symbols, key: 'list' },
    ];
    case 'domain': return [
      { id: 'dependsOn', drop: 1, get: (p) => p, key: 'dependsOn', dropped: 'dependsOnDropped' },
      { id: 'dependedOnBy', drop: 2, get: (p) => p, key: 'dependedOnBy', dropped: 'dependedOnByDropped' },
      { id: 'packages', drop: 3, get: (p) => p, key: 'packages', dropped: 'packagesDropped' },
      { id: 'topFiles', drop: 4, get: (p) => p, key: 'topFiles', dropped: 'topFilesDropped' },
    ];
    case 'symbol': return [
      { id: 'referencedBy', drop: 1, get: (p) => p.referencedBy, key: 'files' },
      { id: 'uses', drop: 2, get: (p) => p, key: 'uses', dropped: 'usesDropped' },
      { id: 'usedBy', drop: 3, get: (p) => p, key: 'usedBy', dropped: 'usedByDropped' },
    ];
    default: return [];
  }
}

/**
 * A brief, ready to emit: path lists compressed if asked, shrunk to
 * `--max-tokens` if asked, rendered as text or JSON.
 * @param {object} b from `buildBrief`. Mutated by the budget step.
 * @param {{mode?: 'text'|'json', compress?: boolean, maxTokens?: number|null}} [opts]
 * @returns see `fitAnswer` — `.text` for stdout, `.payload` for JSON consumers.
 */
export function fitBrief(b, opts = {}) {
  return fitAnswer(b, {
    ...opts,
    pathLists: briefPathLists(b),
    sections: briefSections(b),
    format: formatBrief,
  });
}
