import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from '../inventory/write.mjs';
import { normPosix } from '../inventory/schema.mjs';
import { readInventorySources, readInventoryManifest } from '../lib/inventory_reader.mjs';
import { TsconfigIndex } from '../lib/tsconfig_index.mjs';
import { discoverWorkspaces } from '../lib/workspaces.mjs';
import { scanImports } from './lib/specifier_extractor.mjs';
import { buildGraph } from './lib/graph_builder.mjs';

const SCHEMA_VERSION = 1;

/**
 * Layer 2a — imports. Reads the Layer-1 inventory and emits a file→file/package
 * IMPORTS graph. Returns a numeric exit code:
 *   0 success · 1 policy/write failure · 2 usage error.
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
        'require-resolution-rate': { type: 'string' },
        'max-files': { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`imports: usage error: ${err.message}`);
    return 2;
  }

  const { repoRoot, outDir, _flags: flags } = cfg;

  // Numeric flags — validate up front so a bad value is a usage error.
  let requireRate = null;
  if (flags['require-resolution-rate'] !== undefined) {
    requireRate = Number(flags['require-resolution-rate']);
    if (!Number.isFinite(requireRate)) {
      console.error(`imports: --require-resolution-rate must be a number, got ${flags['require-resolution-rate']}`);
      return 2;
    }
  }
  let maxFiles = null;
  if (flags['max-files'] !== undefined) {
    maxFiles = Number(flags['max-files']);
    if (!Number.isInteger(maxFiles) || maxFiles < 0) {
      console.error(`imports: --max-files must be a non-negative integer, got ${flags['max-files']}`);
      return 2;
    }
  }

  const inventoryDir = flags.inventory ? resolve(cwd, flags.inventory) : join(outDir, 'inventory');
  if (!existsSync(join(inventoryDir, 'manifest.json'))) {
    console.error(`imports: no inventory found at ${inventoryDir} — run \`loregraph inventory\` first`);
    return 2;
  }

  let invManifest;
  let sources;
  try {
    invManifest = readInventoryManifest(inventoryDir);
    sources = readInventorySources(inventoryDir);
  } catch (err) {
    console.error(`imports: failed to read inventory at ${inventoryDir}: ${err.message}`);
    return 2;
  }

  // Deterministic order, then optional cap.
  sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (maxFiles !== null) sources = sources.slice(0, maxFiles);

  const tsconfigIndex = new TsconfigIndex({
    repoRoot,
    tsconfigOverride: cfg.tsconfig,
    configPaths: cfg.paths,
    configPathsBase: cfg.pathsBase,
  });
  const workspaces = discoverWorkspaces(repoRoot);

  const files = [];
  for (const row of sources) {
    const path = normPosix(row.path);
    const absPath = join(repoRoot, path);
    let text;
    try {
      text = readFileSync(absPath, 'utf8');
    } catch {
      continue; // source listed in inventory but unreadable now — skip gracefully
    }
    // One read, both facts: the specifiers we can resolve, and how many dynamic
    // imports we cannot (see ./lib/specifier_extractor.mjs).
    const { specifiers, computedDynamicImports } = scanImports(absPath, text);
    files.push({ path, absPath, specifiers, computedDynamicImports });
  }

  const { nodes, edges, counts, computedDynamicImportFiles } = buildGraph({
    files, repoRoot, tsconfigIndex, workspaces: workspaces.byName,
  });

  const denom = counts.internal + counts.unresolved;
  const resolutionRate = denom === 0 ? 1 : counts.internal / denom;

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    basedOnSnapshot: invManifest?.snapshotId ?? 'unknown',
    counts,
    resolutionRate,
    computedDynamicImportFiles,
  };

  const outBase = join(outDir, 'imports');
  try {
    writeJsonlAtomic(join(outBase, 'nodes.jsonl'), nodes);
    writeJsonlAtomic(join(outBase, 'edges.jsonl'), edges);
    writeJsonAtomic(join(outBase, 'manifest.json'), manifest);
  } catch (err) {
    console.error(`imports: failed to write artifacts: ${err.message}`);
    return 1;
  }

  // The workspace note only appears on repos that declare one, so a plain repo's
  // output is unchanged. Same for the computed-dynamic-import note: a repo with
  // none says nothing, a repo with some cannot miss it.
  const wsNote = workspaces.packages.length > 0
    ? ` workspaces=${workspaces.packages.length} (${workspaces.sources.join(', ')})`
    : '';
  const dynNote = counts.computedDynamicImports > 0
    ? ` computedDynamicImports=${counts.computedDynamicImports} (in ${computedDynamicImportFiles.length} file${computedDynamicImportFiles.length === 1 ? '' : 's'} — unfollowable)`
    : '';
  console.log(
    `[loregraph] sources=${counts.files} internal=${counts.internal} external=${counts.external} `
    + `unresolved=${counts.unresolved} rate=${resolutionRate.toFixed(4)}${wsNote}${dynNote} out=${outBase}`,
  );

  // Packages the repo owns that no import could be traced into. Left unsaid,
  // this is the failure that looks like success: the graph reads as complete
  // while every dependency on those packages is missing from it, so the report
  // names them and how to map them, on every run rather than at setup time.
  const unreachable = Object.entries(counts.unresolvedPackages ?? {});
  if (unreachable.length > 0) {
    const total = unreachable.reduce((sum, [, n]) => sum + n, 0);
    console.error(
      `imports: ${unreachable.length} package(s) belong to this repo but no import could be `
      + `resolved into them (${total} import(s) lost from the graph):`,
    );
    for (const [name, n] of unreachable) {
      console.error(`  ${name} — ${n} import(s)`);
    }
    console.error(
      '  their entry points name build output the graph does not index; '
      + 'map them with the `paths` config key to restore the dependencies',
    );
  }

  // Policy gate runs after artifacts are written.
  if (requireRate !== null && resolutionRate < requireRate) {
    console.error(`imports: resolution rate ${resolutionRate.toFixed(4)} < required ${requireRate}`);
    return 1;
  }

  return 0;
}
