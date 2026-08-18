import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from '../inventory/write.mjs';
import { normPosix } from '../inventory/schema.mjs';
import { readInventorySources, readInventoryManifest } from '../lib/inventory_reader.mjs';
import { TsconfigIndex } from '../lib/tsconfig_index.mjs';
import { discoverWorkspaces, workspaceTsPaths } from '../lib/workspaces.mjs';
import { defaultCompilerOptions } from '../lib/ts_resolve.mjs';
import { changedFilesSince } from '../lib/changed_files.mjs';
import {
  revisionOfArtifactManifest, loadImportersIndex, computeAffectedFiles,
  changedFilesRiskGlobals, buildIncrementalProgram, affectedFilesToWalk, symIdPath,
} from '../lib/incremental.mjs';
import { extractUsages } from './lib/usage_extractor.mjs';
import { buildGraph } from './lib/graph_builder.mjs';

const SCHEMA_VERSION = 1;

// NOTE: this layer builds a TypeScript `Program` over the whole source set and
// runs the type-checker to resolve uses. On large repos that can exceed Node's
// default heap — if you hit "JS heap out of memory", raise it with
//   NODE_OPTIONS=--max-old-space-size=8192 loregraph usages ...
// (documented, not forced, so small repos stay light).

/** Read every row of a .jsonl file (blank lines skipped). */
function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
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
  const wsPaths = workspaceTsPaths(discoverWorkspaces(repoRoot), repoRoot);
  if (Object.keys(wsPaths).length > 0) {
    options.paths = { ...wsPaths, ...(options.paths ?? {}) };
    options.baseUrl = options.baseUrl ?? repoRoot;
  }
  return options;
}

/** Reconstruct `{ fromSymId, toSymId }` records from a cached edges.jsonl. */
function loadCachedUsageRecords(edgesPath) {
  const records = [];
  const text = readFileSync(edgesPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.type !== 'USES') continue;
    records.push({ fromSymId: e.from, toSymId: e.to });
  }
  return records;
}

/**
 * Produce the usage records to build the graph from. In `off` mode (or on any
 * incremental fallback) this is a full extraction. In `incremental` mode it drops
 * the affected files' cached records (a usage record is owned by the file that
 * declares its `fromSymId`), re-extracts ONLY those files against a whole-repo
 * program, and merges — a result byte-identical to a full rebuild. Every fallback
 * prints a one-line note to stderr and yields the full extraction.
 */
function resolveUsages({ cfg, repoRoot, outDir, fileNames, options, symbolIds, currentSourcePaths }) {
  const full = () => extractUsages({ fileNames, options, symbolIds, repoRoot });
  if (cfg.incremental !== 'incremental') return full();

  const fallback = (reason) => {
    console.error(`usages: incremental fallback to full — ${reason}`);
    return full();
  };

  const usesDir = join(outDir, 'usages');
  const edgesPath = join(usesDir, 'edges.jsonl');
  const manifestPath = join(usesDir, 'manifest.json');
  if (!existsSync(edgesPath) || !existsSync(manifestPath)) return fallback('no prior usages cache');

  const since = revisionOfArtifactManifest(manifestPath);
  if (!since) return fallback('prior cache revision unknown');

  const cf = changedFilesSince(repoRoot, since);
  if (!cf.ok) return fallback('changed-files detection unavailable');
  if (changedFilesRiskGlobals({ ...cf, repoRoot })) return fallback('a changed file may inject globals');

  let cached;
  try {
    cached = loadCachedUsageRecords(edgesPath);
  } catch (err) {
    return fallback(`cannot read cached edges (${err.message})`);
  }

  const importers = loadImportersIndex(join(outDir, 'imports', 'edges.jsonl'));
  const changed = [...cf.added, ...cf.modified, ...cf.deleted];
  const affected = computeAffectedFiles(changed, importers);

  // A usage record is owned by the file that DECLARES its `fromSymId`. Keep the
  // record only if that owner is non-affected and BOTH endpoints still exist.
  const kept = cached.filter(
    (r) => !affected.has(symIdPath(r.fromSymId)) && symbolIds.has(r.fromSymId) && symbolIds.has(r.toSymId),
  );

  const walk = affectedFilesToWalk(affected, currentSourcePaths, repoRoot);
  let fresh = [];
  if (walk.length > 0) {
    const program = buildIncrementalProgram({
      rootNames: fileNames, options, tsBuildInfoFile: join(outDir, '.tsbuildinfo'),
    });
    fresh = extractUsages({ fileNames, options, symbolIds, repoRoot, program, walkFiles: walk });
  }

  console.error(
    `usages: incremental — re-extracted ${walk.length} file(s), reused ${kept.length} cached edge(s)`,
  );
  return [...kept, ...fresh];
}

