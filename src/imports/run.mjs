import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from '../inventory/write.mjs';
import { normPosix } from '../inventory/schema.mjs';
import { readInventorySources, readInventoryManifest } from './lib/inventory_reader.mjs';
import { TsconfigIndex } from './lib/tsconfig_index.mjs';
import { extractSpecifiers } from './lib/specifier_extractor.mjs';
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
    console.error(`imports: no inventory found at ${inventoryDir} — run \`codegraph inventory\` first`);
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

  const tsconfigIndex = new TsconfigIndex({ repoRoot, tsconfigOverride: cfg.tsconfig });

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
    files.push({ path, absPath, specifiers: extractSpecifiers(absPath, text) });
  }

  const { nodes, edges, counts } = buildGraph({ files, repoRoot, tsconfigIndex });

  const denom = counts.internal + counts.unresolved;
  const resolutionRate = denom === 0 ? 1 : counts.internal / denom;

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    basedOnSnapshot: invManifest?.snapshotId ?? 'unknown',
    counts,
    resolutionRate,
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

  console.log(
    `[codegraph] sources=${counts.files} internal=${counts.internal} external=${counts.external} `
    + `unresolved=${counts.unresolved} rate=${resolutionRate.toFixed(4)} out=${outBase}`,
  );

  // Policy gate runs after artifacts are written.
  if (requireRate !== null && resolutionRate < requireRate) {
    console.error(`imports: resolution rate ${resolutionRate.toFixed(4)} < required ${requireRate}`);
    return 1;
  }

  return 0;
}
