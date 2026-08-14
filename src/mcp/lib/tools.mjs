// Query functions over a loaded graph (see ../../lib/graph_load.mjs).
//
// Every tool takes `(graph, args)` and returns plain JSON (no throwing for
// ordinary "not found" cases — those are reported in the payload). All of them
// are pure reads of the graph except `impact` in diff mode, which asks the VCS
// which files changed. The `TOOLS` array carries a JSON-schema-ish input spec
// per tool for `tools/list`, and `callTool(graph, name, args)` dispatches by name.
//
// `brief` and `impact` are the token-saving pair: they call the very same pure
// functions the CLI does, so an agent gets one dense digest instead of reading
// a pile of files.

import { normPosix } from '../../inventory/schema.mjs';
import { changedFilesSince } from '../../lib/changed_files.mjs';
import { buildBrief } from '../../brief/lib/brief.mjs';
import { buildImpact } from '../../impact/lib/impact.mjs';

/** Default caps — keep payloads bounded for an agent context window. */
const FIND_CAP = 50;
const IMPACT_DEPTH = 25;
const PATH_DEPTH = 25;

// ---- id resolution ------------------------------------------------------

/** Canonical `file:<path>` id for a file argument that may be a path or an id. */
function toFileId(file) {
  if (typeof file !== 'string') return null;
  return file.startsWith('file:') ? file : `file:${normPosix(file)}`;
}

/** Canonical `domain:<id>` id for a domain argument (bare name or full id). */
function toDomainId(domain) {
  if (typeof domain !== 'string') return null;
  return domain.startsWith('domain:') ? domain : `domain:${domain}`;
}

/** Best-effort resolution of an arbitrary node argument to an id present in the graph. */
function resolveNodeId(graph, x) {
  if (typeof x !== 'string') return null;
  if (graph.nodesById.has(x)) return x;
  const asFile = `file:${normPosix(x)}`;
  if (graph.nodesById.has(asFile)) return asFile;
  const asDomain = `domain:${x}`;
  if (graph.nodesById.has(asDomain)) return asDomain;
  return null;
}

/** Compact projection of a node for embedding in tool results. */
function briefNode(node) {
  if (!node) return null;
  return { id: node.id, labels: node.labels, properties: node.properties };
}

// ---- tools --------------------------------------------------------------

/** Nodes whose id / path / name contains `query` (case-insensitive). */
export function findNode(graph, { query, limit = FIND_CAP } = {}) {
  if (typeof query !== 'string' || query.length === 0) {
    return { query: query ?? null, error: 'query must be a non-empty string', total: 0, results: [] };
  }
  const needle = query.toLowerCase();
  const matches = [];
  for (const node of graph.nodesById.values()) {
    const path = node.properties?.path;
    const name = node.properties?.name;
    if (
      node.id.toLowerCase().includes(needle)
      || (typeof path === 'string' && path.toLowerCase().includes(needle))
      || (typeof name === 'string' && name.toLowerCase().includes(needle))
    ) {
      matches.push(node);
    }
  }
  matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cap = Number.isInteger(limit) && limit > 0 ? limit : FIND_CAP;
  return {
    query,
    total: matches.length,
    returned: Math.min(matches.length, cap),
    truncated: matches.length > cap,
    results: matches.slice(0, cap).map(briefNode),
  };
}

/** A node plus its immediate in/out edges grouped by type. */
export function nodeInfo(graph, { id } = {}) {
  const nodeId = resolveNodeId(graph, id);
  const node = nodeId ? graph.getNode(nodeId) : null;
  if (!node) return { id: id ?? null, found: false };
  const group = (edges, endpointKey) => {
    const out = {};
    for (const e of edges) {
      (out[e.type] ??= []).push({ id: e.id, [endpointKey]: e[endpointKey], properties: e.properties ?? {} });
    }
    return out;
  };
  const outE = graph.neighbors(node.id, { dir: 'out' });
  const inE = graph.neighbors(node.id, { dir: 'in' });
  return {
    found: true,
    node: briefNode(node),
    outEdges: group(outE, 'to'),
    inEdges: group(inE, 'from'),
    counts: { out: outE.length, in: inE.length },
  };
}

