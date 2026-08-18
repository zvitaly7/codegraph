import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from '../inventory/write.mjs';
import { normPosix } from '../inventory/schema.mjs';
import { readInventorySources, readInventoryManifest } from '../lib/inventory_reader.mjs';
import { TsconfigIndex } from '../lib/tsconfig_index.mjs';
import { discoverWorkspaces, workspaceTsPaths } from '../lib/workspaces.mjs';
import { collectEntryPoints } from '../lib/entry_points.mjs';
import { entryReachableSymbols } from '../lib/reexports.mjs';
import { resolveSpecifier } from '../imports/lib/resolver.mjs';
import { changedFilesSince } from '../lib/changed_files.mjs';
import {
  revisionOfArtifactManifest, loadImportersIndex, computeAffectedFiles,
  changedFilesRiskGlobals, buildIncrementalProgram, affectedFilesToWalk,
} from '../lib/incremental.mjs';
import { buildProgram } from '../lib/program_cache.mjs';
import { extractReferences, defaultCompilerOptions } from './lib/reference_extractor.mjs';
import { buildGraph } from './lib/graph_builder.mjs';

const SCHEMA_VERSION = 1;

// NOTE: this layer builds a TypeScript `Program` over the whole source set and
// runs the type-checker to resolve references. On large repos that can exceed
// Node's default heap — if you hit "JS heap out of memory", raise it with
//   NODE_OPTIONS=--max-old-space-size=8192 loregraph references ...
// (documented, not forced, so small repos stay light).

/** Read every row of a .jsonl file (blank lines skipped). */
function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Strip a within-file collision ordinal (`~2`) to the canonical base id. */
function baseSymId(id) {
  return id.replace(/~\d+$/, '');
}

/** The declaring file of a `sym:<path>#<name>` id. */
function pathOfSymId(id) {
  const body = id.slice('sym:'.length);
  const hash = body.lastIndexOf('#');
  return hash === -1 ? body : body.slice(0, hash);
}

/**
 * Compiler options for the whole-repo program: the sensible bundler default,
 * augmented with baseUrl/paths from the nearest tsconfig (via TsconfigIndex) so
 * path-aliased imports resolve on repos that ship one. No tsconfig → pure default.
 *
 * Workspace packages are added as `paths` entries underneath whatever the
 * tsconfig declares (an explicit alias always wins), so `@myorg/ui` resolves
 * without the node_modules symlinks a fresh checkout may not have. A repo with
 * no workspaces gets exactly the options it always got.
 */
function compilerOptions(repoRoot, tsconfigOverride, configPaths, configPathsBase) {
  const options = defaultCompilerOptions();
  try {
    const view = new TsconfigIndex({
      repoRoot, tsconfigOverride, configPaths, configPathsBase,
    }).forFile(join(repoRoot, '__root__.ts'));
    if (view.paths && Object.keys(view.paths).length > 0) {
      options.paths = view.paths;
      options.baseUrl = view.baseUrl ?? view.pathsBase;
    } else if (view.baseUrl) {
      options.baseUrl = view.baseUrl;
    }
  } catch {
    // tsconfig discovery is best-effort; fall back to the plain default.
  }
  const wsPaths = workspaceTsPaths(discoverWorkspaces(repoRoot), repoRoot);
  if (Object.keys(wsPaths).length > 0) {
    options.paths = { ...wsPaths, ...(options.paths ?? {}) };
    options.baseUrl = options.baseUrl ?? repoRoot;
  }
  return options;
}

/** Reconstruct `{ fromPath, symId, sameFile }` records from a cached edges.jsonl. */
function loadCachedReferenceRecords(edgesPath) {
  const records = [];
  const text = readFileSync(edgesPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.type !== 'REFERENCES') continue;
    records.push({
      fromPath: e.from.slice('file:'.length),
      symId: e.to,
      sameFile: Boolean(e.properties?.sameFile),
    });
  }
  return records;
}

