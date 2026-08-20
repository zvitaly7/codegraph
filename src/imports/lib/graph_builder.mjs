// Assemble the imports graph from extracted specifiers.
//
// Input files are `{ path, absPath, specifiers, computedDynamicImports }`. We build:
//   - one File node per source (id file:<path>),
//   - one Package node per distinct external package (id pkg:<name>),
//   - one IMPORTS edge per resolved import (internal or external), deduped.
//
// The `internal` / `external` / `unresolved` counts are per-(file, specifier)
// occurrences (each unique specifier in a file counted once), while `edges` is
// the number of distinct graph edges — the two differ whenever several
// specifiers collapse onto the same target (e.g. many subpaths of one package).
//
// `computedDynamicImports` is the one count that describes what is MISSING: the
// `import(<non-literal>)` sites nothing static can follow, so no edge exists for
// them and none ever will. It rides on the File node (only when non-zero, so a
// clean file's node is unchanged) and is totalled repo-wide, because every
// consumer that reports reachability needs to be able to say how much of the
// answer it cannot see.

import { fileId, edge } from '../../inventory/schema.mjs';
import { resolveSpecifier } from './resolver.mjs';

function packageScope(name) {
  return name.startsWith('@') ? name.split('/')[0] : null;
}

export function buildGraph({ files, targetPaths, repoRoot, tsconfigIndex, workspaces }) {
  // Only `files` are parsed. `targetPaths` may additionally contain inventory
  // assets/docs/config files that a source can import and impact must traverse.
  const fileSet = new Set(targetPaths ?? files.map((f) => f.path));
  const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const packages = new Map(); // name → node
  const edges = new Map();     // edge id → edge
  const counts = { internal: 0, external: 0, unresolved: 0 };
  // Which of our own packages an import could not be traced into, and how many
  // imports each one swallowed. The count alone says data is missing; the names
  // say what would bring it back.
  const unresolvedPackages = new Map();
  const internalTargets = new Set();

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
        workspaces,
      });
      counts[res.kind] += 1;

      if (res.kind === 'unresolved') {
        if (res.reason === 'workspace-unresolved') {
          unresolvedPackages.set(res.packageName, (unresolvedPackages.get(res.packageName) ?? 0) + 1);
        }
        continue;
      }

      if (res.kind === 'external' && !packages.has(res.packageName)) {
        packages.set(res.packageName, {
          id: res.targetId,
          labels: ['Package'],
          properties: { name: res.packageName, scope: packageScope(res.packageName) },
        });
      }

      if (res.kind === 'internal') internalTargets.add(res.targetId.slice('file:'.length));

      const e = edge('IMPORTS', fromId, res.targetId, { specifier, kind: res.kind });
      if (!edges.has(e.id)) edges.set(e.id, e); // first (sorted) specifier wins
    }
  }

  const fileNodes = new Map(sortedFiles.map((f) => [f.path, {
    id: fileId(f.path), labels: ['File'],
    properties: f.computedDynamicImports > 0
      ? { path: f.path, computedDynamicImports: f.computedDynamicImports }
      : { path: f.path },
  }]));
  // Keep this layer valid in isolation: every internal edge endpoint gets a
  // File node, even when the target was not itself a parsed JS/TS source.
  for (const path of internalTargets) {
    if (!fileNodes.has(path)) {
      fileNodes.set(path, { id: fileId(path), labels: ['File'], properties: { path } });
    }
  }

  // Only the files that actually have one, so this list stays short enough to
  // read and a clean repo reports an empty array rather than every file.
  const computedDynamicImportFiles = sortedFiles
    .filter((f) => f.computedDynamicImports > 0)
    .map((f) => ({ path: f.path, count: f.computedDynamicImports }));
  const computedDynamicImports = computedDynamicImportFiles
    .reduce((sum, f) => sum + f.count, 0);

  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const nodes = [...fileNodes.values(), ...packages.values()].sort(byId);
  const edgeList = [...edges.values()].sort(byId);

  return {
    nodes,
    edges: edgeList,
    computedDynamicImportFiles,
    counts: {
      files: files.length,
      packages: packages.size,
      edges: edgeList.length,
      internal: counts.internal,
      external: counts.external,
      unresolved: counts.unresolved,
      // Sorted by weight, then name: the package that swallowed the most
      // imports is the one worth mapping first.
      unresolvedPackages: Object.fromEntries(
        [...unresolvedPackages.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
      ),
      computedDynamicImports,
    },
  };
}