/** IMPORTS edges out of a file (its direct dependencies: files + packages). */
export function importsOf(graph, { file } = {}) {
  const fileId = toFileId(file);
  if (!fileId) return { file: file ?? null, error: 'file must be a string' };
  const found = graph.nodesById.has(fileId);
  const imports = graph.neighbors(fileId, { dir: 'out', type: 'IMPORTS' }).map((e) => ({
    to: e.to,
    kind: e.properties?.kind ?? null,
    specifier: e.properties?.specifier ?? null,
  }));
  imports.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return { file: fileId, found, count: imports.length, imports };
}

/** IMPORTS edges into a file (its direct dependents). */
export function importedBy(graph, { file } = {}) {
  const fileId = toFileId(file);
  if (!fileId) return { file: file ?? null, error: 'file must be a string' };
  const found = graph.nodesById.has(fileId);
  const importers = graph.neighbors(fileId, { dir: 'in', type: 'IMPORTS' }).map((e) => e.from);
  const unique = [...new Set(importers)].sort();
  return { file: fileId, found, count: unique.length, importedBy: unique };
}

/** Transitive dependents (blast radius) via repeated imported_by, BFS with depth cap. */
export function impactOf(graph, { file, maxDepth = IMPACT_DEPTH } = {}) {
  const fileId = toFileId(file);
  if (!fileId) return { file: file ?? null, error: 'file must be a string' };
  const cap = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : IMPACT_DEPTH;
  const found = graph.nodesById.has(fileId);
  const impacted = new Map(); // id -> depth at which first reached
  let frontier = [fileId];
  let depth = 0;
  let reachedCap = false;
  while (frontier.length > 0) {
    if (depth >= cap) { reachedCap = true; break; }
    depth += 1;
    const next = [];
    for (const id of frontier) {
      for (const e of graph.neighbors(id, { dir: 'in', type: 'IMPORTS' })) {
        const dep = e.from;
        if (dep === fileId || impacted.has(dep)) continue;
        impacted.set(dep, depth);
        next.push(dep);
      }
    }
    frontier = next;
  }
  const impactedList = [...impacted.keys()].sort();
  return {
    file: fileId,
    found,
    count: impactedList.length,
    maxDepth: cap,
    depthCapReached: reachedCap,
    impacted: impactedList,
  };
}

