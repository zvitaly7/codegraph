import { basename, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { resolveConfig } from '../config/load.mjs';
import { collectVcsMetadata } from './vcs/detect.mjs';
import { buildInventoryGraph } from './walker.mjs';
import { writeJsonAtomic, writeJsonlAtomic } from './write.mjs';
import { projectId, snapshotId } from './schema.mjs';

const SCHEMA_VERSION = 1;

/**
 * Layer 1 — inventory. Returns a numeric exit code:
 *   0 success · 1 policy/write failure · 2 usage error.
 */
export async function run(argv) {
  let cfg;
  try {
    cfg = await resolveConfig({
      cwd: process.cwd(),
      argv,
      extraOptions: {
        'no-hash': { type: 'boolean' },
        'require-vcs': { type: 'boolean' },
        'require-clean': { type: 'boolean' },
        'project-name': { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`inventory: usage error: ${err.message}`);
    return 2;
  }

  const { repoRoot, _flags: flags } = cfg;

  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    console.error(`inventory: --repo-root does not exist or is not a directory: ${repoRoot}`);
    return 2;
  }

  const projectName = flags['project-name'] ?? basename(repoRoot);
  const vcsMeta = collectVcsMetadata(repoRoot, cfg.vcs);

  // Policy gates.
  if (flags['require-vcs'] && !vcsMeta.available) {
    console.error('inventory: --require-vcs set, but no VCS metadata is available.');
    return 1;
  }
  if (flags['require-clean'] && vcsMeta.hasLocalChanges === true) {
    console.error('inventory: --require-clean set, but the working tree has local changes.');
    return 1;
  }

  let graph;
  try {
    graph = buildInventoryGraph({
      repoRoot,
      vcsMeta,
      projectName,
      noHash: Boolean(flags['no-hash']),
      ignoreFile: cfg.ignoreFile,
    });
  } catch (err) {
    console.error(`inventory: failed to build graph: ${err.stack || err.message}`);
    return 1;
  }

  const directories = graph.nodes.filter((n) => n.labels.includes('Directory')).length;
  const fileCount = graph.files.length;
  const edgeCount = graph.edges.length;

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repoRoot,
    projectId: projectId(projectName),
    snapshotId: snapshotId(projectName, vcsMeta.revision),
    vcs: vcsMeta.available
      ? {
          type: vcsMeta.type,
          available: true,
          root: vcsMeta.root,
          branch: vcsMeta.branch,
          revision: vcsMeta.revision,
        }
      : { type: vcsMeta.type, available: false, error: vcsMeta.error ?? null },
    counts: {
      projects: 1,
      snapshots: 1,
      directories,
      files: fileCount,
      edges: edgeCount,
    },
  };

  const outBase = join(cfg.outDir, 'inventory');
  try {
    writeJsonlAtomic(join(outBase, 'nodes.jsonl'), graph.nodes);
    writeJsonlAtomic(join(outBase, 'edges.jsonl'), graph.edges);
    writeJsonlAtomic(join(outBase, 'files.jsonl'), graph.files);
    writeJsonAtomic(join(outBase, 'manifest.json'), manifest);
  } catch (err) {
    console.error(`inventory: failed to write artifacts: ${err.message}`);
    return 1;
  }

  const vcsLabel = vcsMeta.available ? `${vcsMeta.type}@${vcsMeta.revision.slice(0, 12)}` : 'no-vcs';
  console.log(
    `inventory: ${projectName} [${vcsLabel}] — ${directories} dirs, ${fileCount} files, ${edgeCount} edges → ${outBase}`,
  );
  return 0;
}