/**
 * Produce the reference records to build the graph from. In `off` mode (or on any
 * incremental fallback) this is a full extraction. In `incremental` mode it drops
 * the affected files' cached records, re-extracts ONLY those files against a
 * whole-repo program, and merges — a result byte-identical to a full rebuild.
 * Every fallback prints a one-line note to stderr and yields the full extraction.
 *
 * `programCache`, when the orchestrator supplies one, is where the whole-repo
 * program comes from — so the usages layer can reuse the very same one. Without
 * a cache (this layer run standalone) the extractor builds its own, exactly as
 * it always has.
 */
function resolveReferences({
  cfg, repoRoot, outDir, fileNames, options, symbolIds, currentSourcePaths, programCache,
}) {
  // A cached program is built the same way the extractor would build it, so
  // "shared" and "own" resolve identically.
  const wholeRepoProgram = (kind, extra, build) => (
    programCache
      ? programCache.get({ kind, rootNames: fileNames, options, extra }, build).program
      : undefined
  );

  const full = () => extractReferences({
    fileNames,
    options,
    symbolIds,
    repoRoot,
    program: wholeRepoProgram('full', null, () => buildProgram({ rootNames: fileNames, options })),
  });
  if (cfg.incremental !== 'incremental') return full();

  const fallback = (reason) => {
    console.error(`references: incremental fallback to full — ${reason}`);
    return full();
  };

  const refDir = join(outDir, 'references');
  const edgesPath = join(refDir, 'edges.jsonl');
  const manifestPath = join(refDir, 'manifest.json');
  if (!existsSync(edgesPath) || !existsSync(manifestPath)) return fallback('no prior references cache');

  const since = revisionOfArtifactManifest(manifestPath);
  if (!since) return fallback('prior cache revision unknown');

  const cf = changedFilesSince(repoRoot, since);
  if (!cf.ok) return fallback('changed-files detection unavailable');
  if (changedFilesRiskGlobals({ ...cf, repoRoot })) return fallback('a changed file may inject globals');

  let cached;
  try {
    cached = loadCachedReferenceRecords(edgesPath);
  } catch (err) {
    return fallback(`cannot read cached edges (${err.message})`);
  }

  const importers = loadImportersIndex(join(outDir, 'imports', 'edges.jsonl'));
  const changed = [...cf.added, ...cf.modified, ...cf.deleted];
  const affected = computeAffectedFiles(changed, importers);

  // Keep cached records from non-affected files whose target symbol still exists
  // (the membership test self-heals references to deleted symbols).
  const kept = cached.filter((r) => !affected.has(r.fromPath) && symbolIds.has(r.symId));

  // Re-extract affected files against a whole-repo incremental program.
  const walk = affectedFilesToWalk(affected, currentSourcePaths, repoRoot);
  let fresh = [];
  if (walk.length > 0) {
    const tsBuildInfoFile = join(outDir, '.tsbuildinfo');
    const program = wholeRepoProgram(
      'incremental',
      { tsBuildInfoFile },
      () => buildIncrementalProgram({ rootNames: fileNames, options, tsBuildInfoFile }),
    ) ?? buildIncrementalProgram({ rootNames: fileNames, options, tsBuildInfoFile });
    fresh = extractReferences({ fileNames, options, symbolIds, repoRoot, program, walkFiles: walk });
  }

  console.error(
    `references: incremental — re-extracted ${walk.length} file(s), reused ${kept.length} cached edge(s)`,
  );
  return [...kept, ...fresh];
}

/**
 * Which symbols the entry points expose through re-export chains, as
 * `{ entryPoint, symId, hops }` records sorted for a stable artifact.
 *
 * The chain walk is parse-only (see lib/reexports.mjs) and specifiers resolve
 * with the imports layer's resolver, so `export … from '@myorg/ui'` and a
 * tsconfig alias land on the same file the IMPORTS edge would. Only symbols the
 * symbols layer knows are dropped — an unresolvable chain simply exposes less.
 */