/** Shortest directed path (following edge.from → edge.to) between two nodes, BFS. */
export function pathBetween(graph, { from, to, maxDepth = PATH_DEPTH } = {}) {
  const fromId = resolveNodeId(graph, from);
  const toId = resolveNodeId(graph, to);
  if (!fromId || !toId) {
    return {
      from: from ?? null,
      to: to ?? null,
      found: false,
      reason: !fromId && !toId ? 'both endpoints unknown' : !fromId ? 'from unknown' : 'to unknown',
      path: null,
    };
  }
  if (fromId === toId) return { from: fromId, to: toId, found: true, length: 0, nodes: [fromId], edges: [] };

  const cap = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : PATH_DEPTH;
  const prev = new Map(); // nodeId -> { via: edge, from: nodeId }
  const visited = new Set([fromId]);
  let frontier = [fromId];
  let depth = 0;
  while (frontier.length > 0 && depth < cap) {
    depth += 1;
    const next = [];
    for (const id of frontier) {
      for (const e of graph.outEdges.get(id) ?? []) {
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        prev.set(e.to, { via: e, from: id });
        if (e.to === toId) {
          // Reconstruct from target back to source.
          const nodes = [toId];
          const edges = [];
          let cur = toId;
          while (cur !== fromId) {
            const step = prev.get(cur);
            edges.push({ id: step.via.id, type: step.via.type, from: step.via.from, to: step.via.to });
            nodes.push(step.from);
            cur = step.from;
          }
          nodes.reverse();
          edges.reverse();
          return { from: fromId, to: toId, found: true, length: edges.length, nodes, edges };
        }
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return { from: fromId, to: toId, found: true, length: null, path: null, note: `no path within depth ${cap}` };
}

/** Symbol nodes DECLARED by a file. */
export function listSymbols(graph, { file } = {}) {
  const fileId = toFileId(file);
  if (!fileId) return { file: file ?? null, error: 'file must be a string' };
  const found = graph.nodesById.has(fileId);
  const symbols = graph.neighbors(fileId, { dir: 'out', type: 'DECLARES' })
    .map((e) => graph.getNode(e.to))
    .filter(Boolean)
    .map((n) => ({
      id: n.id,
      name: n.properties?.name,
      kind: n.properties?.kind,
      exported: n.properties?.exported ?? false,
      line: n.properties?.line,
    }));
  symbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { file: fileId, found, count: symbols.length, symbols };
}

/**
 * Exported symbols nothing outside their own file references.
 *
 * With the references layer loaded this is PRECISE: a REFERENCES edge carries
 * `sameFile`, so an export used only by its own module still counts as dead
 * (nobody imports it). Without that layer we fall back to "no incoming edge
 * other than DECLARES", which cannot see symbol-level usage at all.
 */
export function deadExports(graph, { limit = FIND_CAP } = {}) {
  const precise = graph.loadedLayers.includes('references');
  const exported = graph.byLabel('Symbol').filter((n) => n.properties?.exported === true);
  const isDead = precise
    ? (n) => graph.neighbors(n.id, { dir: 'in', type: 'REFERENCES' })
      .every((e) => e.properties?.sameFile === true)
    : (n) => graph.neighbors(n.id, { dir: 'in' }).every((e) => e.type === 'DECLARES');
  const candidates = exported.filter(isDead);
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cap = Number.isInteger(limit) && limit > 0 ? limit : FIND_CAP;
  return {
    note: precise
      ? 'Exported symbols with no cross-file REFERENCES edge (same-file uses excluded). '
        + 'Dynamic/string-keyed access and non-TS entry points are still invisible.'
      : 'Best-effort only: no references layer is loaded, so symbol-level usages are '
        + 'unknown and EVERY exported symbol is reported as a candidate. '
        + 'Run `loregraph references` for precision.',
    precise,
    exportedSymbols: exported.length,
    total: candidates.length,
    returned: Math.min(candidates.length, cap),
    truncated: candidates.length > cap,
    candidates: candidates.slice(0, cap).map((n) => ({
      id: n.id,
      name: n.properties?.name,
      kind: n.properties?.kind,
      path: n.properties?.path,
      line: n.properties?.line,
    })),
  };
}

/** The domain a file BELONGS_TO. */
export function domainOf(graph, { file } = {}) {
  const fileId = toFileId(file);
  if (!fileId) return { file: file ?? null, error: 'file must be a string' };
  const found = graph.nodesById.has(fileId);
  const edge = graph.neighbors(fileId, { dir: 'out', type: 'BELONGS_TO' })[0];
  if (!edge) return { file: fileId, found, domain: null };
  const node = graph.getNode(edge.to);
  return {
    file: fileId,
    found,
    domain: edge.to,
    name: node?.properties?.name ?? edge.to.replace(/^domain:/, ''),
    kind: node?.properties?.kind ?? null,
  };
}

/** DEPENDS_ON edges out of / into a domain, with weights. */
export function domainDependencies(graph, { domain } = {}) {
  const domainId = toDomainId(domain);
  if (!domainId) return { domain: domain ?? null, error: 'domain must be a string' };
  const found = graph.nodesById.has(domainId);
  const proj = (e, key) => ({ [key]: e[key], weight: e.properties?.weight ?? 1 });
  const dependsOn = graph.neighbors(domainId, { dir: 'out', type: 'DEPENDS_ON' })
    .map((e) => proj(e, 'to'))
    .sort((a, b) => b.weight - a.weight || (a.to < b.to ? -1 : 1));
  const dependedOnBy = graph.neighbors(domainId, { dir: 'in', type: 'DEPENDS_ON' })
    .map((e) => proj(e, 'from'))
    .sort((a, b) => b.weight - a.weight || (a.from < b.from ? -1 : 1));
  return { domain: domainId, found, dependsOn, dependedOnBy };
}

/** Cross-domain import summary: all DEPENDS_ON edges ranked by weight. */
export function domainCrossings(graph) {
  const nameOf = (id) => graph.getNode(id)?.properties?.name ?? id.replace(/^domain:/, '');
  const rows = graph.byType('DEPENDS_ON').map((e) => ({
    from: e.from,
    to: e.to,
    fromName: nameOf(e.from),
    toName: nameOf(e.to),
    weight: e.properties?.weight ?? 1,
  }));
  rows.sort((a, b) => b.weight - a.weight
    || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  const totalWeight = rows.reduce((sum, r) => sum + r.weight, 0);
  const result = { domains: graph.byLabel('Domain').length, pairs: rows.length, totalWeight, crossings: rows };
  if (rows.length === 0) {
    result.note = 'No DEPENDS_ON edges — run the domains layer (with imports present) to populate cross-domain data.';
  }
  return result;
}

// ---- context packs (the token savers) -----------------------------------

/** Everything worth knowing about a file / domain / symbol, in one payload. */
export function brief(graph, { target, limit } = {}) {
  if (typeof target !== 'string' || target.length === 0) {
    return { kind: 'not-found', target: target ?? null, error: 'target must be a non-empty string', candidates: [] };
  }
  return buildBrief(graph, target, { limit });
}

/**
 * Review context for a change: blast radius, affected domains, risky exports,
 * likely tests. Pass `files` explicitly, or let it diff the working tree against
 * `diff` (default HEAD) using the repo root recorded in the inventory manifest.
 */
export function impact(graph, { files, diff, limit, maxDepth } = {}) {
  if (Array.isArray(files)) {
    return buildImpact(graph, files.map(String), { limit, maxDepth, source: 'files' });
  }
  const ref = typeof diff === 'string' && diff.length > 0 ? diff : 'HEAD';
  const source = `diff ${ref}`;
  const repoRoot = graph.manifest?.repoRoot;
  if (!repoRoot) {
    return { source, error: 'no repoRoot in the cache manifest — pass `files` explicitly' };
  }
  const delta = changedFilesSince(repoRoot, ref);
  if (!delta.ok) {
    return { source, error: `could not determine changes vs ${ref} in ${repoRoot} — pass \`files\` explicitly` };
  }
  const changed = [...delta.added, ...delta.modified, ...delta.deleted];
  return buildImpact(graph, changed, { limit, maxDepth, source });
}

// ---- registry + dispatch ------------------------------------------------

const strProp = (description) => ({ type: 'string', description });

/** Tool specs (name, description, JSON-schema-ish inputSchema) for tools/list. */
export const TOOLS = [
  {
    name: 'find_node',
    description: 'Find graph nodes whose id, path, or name contains a query substring (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: { query: strProp('Substring to search for.'), limit: { type: 'integer', description: 'Max results (default 50).' } },
      required: ['query'],
    },
  },
  {
    name: 'node_info',
    description: 'Return a node and its immediate incoming/outgoing edges grouped by type.',
    inputSchema: {
      type: 'object',
      properties: { id: strProp('Node id (e.g. file:src/a.ts, sym:src/a.ts#foo, domain:core). A bare file path is accepted.') },
      required: ['id'],
    },
  },
  {
    name: 'imports_of',
    description: 'List the direct imports (files + packages) of a file.',
    inputSchema: { type: 'object', properties: { file: strProp('File path or file: id.') }, required: ['file'] },
  },
  {
    name: 'imported_by',
    description: 'List the files that directly import a file.',
    inputSchema: { type: 'object', properties: { file: strProp('File path or file: id.') }, required: ['file'] },
  },
  {
    name: 'impact_of',
    description: 'Transitive dependents of a file (blast radius) via repeated imported_by, BFS with a depth cap.',
    inputSchema: {
      type: 'object',
      properties: { file: strProp('File path or file: id.'), maxDepth: { type: 'integer', description: 'BFS depth cap (default 25).' } },
      required: ['file'],
    },
  },
  {
    name: 'path_between',
    description: 'Shortest directed path (following edges from→to) between two nodes, or null if none within the depth cap.',
    inputSchema: {
      type: 'object',
      properties: {
        from: strProp('Source node id or file path.'),
        to: strProp('Target node id or file path.'),
        maxDepth: { type: 'integer', description: 'BFS depth cap (default 25).' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'list_symbols',
    description: 'List the symbols declared by a file.',
    inputSchema: { type: 'object', properties: { file: strProp('File path or file: id.') }, required: ['file'] },
  },
  {
    name: 'domain_of',
    description: 'Return the domain a file belongs to.',
    inputSchema: { type: 'object', properties: { file: strProp('File path or file: id.') }, required: ['file'] },
  },
  {
    name: 'domain_dependencies',
    description: 'Weighted DEPENDS_ON edges out of and into a domain.',
    inputSchema: { type: 'object', properties: { domain: strProp('Domain id or bare domain name.') }, required: ['domain'] },
  },
  {
    name: 'domain_crossings',
    description: 'Summary of all cross-domain dependencies (DEPENDS_ON edges) ranked by weight.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dead_exports',
    description: 'Exported symbols nothing outside their own file references (precise when the references layer is loaded).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Max candidates (default 50).' } } },
  },
  {
    name: 'brief',
    description: 'Context pack for a file, domain or symbol in ONE call — domain, imports, importers, '
      + 'declared symbols with reference counts, blast radius. Read this instead of opening the files. '
      + 'Ambiguous targets come back as a candidate list.',
    inputSchema: {
      type: 'object',
      properties: {
        target: strProp('File path or path suffix (Cart.tsx), domain name, symbol name, or a node id.'),
        limit: { type: 'integer', description: 'Max items per list (default 10).' },
      },
      required: ['target'],
    },
  },
  {
    name: 'impact',
    description: 'Review context for a change: the changed files by domain, the transitive blast radius, '
      + 'the affected domains, the exported symbols other files depend on (risky surface), and the '
      + 'test files that reach the change. Defaults to the uncommitted working-tree diff.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Explicit changed paths; omit to use a VCS diff.' },
        diff: strProp('Revision to compare the working tree against (default HEAD; e.g. main, HEAD~1).'),
        limit: { type: 'integer', description: 'Max items per list (default 10).' },
        maxDepth: { type: 'integer', description: 'Blast-radius BFS depth cap (default 25).' },
      },
    },
  },
];

/** name → pure function. */
const DISPATCH = {
  find_node: findNode,
  node_info: nodeInfo,
  imports_of: importsOf,
  imported_by: importedBy,
  impact_of: impactOf,
  path_between: pathBetween,
  list_symbols: listSymbols,
  domain_of: domainOf,
  domain_dependencies: domainDependencies,
  domain_crossings: domainCrossings,
  dead_exports: deadExports,
  brief,
  impact,
};

/** Set of valid tool names (for tools/call validation). */
export const TOOL_NAMES = new Set(Object.keys(DISPATCH));

/**
 * Run a tool by name. Throws on an unknown tool name; on an empty graph, prefixes
 * a "graph empty" note to any object result so the caller knows to regenerate.
 */
export function callTool(graph, name, args = {}) {
  const fn = DISPATCH[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  const result = fn(graph, args ?? {});
  if (graph.empty && result && typeof result === 'object' && !Array.isArray(result)) {
    return { note: 'graph empty — run `loregraph regenerate`', ...result };
  }
  return result;
}
