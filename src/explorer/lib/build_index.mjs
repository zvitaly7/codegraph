// Compute the explorer `graph-index.json` object from a loaded graph.
//
// `buildIndex(graph, options)` is PURE: given the same graph and an explicit
// `generatedAt`, it returns an identical object, so it is fully unit-testable
// and the emitted file is byte-deterministic. Every ranked insight is sorted by
// its metric descending with a stable id/name tie-break and capped.
//
// The returned object is the single contract the browser SPA (a separate task)
// loads. Shape:
//   {
//     meta:    { generatedAt, project, snapshot, layersPresent, notes },
//     stats:   { files, symbols, packages, domains, edges },
//     nodes:   [ { id, type, name, path?, kind?, domainId?, exported? } ],
//     edges:   [ { type, from, to, weight? } ],
//     descriptions: { <nodeId>: { generated, text, model, provider, generatedAt } },
//     insights: { productMap, biggestDomains, mostUsedSymbols,
//                 mostConnectedSymbols, hooks, components, deadExports,
//                 deadExportsTotal, deadExportsEntryPoints,
//                 mostDependedPackages, biggestImporters,
//                 cycles, cyclesTotal, fileCyclesTotal, domainCyclesTotal },
//   }
// `descriptions` is MODEL-GENERATED text from `loregraph describe` — a separate
// map, never merged into `nodes`, precisely so the SPA (and any other reader)
// cannot confuse it with what the graph proved. Empty unless that command ran.
// `nodes` covers the four SPA-facing kinds only (file/symbol/package/domain);
// structural Project/Snapshot/Directory nodes are dropped. `edges` carries the
// six semantic relations, so every endpoint resolves to a node in `nodes`.

import { findCycles } from '../../lib/cycles.mjs';

/** Semantic relations kept in the index (all endpoints are SPA-facing nodes). */
const SEMANTIC_EDGE_TYPES = new Set([
  'IMPORTS', 'DECLARES', 'REFERENCES', 'USES', 'BELONGS_TO', 'DEPENDS_ON',
]);

/** Which insight each optional layer feeds — used only to annotate meta.notes. */
const LAYER_INSIGHTS = {
  imports: ['mostDependedPackages', 'biggestImporters'],
  references: ['mostUsedSymbols', 'hooks', 'components', 'deadExports'],
  usages: ['mostConnectedSymbols'],
  domains: ['productMap', 'biggestDomains'],
};

/** Default caps per insight list (each within the 15–50 guidance). */
const DEFAULT_LIMITS = {
  productMap: 30,
  biggestDomains: 20,
  mostUsedSymbols: 30,
  mostConnectedSymbols: 30,
  hooks: 20,
  components: 30,
  deadExports: 50,
  mostDependedPackages: 30,
  biggestImporters: 30,
  cycles: 30,
};

const HOOK_RE = /^use[A-Z]/;              // useState, useFooBar, …
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;  // probable React component / class

function posixBase(p) {
  const s = String(p ?? '');
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}

/** SPA-facing node kind, or null for structural nodes we drop. */
function nodeType(node) {
  const labels = node.labels ?? [];
  if (labels.includes('File')) return 'file';
  if (labels.includes('Symbol')) return 'symbol';
  if (labels.includes('Package')) return 'package';
  if (labels.includes('Domain')) return 'domain';
  return null;
}

/** Human-facing name for a node. */
function displayName(node, type, props) {
  if (props.name !== undefined && props.name !== null) return props.name;
  if (type === 'file') return posixBase(props.path);
  if (type === 'package') return node.id.replace(/^pkg:/, '');
  if (type === 'domain') return node.id.replace(/^domain:/, '');
  return node.id;
}

/** Ascending string compare (stable tie-break). */
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rank by numeric `metric` desc, tie-break by string `key` asc, then cap. */
function topBy(items, metric, key, limit) {
  return [...items]
    .sort((a, b) => (metric(b) - metric(a)) || cmpStr(key(a), key(b)))
    .slice(0, limit);
}

function incr(map, k, by = 1) {
  map.set(k, (map.get(k) ?? 0) + by);
}

/**
 * @param {{nodesById: Map<string,object>, edges: object[], loadedLayers?: string[], manifest?: object|null}} graph
 * @param {{generatedAt?: string, limits?: object}} [options]
 * @returns {object} the graph-index.json object.
 */
