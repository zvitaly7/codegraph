// Assemble the references graph from extracted reference records.
//
// Input is `references`: `{ fromPath, symId, sameFile }` records (deduped, as
// produced by reference_extractor). We build:
//   - one File node per distinct referencing file  (id file:<path>),
//   - one Symbol node per distinct referenced symbol (id sym:<path>#<name>),
//   - one REFERENCES edge File→Symbol per record, carrying `sameFile`.
//
// `exposures` adds the second relation this layer knows about: an EXPOSES edge
// from an ENTRY POINT to a symbol it re-exports (see lib/reexports.mjs). It is
// deliberately NOT a general re-export graph — only entry points emit it —
// because its one job is to make "this symbol is public API" visible to every
// reader of the graph rather than to the dead-export counter alone. A repo with
// no re-exporting entry points passes none and gets exactly the graph it always
// got.
//
// Symbol nodes are re-emitted so the artifact is loadable on its own. When the
// caller passes `symbolNodesById` (the full Symbol nodes from the symbols
// layer) we reuse them verbatim, keeping the two layers byte-consistent;
// otherwise we synthesize a minimal `{ name, path }` node from the id.
//
// Output is deterministic: nodes and edges are sorted by id, so identical
// inputs yield identical bytes regardless of record order.

import { fileId, edge } from '../../inventory/schema.mjs';

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Parse `sym:<path>#<name>` into a minimal Symbol node (fallback only). */
function minimalSymbolNode(symId) {
  const body = symId.slice('sym:'.length);
  const hash = body.lastIndexOf('#');
  const path = hash === -1 ? body : body.slice(0, hash);
  const name = hash === -1 ? body : body.slice(hash + 1);
  return { id: symId, labels: ['Symbol'], properties: { name, path } };
}

/**
 * @param {object} args
 * @param {Array<{fromPath:string, symId:string, sameFile:boolean}>} args.references
 * @param {Map<string, object>} [args.symbolNodesById] full Symbol nodes to reuse.
 * @param {string[]} [args.entryPointPaths] files whose exports are never dead.
 *   Their File nodes carry `entryPoint: true` and are emitted even when the file
 *   references nothing, so every reader of the graph can see the exclusion.
 * @param {Array<{entryPoint:string, symId:string, hops:number}>} [args.exposures]
 *   symbols an entry point re-exports; each becomes an EXPOSES edge.
 */
export function buildGraph({
  references, symbolNodesById, entryPointPaths = [], exposures = [],
}) {
  const fileNodes = new Map();   // fileId → node
  const symbolNodes = new Map(); // symId → node
  const edges = new Map();       // edge id → edge
  const referencingFiles = new Set();
  const referencedSymbols = new Set();

  const rememberSymbol = (symId) => {
    if (symbolNodes.has(symId)) return;
    const injected = symbolNodesById?.get(symId);
    symbolNodes.set(symId, injected ?? minimalSymbolNode(symId));
  };

  for (const r of references) {
    const fromId = fileId(r.fromPath);
    referencingFiles.add(fromId);
    referencedSymbols.add(r.symId);
    if (!fileNodes.has(fromId)) {
      fileNodes.set(fromId, { id: fromId, labels: ['File'], properties: { path: r.fromPath } });
    }
    rememberSymbol(r.symId);
    const e = edge('REFERENCES', fromId, r.symId, { sameFile: r.sameFile });
    if (!edges.has(e.id)) edges.set(e.id, e);
  }

  for (const path of entryPointPaths) {
    const id = fileId(path);
    const existing = fileNodes.get(id);
    if (existing) existing.properties.entryPoint = true;
    else fileNodes.set(id, { id, labels: ['File'], properties: { path, entryPoint: true } });
  }

  for (const x of exposures) {
    rememberSymbol(x.symId);
    const e = edge('EXPOSES', fileId(x.entryPoint), x.symId, { hops: x.hops });
    if (!edges.has(e.id)) edges.set(e.id, e);
  }

  const nodes = [...fileNodes.values(), ...symbolNodes.values()].sort(byId);
  const edgeList = [...edges.values()].sort(byId);

  return {
    nodes,
    edges: edgeList,
    counts: {
      // `files` stays what it always meant: files that reference something. An
      // entry point with no references adds a node, not a referencing file.
      files: referencingFiles.size,
      // Likewise `symbolsReferenced` — an exposed symbol is emitted as a node so
      // the artifact stands alone, but nothing REFERENCES it.
      symbolsReferenced: referencedSymbols.size,
      edges: edgeList.length,
    },
  };
}
