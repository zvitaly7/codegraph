import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from '../inventory/write.mjs';
import { normPosix } from '../inventory/schema.mjs';
import { readInventorySources, readInventoryManifest } from '../lib/inventory_reader.mjs';
import { extractSymbols } from './lib/symbol_extractor.mjs';
import { buildGraph } from './lib/graph_builder.mjs';

const SCHEMA_VERSION = 1;

/**
 * Layer 2b — symbols. Reads the Layer-1 inventory and emits a file→symbol
 * DECLARES graph (top-level declarations per source, parse-only AST). Returns a
 * numeric exit code:
 *   0 success · 1 write failure · 2 usage error.
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
        'max-files': { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`symbols: usage error: ${err.message}`);
    return 2;
  }

  const { repoRoot, outDir, _flags: flags } = cfg;

  let maxFiles = null;
  if (flags['max-files'] !== undefined) {
    maxFiles = Number(flags['max-files']);
    if (!Number.isInteger(maxFiles) || maxFiles < 0) {
      console.error(`symbols: --max-files must be a non-negative integer, got ${flags['max-files']}`);
      return 2;
    }
  }

  const inventoryDir = flags.inventory ? resolve(cwd, flags.inventory) : join(outDir, 'inventory');
  if (!existsSync(join(inventoryDir, 'manifest.json'))) {
    console.error(`symbols: no inventory found at ${inventoryDir} — run \`loregraph inventory\` first`);
    return 2;
  }

  let invManifest;
  let sources;
  try {
    invManifest = readInventoryManifest(inventoryDir);
    sources = readInventorySources(inventoryDir);
  } catch (err) {
    console.error(`symbols: failed to read inventory at ${inventoryDir}: ${err.message}`);
    return 2;
  }

  // Deterministic order, then optional cap.
  sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (maxFiles !== null) sources = sources.slice(0, maxFiles);

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
    // Pass the repo-relative path so the TS parser picks the right script kind.
    files.push({ path, symbols: extractSymbols(path, text) });
  }

  const { nodes, edges, counts } = buildGraph({ files });

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    basedOnSnapshot: invManifest?.snapshotId ?? 'unknown',
    counts,
  };

  const outBase = join(outDir, 'symbols');
  try {
    writeJsonlAtomic(join(outBase, 'nodes.jsonl'), nodes);
    writeJsonlAtomic(join(outBase, 'edges.jsonl'), edges);
    writeJsonAtomic(join(outBase, 'manifest.json'), manifest);
  } catch (err) {
    console.error(`symbols: failed to write artifacts: ${err.message}`);
    return 1;
  }

  console.log(
    `[loregraph] sources=${counts.files} symbols=${counts.symbols} `
    + `exported=${counts.exported} edges=${counts.edges} out=${outBase}`,
  );

  return 0;
}
