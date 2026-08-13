// Assemble the usages graph from extracted USES records.
//
// Input is `usages`: `{ fromSymId, toSymId }` records (deduped, as produced by
// usage_extractor). We build:
//   - one Symbol node per distinct symbol INVOLVED (as a from and/or a to), and
//   - one USES edge fromSym→toSym per record.
//
// Symbol nodes are re-emitted so the artifact is loadable on its own. When the
// caller passes `symbolNodesById` (the full Symbol nodes from the symbols layer)
// we reuse them verbatim, keeping the two layers byte-consistent; otherwise we
// synthesize a minimal `{ name, path }` node from the id.
//
// Output is deterministic: nodes and edges are sorted by id, so identical inputs
// yield identical bytes regardless of record order.

import { edge } from '../../inventory/schema.mjs';

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
 * @param {Array<{fromSymId:string, toSymId:string}>} args.usages
 * @param {Map<string, object>} [args.symbolNodesById] full Symbol nodes to reuse.
 */
export function buildGraph({ usages, symbolNodesById }) {
  const symbolNodes = new Map(); // symId → node
  const edges = new Map();       // edge id → edge

  const ensureNode = (symId) => {
    if (!symbolNodes.has(symId)) {
      const injected = symbolNodesById?.get(symId);
      symbolNodes.set(symId, injected ?? minimalSymbolNode(symId));
    }
  };

  for (const u of usages) {
    ensureNode(u.fromSymId);
    ensureNode(u.toSymId);
    const e = edge('USES', u.fromSymId, u.toSymId);
    if (!edges.has(e.id)) edges.set(e.id, e);
  }

  const nodes = [...symbolNodes.values()].sort(byId);
  const edgeList = [...edges.values()].sort(byId);

  return {
    nodes,
    edges: edgeList,
    counts: {
      symbols: symbolNodes.size,
      edges: edgeList.length,
    },
  };
}