export function buildIndex(graph, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const nodesById = graph.nodesById ?? new Map();
  // The emitted `meta.layersPresent` key is the SPA's contract; the loader
  // calls the same list `loadedLayers`.
  const layersPresent = graph.loadedLayers ?? [];
  const generatedAt = options.generatedAt
    ?? graph.manifest?.generatedAt
    ?? new Date().toISOString();

  // --- Partition SPA-facing nodes by kind -------------------------------
  const files = [];
  const symbols = [];
  const packages = [];
  const domains = [];
  const domainById = new Map();
  const fileById = new Map();
  for (const node of nodesById.values()) {
    switch (nodeType(node)) {
      case 'file': files.push(node); fileById.set(node.id, node); break;
      case 'symbol': symbols.push(node); break;
      case 'package': packages.push(node); break;
      case 'domain': domains.push(node); domainById.set(node.id, node); break;
      default: break; // Project / Snapshot / Directory — structural, dropped.
    }
  }

  // --- Single pass over the semantic edges (aggregate + keep) ------------
  const semanticEdges = [];
  const importOutInternal = new Map(); // fileId  -> internal IMPORTS out-degree
  const pkgInDeg = new Map();          // pkgId   -> # importing files
  const refInFiles = new Map();        // symId   -> # distinct referencing files
  const crossFileRef = new Set();      // symId   -> has >=1 cross-file reference
  const usesOut = new Map();           // symId   -> USES out-degree
  const usesIn = new Map();            // symId   -> USES in-degree
  const domainFiles = new Map();       // domainId-> BELONGS_TO in-degree
  const fileDomain = new Map();        // fileId  -> domainId
  const dependsOn = [];                // DEPENDS_ON edges (domain -> domain)
  const fileImports = [];              // internal IMPORTS edges (file -> file)
  const exposedSymbols = new Set();    // symId   -> an entry point re-exports it

  for (const e of graph.edges ?? []) {
    // EXPOSES is not a relation the SPA draws — it only records that an entry
    // point re-exports a symbol, which the dead-export card must respect.
    if (e.type === 'EXPOSES') { exposedSymbols.add(e.to); continue; }
    if (!SEMANTIC_EDGE_TYPES.has(e.type)) continue;
    semanticEdges.push(e);
    switch (e.type) {
      case 'IMPORTS':
        if (typeof e.to === 'string' && e.to.startsWith('pkg:')) incr(pkgInDeg, e.to);
        else {
          incr(importOutInternal, e.from);
          if (typeof e.from === 'string' && e.from.startsWith('file:') && e.to.startsWith('file:')) {
            fileImports.push({ from: e.from, to: e.to });
          }
        }
        break;
      case 'REFERENCES':
        incr(refInFiles, e.to);
        if (e.properties?.sameFile === false) crossFileRef.add(e.to);
        break;
      case 'USES':
        incr(usesOut, e.from);
        incr(usesIn, e.to);
        break;
      case 'BELONGS_TO':
        incr(domainFiles, e.to);
        fileDomain.set(e.from, e.to);
        break;
      case 'DEPENDS_ON':
        dependsOn.push(e);
        break;
      default:
        break; // DECLARES stays in the edge list; no aggregate needed.
    }
  }

  const symName = (n) => n.properties?.name ?? '';
  const has = (layer) => layersPresent.includes(layer);

  // --- Insights ---------------------------------------------------------
  // Each list is gated on the layer that powers it, so a missing layer yields
  // an empty list (and a meta.note) instead of a misleading partial one.
  const productMap = !has('domains') ? [] : topBy(
    dependsOn
      .filter((e) => domainById.get(e.from)?.properties?.kind === 'product'
        && domainById.get(e.to)?.properties?.kind === 'product')
      .map((e) => ({
        from: e.from,
        to: e.to,
        fromName: domainById.get(e.from)?.properties?.name ?? e.from.replace(/^domain:/, ''),
        toName: domainById.get(e.to)?.properties?.name ?? e.to.replace(/^domain:/, ''),
        weight: e.properties?.weight ?? 1,
      })),
    (x) => x.weight,
    (x) => `${x.from} ${x.to}`,
    limits.productMap,
  );

  const biggestDomains = !has('domains') ? [] : topBy(
    domains.map((d) => ({
      id: d.id,
      name: d.properties?.name ?? d.id.replace(/^domain:/, ''),
      kind: d.properties?.kind ?? null,
      files: domainFiles.get(d.id) ?? 0,
    })),
    (x) => x.files,
    (x) => x.id,
    limits.biggestDomains,
  );

  const mostUsedSymbols = !has('references') ? [] : topBy(
    symbols
      .map((s) => ({
        id: s.id,
        name: symName(s),
        kind: s.properties?.kind ?? null,
        files: refInFiles.get(s.id) ?? 0,
      }))
      .filter((x) => x.files > 0),
    (x) => x.files,
    (x) => x.id,
    limits.mostUsedSymbols,
  );

  const mostConnectedSymbols = !has('usages') ? [] : topBy(
    symbols
      .map((s) => ({
        id: s.id,
        name: symName(s),
        kind: s.properties?.kind ?? null,
        degree: (usesOut.get(s.id) ?? 0) + (usesIn.get(s.id) ?? 0),
      }))
      .filter((x) => x.degree > 0),
    (x) => x.degree,
    (x) => x.id,
    limits.mostConnectedSymbols,
  );

  const hooks = !has('references') ? [] : topBy(
    symbols
      .filter((s) => HOOK_RE.test(symName(s)))
      .map((s) => ({ id: s.id, name: symName(s), files: refInFiles.get(s.id) ?? 0 })),
    (x) => x.files,
    (x) => x.id,
    limits.hooks,
  );

  const components = !has('references') ? [] : topBy(
    symbols
      .filter((s) => PASCAL_RE.test(symName(s)))
      .map((s) => ({ id: s.id, name: symName(s), files: refInFiles.get(s.id) ?? 0 })),
    (x) => x.files,
    (x) => x.id,
    limits.components,
  );

  // Dead exports: exported symbols with zero CROSS-file references. Sorted by
  // id (no metric) for determinism; a sample is emitted with the full total.
  // Without the references layer, "unreferenced" is unknowable → empty.
  // Exports of an ENTRY-POINT file are held back (they are consumed across a
  // boundary the import graph cannot see) and counted, never silently dropped —
  // and so are symbols an entry point re-exports, which an EXPOSES edge marks.
  const isEntryPointSymbol = (s) => nodesById
    .get(`file:${s.properties?.path}`)?.properties?.entryPoint === true
    || exposedSymbols.has(s.id);
  const unreferencedExports = !has('references') ? [] : symbols
    .filter((s) => s.properties?.exported === true && !crossFileRef.has(s.id));
  const deadExportsEntryPoints = unreferencedExports.filter(isEntryPointSymbol).length;
  const deadExportNodes = unreferencedExports
    .filter((s) => !isEntryPointSymbol(s))
    .sort((a, b) => cmpStr(a.id, b.id));
  const deadExports = deadExportNodes.slice(0, limits.deadExports).map((s) => ({
    id: s.id,
    name: symName(s),
    kind: s.properties?.kind ?? null,
  }));
  const deadExportsTotal = deadExportNodes.length;

  // Cycles: circular dependencies, in both scopes, each strongly connected group
  // counted ONCE. File cycles come first — they are the ones you can go and fix
  // — and each row focuses its lexicographically first member.
  const strip = (id, prefix) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
  const fileCycleList = !has('imports') ? [] : findCycles(fileImports).cycles;
  const domainCycleList = !has('domains') ? [] : findCycles(
    dependsOn.map((e) => ({ from: e.from, to: e.to, weight: e.properties?.weight ?? 1 })),
    { weighted: true },
  ).cycles;
  const fileCyclesTotal = fileCycleList.length;
  const domainCyclesTotal = domainCycleList.length;
  const cycles = [
    ...fileCycleList.map((c) => ({
      scope: 'file',
      id: c.members[0],
      members: c.members.map((m) => strip(m, 'file:')),
      length: c.length,
    })),
    ...domainCycleList.map((c) => ({
      scope: 'domain',
      id: c.members[0],
      members: c.members.map((m) => strip(m, 'domain:')),
      length: c.length,
      weight: c.totalWeight,
    })),
  ].slice(0, limits.cycles);

  const mostDependedPackages = !has('imports') ? [] : topBy(
    packages.map((p) => ({
      name: p.properties?.name ?? p.id.replace(/^pkg:/, ''),
      files: pkgInDeg.get(p.id) ?? 0,
    })),
    (x) => x.files,
    (x) => x.name,
    limits.mostDependedPackages,
  );

  const biggestImporters = !has('imports') ? [] : topBy(
    [...importOutInternal.entries()].map(([fileId, imports]) => ({
      file: fileById.get(fileId)?.properties?.path ?? fileId.replace(/^file:/, ''),
      imports,
    })),
    (x) => x.imports,
    (x) => x.file,
    limits.biggestImporters,
  );

  // --- Node list (search + focus) — minimal but sufficient --------------
  const outNodes = [];
  for (const node of nodesById.values()) {
    const type = nodeType(node);
    if (!type) continue;
    const props = node.properties ?? {};
    const out = { id: node.id, type, name: displayName(node, type, props) };
    if (type === 'file') {
      if (props.path !== undefined) out.path = props.path;
      if (props.kind !== undefined) out.kind = props.kind;
      const domainId = fileDomain.get(node.id);
      if (domainId !== undefined) out.domainId = domainId;
    } else if (type === 'symbol') {
      if (props.path !== undefined) out.path = props.path;
      if (props.kind !== undefined) out.kind = props.kind;
      if (props.exported !== undefined) out.exported = props.exported;
    } else if (type === 'domain') {
      if (props.kind !== undefined) out.kind = props.kind;
    }
    outNodes.push(out);
  }
  outNodes.sort((a, b) => cmpStr(a.id, b.id));

  // --- Edge list (adjacency for focus views) ----------------------------
  const outEdges = semanticEdges
    .map((e) => {
      const edge = { type: e.type, from: e.from, to: e.to };
      if (e.properties?.weight !== undefined) edge.weight = e.properties.weight;
      return edge;
    })
    .sort((a, b) => cmpStr(a.type, b.type) || cmpStr(a.from, b.from) || cmpStr(a.to, b.to));

  // --- Meta + stats -----------------------------------------------------
  const notes = [];
  for (const [layer, insights] of Object.entries(LAYER_INSIGHTS)) {
    if (!layersPresent.includes(layer)) {
      notes.push(`${layer} layer absent — ${insights.join(', ')} left empty`);
    }
  }

  const manifest = graph.manifest ?? null;
  const meta = {
    generatedAt,
    project: manifest?.projectId ? manifest.projectId.replace(/^project:/, '') : null,
    snapshot: manifest?.snapshotId ?? null,
    layersPresent: [...layersPresent],
    notes,
  };

  // Optional cache-freshness signal (computed by the caller, which has the
  // cache dir). Only the four SPA-facing fields are embedded; internal flags
  // like `hasCache` are dropped, and absent revisions normalize to null.
  if (options.staleness) {
    const s = options.staleness;
    meta.staleness = {
      stale: s.stale ?? null,
      cacheRevision: s.cacheRevision ?? null,
      currentRevision: s.currentRevision ?? null,
      reason: s.reason ?? null,
    };
  }

  const stats = {
    files: files.length,
    symbols: symbols.length,
    packages: packages.length,
    domains: domains.length,
    edges: outEdges.length,
  };

  // Model-written descriptions, keyed by node id in a map OF THEIR OWN. They are
  // deliberately not folded into `nodes`: everything in `nodes` is a fact the
  // graph proved, and a consumer must be able to tell the two apart without
  // reading this comment. Each entry carries the model, provider and date so the
  // SPA can label what it shows.
  const descriptions = {};
  if (typeof options.descriptions?.get === 'function') {
    for (const node of outNodes) {
      const row = options.descriptions.get(node.id);
      if (!row) continue;
      descriptions[node.id] = {
        generated: true,
        text: row.text,
        model: row.model ?? null,
        provider: row.provider ?? null,
        generatedAt: row.generatedAt ?? null,
      };
    }
  }

  return {
    meta,
    stats,
    nodes: outNodes,
    edges: outEdges,
    descriptions,
    insights: {
      productMap,
      biggestDomains,
      mostUsedSymbols,
      mostConnectedSymbols,
      hooks,
      components,
      deadExports,
      deadExportsTotal,
      deadExportsEntryPoints,
      mostDependedPackages,
      biggestImporters,
      cycles,
      cyclesTotal: fileCyclesTotal + domainCyclesTotal,
      fileCyclesTotal,
      domainCyclesTotal,
    },
  };
}