/**
 * Layer 2d — usages. Type-checks the repo and emits a symbol→symbol USES graph:
 * for each declared Symbol (from the symbols layer), which OTHER Symbols its body
 * references. Powers "most-connected symbols". Returns a numeric exit code:
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
    console.error(`usages: usage error: ${err.message}`);
    return 2;
  }

  if (cfg.incremental !== 'off' && cfg.incremental !== 'incremental') {
    console.error(`usages: --incremental must be 'off' or 'incremental', got ${cfg.incremental}`);
    return 2;
  }

  const { repoRoot, outDir, _flags: flags } = cfg;

  let maxFiles = null;
  if (flags['max-files'] !== undefined) {
    maxFiles = Number(flags['max-files']);
    if (!Number.isInteger(maxFiles) || maxFiles < 0) {
      console.error(`usages: --max-files must be a non-negative integer, got ${flags['max-files']}`);
      return 2;
    }
  }

  const inventoryDir = flags.inventory ? resolve(cwd, flags.inventory) : join(outDir, 'inventory');
  if (!existsSync(join(inventoryDir, 'manifest.json'))) {
    console.error(`usages: no inventory found at ${inventoryDir} — run \`loregraph inventory\` first`);
    return 2;
  }

  const symbolsDir = flags.symbols ? resolve(cwd, flags.symbols) : join(outDir, 'symbols');
  if (!existsSync(join(symbolsDir, 'manifest.json'))) {
    console.error(`usages: no symbols found at ${symbolsDir} — run \`loregraph symbols\` first`);
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
    console.error(`usages: failed to read upstream artifacts: ${err.message}`);
    return 2;
  }

  // Deterministic order, then optional cap.
  sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (maxFiles !== null) sources = sources.slice(0, maxFiles);

  // Resolvable endpoints + reusable full Symbol nodes.
  const symbolIds = new Set();
  const symbolNodesById = new Map();
  for (const node of symbolNodes) {
    symbolIds.add(node.id);
    symbolNodesById.set(node.id, node);
  }

  const currentSourcePaths = new Set(sources.map((row) => normPosix(row.path)));
  const fileNames = sources
    .map((row) => join(repoRoot, normPosix(row.path)))
    .filter((abs) => existsSync(abs));

  const options = compilerOptions(repoRoot, cfg.tsconfig);

  const usages = resolveUsages({
    cfg, repoRoot, outDir, fileNames, options, symbolIds, currentSourcePaths,
  });

  const { nodes, edges, counts } = buildGraph({ usages, symbolNodesById });

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    basedOnSnapshot: invManifest?.snapshotId ?? 'unknown',
    counts: { symbols: counts.symbols, edges: counts.edges },
  };

  const outBase = join(outDir, 'usages');
  try {
    writeJsonlAtomic(join(outBase, 'nodes.jsonl'), nodes);
    writeJsonlAtomic(join(outBase, 'edges.jsonl'), edges);
    writeJsonAtomic(join(outBase, 'manifest.json'), manifest);
  } catch (err) {
    console.error(`usages: failed to write artifacts: ${err.message}`);
    return 1;
  }

  console.log(
    `[loregraph] usesSymbols=${counts.symbols} edges=${counts.edges} out=${outBase}`,
  );

  return 0;
}
