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

import { normPosix } from '../../inventory/schema.mjs';
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

/** Ordered resolution tiers; the first non-empty one decides. @returns {string[]} ids */
function resolveTarget(graph, target) {
  if (graph.nodesById.has(target)) return [target];

  const asFile = `file:${normPosix(target)}`;
  if (graph.nodesById.has(asFile)) return [asFile];

  const asDomain = `domain:${target}`;
  if (graph.nodesById.has(asDomain)) return [asDomain];

  const suffix = `/${normPosix(target)}`;
  const bySuffix = graph.byLabel('File')
    .filter((n) => typeof n.properties?.path === 'string' && n.properties.path.endsWith(suffix))
    .map((n) => n.id)
    .sort();
  if (bySuffix.length > 0) return bySuffix;

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
 * Build the context pack for `target`.
 * @param {object} graph a loaded graph (see lib/graph_load.mjs).
 * @param {string} target file path / path suffix, domain name, symbol name, or node id.
 * @param {{limit?: number, maxDepth?: number}} [opts]
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
  return { target, ...brief };
}

// ---- formatting ---------------------------------------------------------

function humanBytes(n) {
  if (typeof n !== 'number') return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `a, b, c (+N more)` — or `—` when the list is empty. */
function list(items, total) {
  if (items.length === 0) return '—';
  const more = (total ?? items.length) - items.length;
  return items.join(', ') + (more > 0 ? ` (+${more} more)` : '');
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
  lines.push(`imports (${b.imports.counts.internal} internal): ${list(b.imports.internal, b.imports.counts.internal)}`);
  lines.push(`packages (${b.imports.counts.external}): ${list(b.imports.external, b.imports.counts.external)}`);
  lines.push(`imported by (${b.importedBy.count}): ${list(b.importedBy.files, b.importedBy.count)}`);
  lines.push(`blast radius (${b.blastRadius.count}): ${list(b.blastRadius.files, b.blastRadius.count)}`);
  lines.push(`symbols (${b.symbols.count}):`);
  for (const s of b.symbols.list) {
    const tags = [s.kind, s.exported ? 'exported' : null, s.line ? `L${s.line}` : null, `refs=${s.refs}`]
      .filter(Boolean).join(' ');
    lines.push(`  ${s.name} ${tags}${s.exported && s.refs === 0 ? ' DEAD?' : ''}`);
  }
  const hidden = b.symbols.count - b.symbols.list.length;
  if (hidden > 0) lines.push(`  (+${hidden} more)`);
  return lines.join('\n');
}

function formatDomain(b) {
  const pair = (d) => `${d.domain}(${d.weight})`;
  return [
    `DOMAIN ${b.name}${b.domainKind ? `  (${b.domainKind})` : ''}`,
    `files: ${b.files.count}`,
    `depends on: ${list(b.dependsOn.map(pair))}`,
    `depended on by: ${list(b.dependedOnBy.map(pair))}`,
    `top files: ${list(b.topFiles.map((f) => `${f.path}(<-${f.importedBy})`))}`,
    `packages: ${list(b.packages.map((p) => `${p.name}(${p.files})`))}`,
  ].join('\n');
}

function formatSymbol(b) {
  const meta = [b.symbolKind, b.exported ? 'exported' : 'local'].filter(Boolean).join(', ');
  return [
    `SYMBOL ${b.name}${meta ? `  (${meta})` : ''}${b.dead ? '  DEAD?' : ''}`,
    `declared: ${b.path}${b.line ? `:${b.line}` : ''}   domain: ${b.domain ?? '—'}`,
    `referenced by (${b.referencedBy.count}): ${list(b.referencedBy.files, b.referencedBy.count)}`,
    `uses: ${list(b.uses.map(shortSym))}`,
    `used by: ${list(b.usedBy.map(shortSym))}`,
  ].join('\n');
}

/** Render a brief as compact human-readable text. */
export function formatBrief(b) {
  if (!b) return '';
  switch (b.kind) {
    case 'file': return formatFile(b);
    case 'domain': return formatDomain(b);
    case 'symbol': return formatSymbol(b);
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
