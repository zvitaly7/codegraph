// Assemble the references graph from extracted reference records.
//
// Input is `references`: `{ fromPath, symId, sameFile }` records (deduped, as
// produced by reference_extractor). We build:
//   - one File node per distinct referencing file  (id file:<path>),
//   - one Symbol node per distinct referenced symbol (id sym:<path>#<name>),
//   - one REFERENCES edge File→Symbol per record, carrying `sameFile`.
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
 */
export function buildGraph({ references, symbolNodesById }) {
  const fileNodes = new Map();   // fileId → node
  const symbolNodes = new Map(); // symId → node
  const edges = new Map();       // edge id → edge

  for (const r of references) {
    const fromId = fileId(r.fromPath);
    if (!fileNodes.has(fromId)) {
      fileNodes.set(fromId, { id: fromId, labels: ['File'], properties: { path: r.fromPath } });
    }
    if (!symbolNodes.has(r.symId)) {
      const injected = symbolNodesById?.get(r.symId);
      symbolNodes.set(r.symId, injected ?? minimalSymbolNode(r.symId));
    }
    const e = edge('REFERENCES', fromId, r.symId, { sameFile: r.sameFile });
    if (!edges.has(e.id)) edges.set(e.id, e);
  }

  const nodes = [...fileNodes.values(), ...symbolNodes.values()].sort(byId);
  const edgeList = [...edges.values()].sort(byId);

  return {
    nodes,
    edges: edgeList,
    counts: {
      files: fileNodes.size,
      symbolsReferenced: symbolNodes.size,
      edges: edgeList.length,
    },
  };
}
