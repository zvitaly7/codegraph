import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from '../inventory/write.mjs';
import { normPosix } from '../inventory/schema.mjs';
import { readInventoryManifest } from '../lib/inventory_reader.mjs';
import { loadDomainsConfig } from './config.mjs';
import { assignDomain } from './lib/assign.mjs';
import { buildGraph } from './lib/graph_builder.mjs';

const SCHEMA_VERSION = 1;

/** Read every row of a .jsonl file (blank lines skipped). */
function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Layer 3 — domains. A semantic overlay assigning every inventory file to a
 * product/infra domain, with a zero-config auto-derive default and an optional
 * user override. Emits Domain nodes, BELONGS_TO (File→Domain) edges, and — when
 * the imports layer is available — aggregated DEPENDS_ON (Domain→Domain) edges.
 * Returns a numeric exit code:
 *   0 success · 1 write failure · 2 usage / missing inventory.
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
        imports: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`domains: usage error: ${err.message}`);
    return 2;
  }

  const { repoRoot, outDir, srcRoots, _flags: flags } = cfg;

  const inventoryDir = flags.inventory ? resolve(cwd, flags.inventory) : join(outDir, 'inventory');
  if (!existsSync(join(inventoryDir, 'manifest.json'))) {
    console.error(`domains: no inventory found at ${inventoryDir} — run \`loregraph inventory\` first`);
    return 2;
  }

  let invManifest;
  let relPaths;
  try {
    invManifest = readInventoryManifest(inventoryDir);
    // The overlay classifies EVERY inventory file, not just analyzable sources,
    // so read files.jsonl directly rather than the source-filtered reader.
    relPaths = [...new Set(readJsonl(join(inventoryDir, 'files.jsonl')).map((r) => normPosix(r.path)))]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (err) {
    console.error(`domains: failed to read inventory at ${inventoryDir}: ${err.message}`);
    return 2;
  }

  // Imports are optional: absent → Domain + BELONGS_TO only, no DEPENDS_ON.
  const importsDir = flags.imports ? resolve(cwd, flags.imports) : join(outDir, 'imports');
  const importsEdgesPath = join(importsDir, 'edges.jsonl');
  const hasImports = existsSync(importsEdgesPath);
  let importEdges = [];
  if (hasImports) {
    try {
      importEdges = readJsonl(importsEdgesPath)
        .filter((e) => e.type === 'IMPORTS'
          && e.properties?.kind === 'internal'
          && typeof e.from === 'string' && e.from.startsWith('file:')
          && typeof e.to === 'string' && e.to.startsWith('file:'))
        .map((e) => ({ fromPath: e.from.slice('file:'.length), toPath: e.to.slice('file:'.length) }));
    } catch (err) {
      console.error(`domains: failed to read imports at ${importsDir}: ${err.message}`);
      return 2;
    }
  }

  let domainsConfig;
  try {
    domainsConfig = await loadDomainsConfig({ cfg, repoRoot, relPaths });
  } catch (err) {
    console.error(`domains: failed to load domains config: ${err.message}`);
    return 2;
  }

  const files = relPaths.map((path) => ({ path, domain: assignDomain(path, domainsConfig, { srcRoots }) }));

  const { nodes, edges, counts } = buildGraph({ domainsConfig, files, importEdges });

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    basedOnSnapshot: invManifest?.snapshotId ?? 'unknown',
    mode: domainsConfig.mode,
    counts,
  };

  const outBase = join(outDir, 'domains');
  try {
    writeJsonlAtomic(join(outBase, 'nodes.jsonl'), nodes);
    writeJsonlAtomic(join(outBase, 'edges.jsonl'), edges);
    writeJsonAtomic(join(outBase, 'manifest.json'), manifest);
  } catch (err) {
    console.error(`domains: failed to write artifacts: ${err.message}`);
    return 1;
  }

  console.log(
    `[loregraph] mode=${domainsConfig.mode} domains=${counts.domains} files=${counts.files} `
    + `belongsTo=${counts.belongsTo} dependsOn=${counts.dependsOn} out=${outBase}`,
  );
  if (!hasImports) {
    console.log('[loregraph] no imports artifact found — emitted Domain + BELONGS_TO only (no DEPENDS_ON)');
  }

  return 0;
}