function collectExposures({
  repoRoot, entryPoints, currentSourcePaths, exportedNamesByPath, tsconfigOverride, workspaces,
  configPaths, configPathsBase,
}) {
  if (entryPoints.length === 0) return [];
  const tsconfigIndex = new TsconfigIndex({ repoRoot, tsconfigOverride, configPaths, configPathsBase });
  const noNames = new Set();

  const reached = entryReachableSymbols({
    entryPoints,
    readSource: (path) => {
      try {
        return readFileSync(join(repoRoot, path), 'utf8');
      } catch {
        return null; // listed in the inventory but unreadable now — expose less
      }
    },
    resolveSpecifier: (fromPath, specifier) => {
      const fromAbsFile = join(repoRoot, fromPath);
      const r = resolveSpecifier(specifier, {
        fromAbsFile,
        repoRoot,
        fileSet: currentSourcePaths,
        tsconfig: tsconfigIndex.forFile(fromAbsFile),
        workspaces: workspaces?.byName,
      });
      return r.kind === 'internal' ? r.targetId.slice('file:'.length) : null;
    },
    exportedNamesOf: (path) => exportedNamesByPath.get(path) ?? noNames,
  });

  return [...reached.entries()]
    .map(([symId, { entryPoint, hops }]) => ({ entryPoint, symId, hops }))
    .sort((a, b) => (a.symId < b.symId ? -1 : a.symId > b.symId ? 1 : 0));
}

/**
 * Layer 2c — references. Type-checks the repo and emits a file→symbol REFERENCES
 * graph: for each source, which declared Symbols (from the symbols layer) it
 * actually uses. Powers "most-used symbols" and "dead exports". Returns a
 * numeric exit code:
 *   0 success · 1 write failure · 2 usage / missing upstream artifact.
 *
 * `ctx.programCache` is an optional whole-repo program cache (see
 * ../lib/program_cache.mjs). The orchestrator passes one so the usages layer can
 * reuse this layer's program; run standalone, this argument is absent and the
 * layer builds its own program exactly as before.
 */
