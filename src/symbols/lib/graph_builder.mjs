// Assemble the symbols graph from per-file declaration lists.
//
// Input files are `{ path, symbols }` where each symbol is
// `{ name, kind, exported, line }` (as produced by symbol_extractor). We build:
//   - one File node per source   (id file:<path>),
//   - one Symbol node per symbol  (id sym:<path>#<name>),
//   - one DECLARES edge File→Symbol per symbol, carrying the symbol `kind`.
//
// ID-collision scheme: symbol ids are scoped by file path, so the same name in
// two files never clashes. WITHIN one file a name can legitimately repeat
// (function overloads, interface/namespace or interface/function merging,
// same-name type and value). The FIRST occurrence of a name keeps the clean
// canonical id `sym:<path>#<name>`; each subsequent occurrence gets a `~<n>`
// ordinal suffix in source order (`~2`, `~3`, …). The `name` PROPERTY always
// stays the real declared name — only the id is disambiguated.
//
// Output is deterministic: files are processed in path order, and the final
// node/edge arrays are sorted by id, so identical inputs yield identical bytes.

import { fileId, edge, normPosix } from '../../inventory/schema.mjs';

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildGraph({ files }) {
  const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const fileNodes = [];
  const symbolNodes = [];
  const edges = [];
  let exported = 0;

  for (const f of sortedFiles) {
    const path = normPosix(f.path);
    const fromId = fileId(path);
    fileNodes.push({ id: fromId, labels: ['File'], properties: { path } });

    const seen = new Map(); // name → how many times seen so far in this file
    for (const s of f.symbols) {
      const n = (seen.get(s.name) ?? 0) + 1;
      seen.set(s.name, n);
      const base = `sym:${path}#${s.name}`;
      const symId = n === 1 ? base : `${base}~${n}`;

      symbolNodes.push({
        id: symId,
        labels: ['Symbol'],
        properties: {
          name: s.name,
          kind: s.kind,
          exported: s.exported,
          path,
          line: s.line,
        },
      });
      edges.push(edge('DECLARES', fromId, symId, { kind: s.kind }));
      if (s.exported) exported += 1;
    }
  }

  const nodes = [...fileNodes, ...symbolNodes].sort(byId);
  const edgeList = [...edges].sort(byId);

  return {
    nodes,
    edges: edgeList,
    counts: {
      files: sortedFiles.length,
      symbols: symbolNodes.length,
      edges: edgeList.length,
      exported,
    },
  };
}
