import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from '../inventory/write.mjs';
import { normPosix } from '../inventory/schema.mjs';
import { readInventorySources, readInventoryManifest } from '../lib/inventory_reader.mjs';
import { TsconfigIndex } from '../lib/tsconfig_index.mjs';
import { defaultCompilerOptions } from '../lib/ts_resolve.mjs';
import { extractUsages } from './lib/usage_extractor.mjs';
import { buildGraph } from './lib/graph_builder.mjs';

const SCHEMA_VERSION = 1;

// NOTE: this layer builds a TypeScript `Program` over the whole source set and
// runs the type-checker to resolve uses. On large repos that can exceed Node's
// default heap — if you hit "JS heap out of memory", raise it with
//   NODE_OPTIONS=--max-old-space-size=8192 codegraph usages ...
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
      },
    });
  } catch (err) {
    console.error(`usages: usage error: ${err.message}`);
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
    console.error(`usages: no inventory found at ${inventoryDir} — run \`codegraph inventory\` first`);
    return 2;
  }

  const symbolsDir = flags.symbols ? resolve(cwd, flags.symbols) : join(outDir, 'symbols');
  if (!existsSync(join(symbolsDir, 'manifest.json'))) {
    console.error(`usages: no symbols found at ${symbolsDir} — run \`codegraph symbols\` first`);
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

  const fileNames = sources
    .map((row) => join(repoRoot, normPosix(row.path)))
    .filter((abs) => existsSync(abs));

  const options = compilerOptions(repoRoot, cfg.tsconfig);

  const usages = extractUsages({ fileNames, options, symbolIds, repoRoot });

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
    `[codegraph] usesSymbols=${counts.symbols} edges=${counts.edges} out=${outBase}`,
  );

  return 0;
}