export async function run(argv, ctx = {}) {
  const cwd = process.cwd();

  let cfg;
  try {
    cfg = await resolveConfig({
      cwd,
      argv,
      extraOptions: {
        inventory: { type: 'string' },
        symbols: { type: 'string' },
        'max-files': { type: 'string' },
        incremental: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`references: usage error: ${err.message}`);
    return 2;
  }

  if (cfg.incremental !== 'off' && cfg.incremental !== 'incremental') {
    console.error(`references: --incremental must be 'off' or 'incremental', got ${cfg.incremental}`);
    return 2;
  }

  const { repoRoot, outDir, _flags: flags } = cfg;

  let maxFiles = null;
  if (flags['max-files'] !== undefined) {
    maxFiles = Number(flags['max-files']);
    if (!Number.isInteger(maxFiles) || maxFiles < 0) {
      console.error(`references: --max-files must be a non-negative integer, got ${flags['max-files']}`);
      return 2;
    }
  }

  const inventoryDir = flags.inventory ? resolve(cwd, flags.inventory) : join(outDir, 'inventory');
  if (!existsSync(join(inventoryDir, 'manifest.json'))) {
    console.error(`references: no inventory found at ${inventoryDir} — run \`loregraph inventory\` first`);
    return 2;
  }

  const symbolsDir = flags.symbols ? resolve(cwd, flags.symbols) : join(outDir, 'symbols');
  if (!existsSync(join(symbolsDir, 'manifest.json'))) {
    console.error(`references: no symbols found at ${symbolsDir} — run \`loregraph symbols\` first`);
    return 2;
  }

  let invManifest;
  let sources;
  let symbolNodes;
  try {
    invManifest = readInventoryManifest(inventoryDir);
    sources = readInventorySources(inventoryDir);
    symbolNodes = readJsonl(join(symbolsDir, 'nodes.jsonl')).filter((n) => n.labels?.includes('Symbol'));
  } catch (err) {
    console.error(`references: failed to read upstream artifacts: ${err.message}`);
    return 2;
  }

  // Deterministic order, then optional cap.
  sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (maxFiles !== null) sources = sources.slice(0, maxFiles);

  // Resolvable targets + reusable full Symbol nodes + exported-name set.
  const symbolIds = new Set();
  const symbolNodesById = new Map();
  const exportedBaseIds = new Set();
  const exportedNamesByPath = new Map(); // path → Set<declared name>
  for (const node of symbolNodes) {
    symbolIds.add(node.id);
    symbolNodesById.set(node.id, node);
    if (node.properties?.exported) {
      exportedBaseIds.add(baseSymId(node.id));
      const path = node.properties.path ?? pathOfSymId(node.id);
      if (!exportedNamesByPath.has(path)) exportedNamesByPath.set(path, new Set());
      exportedNamesByPath.get(path).add(node.properties.name);
    }
  }

  const currentSourcePaths = new Set(sources.map((row) => normPosix(row.path)));
  const fileNames = sources
    .map((row) => join(repoRoot, normPosix(row.path)))
    .filter((abs) => existsSync(abs));

  const options = compilerOptions(repoRoot, cfg.tsconfig, cfg.paths, cfg.pathsBase);

  const references = resolveReferences({
    cfg, repoRoot, outDir, fileNames, options, symbolIds, currentSourcePaths,
    programCache: ctx.programCache,
  });

  // Entry points: files consumed across a boundary the import graph cannot see
  // (a CLI, a library entry, a Module-Federation remote). Their exports are held
  // back from the dead-export count, and the exclusion is reported rather than
  // silently applied.
  const workspaces = discoverWorkspaces(repoRoot);
  const entryPoints = collectEntryPoints({
    repoRoot,
    patterns: cfg.entryPoints,
    filePaths: [...currentSourcePaths],
    workspaces,
  });
  const entryPointPaths = new Set(entryPoints.paths);

  // …and what those entry points RE-EXPORT. A barrel entry point declares
  // nothing, so being an entry point would otherwise exclude nothing at all.
  const exposures = collectExposures({
    repoRoot, entryPoints: entryPoints.paths, currentSourcePaths, exportedNamesByPath,
    tsconfigOverride: cfg.tsconfig, workspaces,
    configPaths: cfg.paths, configPathsBase: cfg.pathsBase,
  });
  const exposedIds = new Set(exposures.map((x) => x.symId));

  const { nodes, edges, counts } = buildGraph({
    references, symbolNodesById, entryPointPaths: entryPoints.paths, exposures,
  });

  // Dead exports: exported symbols with no CROSS-file incoming reference. A
  // symbol used only inside its own file still leaves its `export` unused —
  // unless an entry point declares it, or re-exports it as public API.
  const crossFileReferenced = new Set(references.filter((r) => !r.sameFile).map((r) => r.symId));
  let deadExports = 0;
  let entryPointExclusions = 0;
  for (const id of exportedBaseIds) {
    if (crossFileReferenced.has(id)) continue;
    if (entryPointPaths.has(pathOfSymId(id)) || exposedIds.has(id)) entryPointExclusions += 1;
    else deadExports += 1;
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    basedOnSnapshot: invManifest?.snapshotId ?? 'unknown',
    counts: { ...counts, deadExports, entryPointExclusions },
    entryPoints: entryPoints.paths.map((path) => ({ path, reason: entryPoints.reasons[path] })),
  };

  const outBase = join(outDir, 'references');
  try {
    writeJsonlAtomic(join(outBase, 'nodes.jsonl'), nodes);
    writeJsonlAtomic(join(outBase, 'edges.jsonl'), edges);
    writeJsonAtomic(join(outBase, 'manifest.json'), manifest);
  } catch (err) {
    console.error(`references: failed to write artifacts: ${err.message}`);
    return 1;
  }

  console.log(
    `[loregraph] refFiles=${counts.files} symbolsReferenced=${counts.symbolsReferenced} `
    + `edges=${counts.edges} deadExports=${deadExports} `
    + `entryPoints=${entryPoints.paths.length} (excluded ${entryPointExclusions}) out=${outBase}`,
  );

  return 0;
}
