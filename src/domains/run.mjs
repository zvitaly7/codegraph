import { join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
/** True when `path` is an existing directory. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Top-level directories the repo actually has, as seen through the inventory. */
function topLevelDirs(repoRoot, relPaths) {
  const seen = new Set();
  for (const p of relPaths) {
    const first = p.split('/')[0];
    if (p.includes('/') && !first.startsWith('.')) seen.add(first);
  }
  return [...seen].sort().slice(0, 8);
}

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

  // Source roots that are not in the repository put every file into the same
  // bucket. The overlay still comes out looking well-formed, so the mismatch has
  // to be said out loud rather than left to be inferred from a flat result.
  const missingRoots = srcRoots.filter((root) => !isDirectory(join(repoRoot, root)));
  if (missingRoots.length === srcRoots.length && srcRoots.length > 0) {
    const candidates = topLevelDirs(repoRoot, relPaths);
    console.error(
      `domains: none of the configured source roots exist here (${srcRoots.join(', ')})`
      + (candidates.length > 0 ? ` — this repo has: ${candidates.join(', ')}` : ''),
    );
    console.error('  set `srcRoots` in loregraph.config.mjs so each product area becomes its own domain');
  }

  // A domain graph with no edges is not a clean bill of health: the files are
  // grouped, but nothing was learned about how the groups relate.
  if (hasImports && counts.dependsOn === 0 && importEdges.length > 0) {
    console.error(
      `domains: no domain depends on another, though ${importEdges.length} internal import(s) exist `
      + '— every one of them stays inside a single domain',
    );
    console.error('  usually `srcRoots` does not match this layout, so the whole repo collapsed into a few buckets');
  }

  return 0;
}
