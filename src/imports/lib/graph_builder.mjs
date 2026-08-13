// Assemble the imports graph from extracted specifiers.
//
// Input files are `{ path, absPath, specifiers }`. We build:
//   - one File node per source (id file:<path>),
//   - one Package node per distinct external package (id pkg:<name>),
//   - one IMPORTS edge per resolved import (internal or external), deduped.
//
// The `internal` / `external` / `unresolved` counts are per-(file, specifier)
// occurrences (each unique specifier in a file counted once), while `edges` is
// the number of distinct graph edges — the two differ whenever several
// specifiers collapse onto the same target (e.g. many subpaths of one package).

import { fileId, edge } from '../../inventory/schema.mjs';
import { resolveSpecifier } from './resolver.mjs';

function packageScope(name) {
  return name.startsWith('@') ? name.split('/')[0] : null;
}

export function buildGraph({ files, repoRoot, tsconfigIndex }) {
  const fileSet = new Set(files.map((f) => f.path));
  const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const packages = new Map(); // name → node
  const edges = new Map();     // edge id → edge
  const counts = { internal: 0, external: 0, unresolved: 0 };

  for (const f of sortedFiles) {
    const fromId = fileId(f.path);
    const tsconfig = tsconfigIndex.forFile(f.absPath);
    const specifiers = [...new Set(f.specifiers)].sort();

    for (const specifier of specifiers) {
      const res = resolveSpecifier(specifier, {
        fromAbsFile: f.absPath,
        repoRoot,
        fileSet,
        tsconfig,
      });
      counts[res.kind] += 1;

      if (res.kind === 'unresolved') continue;

      if (res.kind === 'external' && !packages.has(res.packageName)) {
        packages.set(res.packageName, {
          id: res.targetId,
          labels: ['Package'],
          properties: { name: res.packageName, scope: packageScope(res.packageName) },
        });
      }

      const e = edge('IMPORTS', fromId, res.targetId, { specifier, kind: res.kind });
      if (!edges.has(e.id)) edges.set(e.id, e); // first (sorted) specifier wins
    }
  }

  const fileNodes = sortedFiles.map((f) => ({
    id: fileId(f.path),
    labels: ['File'],
    properties: { path: f.path },
  }));

  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const nodes = [...fileNodes, ...packages.values()].sort(byId);
  const edgeList = [...edges.values()].sort(byId);

  return {
    nodes,
    edges: edgeList,
    counts: {
      files: files.length,
      packages: packages.size,
      edges: edgeList.length,
      internal: counts.internal,
      external: counts.external,
      unresolved: counts.unresolved,
    },
  };
}
