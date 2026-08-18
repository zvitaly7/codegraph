import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from '../inventory/write.mjs';
import { normPosix } from '../inventory/schema.mjs';
import { readInventorySources, readInventoryManifest } from '../lib/inventory_reader.mjs';
import { TsconfigIndex } from '../lib/tsconfig_index.mjs';
import { discoverWorkspaces } from '../lib/workspaces.mjs';
import { collectEntryPoints } from '../lib/entry_points.mjs';
import { changedFilesSince } from '../lib/changed_files.mjs';
import {
  revisionOfArtifactManifest, loadImportersIndex, computeAffectedFiles,
  changedFilesRiskGlobals, buildIncrementalProgram, affectedFilesToWalk,
} from '../lib/incremental.mjs';
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
 */
function compilerOptions(repoRoot, tsconfigOverride) {
  const options = defaultCompilerOptions();
  try {
    const view = new TsconfigIndex({ repoRoot, tsconfigOverride }).forFile(join(repoRoot, '__root__.ts'));
    if (view.paths && Object.keys(view.paths).length > 0) {
      options.paths = view.paths;
      options.baseUrl = view.baseUrl ?? view.pathsBase;
    } else if (view.baseUrl) {
      options.baseUrl = view.baseUrl;
    }
  } catch {
    // tsconfig discovery is best-effort; fall back to the plain default.
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
 */
function resolveReferences({ cfg, repoRoot, outDir, fileNames, options, symbolIds, currentSourcePaths }) {
  const full = () => extractReferences({ fileNames, options, symbolIds, repoRoot });
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
    const program = buildIncrementalProgram({
      rootNames: fileNames, options, tsBuildInfoFile: join(outDir, '.tsbuildinfo'),
    });
    fresh = extractReferences({ fileNames, options, symbolIds, repoRoot, program, walkFiles: walk });
  }

  console.error(
    `references: incremental — re-extracted ${walk.length} file(s), reused ${kept.length} cached edge(s)`,
  );
  return [...kept, ...fresh];
}

/**
 * Layer 2c — references. Type-checks the repo and emits a file→symbol REFERENCES
 * graph: for each source, which declared Symbols (from the symbols layer) it
 * actually uses. Powers "most-used symbols" and "dead exports". Returns a
 * numeric exit code:
 *   0 success · 1 write failure · 2 usage / missing upstream artifact.
 */
export async function run(argv) {
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
  for (const node of symbolNodes) {
    symbolIds.add(node.id);
    symbolNodesById.set(node.id, node);
    if (node.properties?.exported) exportedBaseIds.add(baseSymId(node.id));
  }

  const currentSourcePaths = new Set(sources.map((row) => normPosix(row.path)));
  const fileNames = sources
    .map((row) => join(repoRoot, normPosix(row.path)))
    .filter((abs) => existsSync(abs));

  const options = compilerOptions(repoRoot, cfg.tsconfig);

  const references = resolveReferences({
    cfg, repoRoot, outDir, fileNames, options, symbolIds, currentSourcePaths,
  });

  // Entry points: files consumed across a boundary the import graph cannot see
  // (a CLI, a library entry, a Module-Federation remote). Their exports are held
  // back from the dead-export count, and the exclusion is reported rather than
  // silently applied.
  const entryPoints = collectEntryPoints({
    repoRoot,
    patterns: cfg.entryPoints,
    filePaths: [...currentSourcePaths],
    workspaces: discoverWorkspaces(repoRoot),
  });
  const entryPointPaths = new Set(entryPoints.paths);

  const { nodes, edges, counts } = buildGraph({
    references, symbolNodesById, entryPointPaths: entryPoints.paths,
  });

  // Dead exports: exported symbols with no CROSS-file incoming reference. A
  // symbol used only inside its own file still leaves its `export` unused.
  const crossFileReferenced = new Set(references.filter((r) => !r.sameFile).map((r) => r.symId));
  let deadExports = 0;
  let entryPointExclusions = 0;
  for (const id of exportedBaseIds) {
    if (crossFileReferenced.has(id)) continue;
    if (entryPointPaths.has(pathOfSymId(id))) entryPointExclusions += 1;
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
