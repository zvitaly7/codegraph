import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { IgnoreRules } from './ignore.mjs';
import { classify } from './classify.mjs';
import { hashFile } from './hasher.mjs';
import {
  projectId, snapshotId,
  projectNode, snapshotNode, directoryNode, fileNode, fileIndexRow, edge,
} from './schema.mjs';

/**
 * Walk the repo depth-first and build the inventory graph.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot            absolute path to the repo root
 * @param {object} opts.vcsMeta             VCS metadata (provides revision/branch)
 * @param {string} opts.projectName
 * @param {boolean} [opts.noHash=false]     skip content hashing
 * @param {string} [opts.ignoreFile='.gitignore']
 * @param {IgnoreRules} [opts.ignoreRules]  injected rules (mainly for tests)
 * @returns {{ nodes: object[], edges: object[], files: object[] }}
 */
export function buildInventoryGraph({
  repoRoot, vcsMeta, projectName, noHash = false, ignoreFile = '.gitignore', ignoreRules,
} = {}) {
  const rules = ignoreRules ?? IgnoreRules.fromRepo(repoRoot, { ignoreFile });

  const pId = projectId(projectName);
  const sId = snapshotId(projectName, vcsMeta.revision);

  const nodes = [];
  const edges = [];
  const files = [];

  nodes.push(projectNode(pId, projectName, repoRoot));
  nodes.push(snapshotNode(sId, pId, vcsMeta));
  edges.push(edge('CAPTURES', sId, pId));

  const addFile = (absPath, relPath, parentDirId, dirent) => {
    let size = 0;
    let statError = null;
    let isSymlink = dirent.isSymbolicLink();
    try {
      const st = lstatSync(absPath);
      size = st.size;
      if (st.isSymbolicLink()) isSymlink = true;
    } catch (err) {
      statError = err && err.message ? err.message : String(err);
    }

    let sha256 = null;
    let hashError = null;
    if (isSymlink) {
      hashError = 'skipped: symlink (target not hashed)';
    } else if (noHash) {
      hashError = 'skipped';
    } else {
      const r = hashFile(absPath);
      sha256 = r.sha256;
      hashError = r.hashError;
    }

    const classification = classify(relPath);
    const node = fileNode(relPath, { size }, classification, sha256);
    if (hashError != null) node.properties.hashError = hashError;
    if (statError != null) node.properties.statError = statError;

    nodes.push(node);
    edges.push(edge('CONTAINS', parentDirId, node.id));
    files.push(fileIndexRow(relPath, { size }, classification, sha256));
  };

  const walkDir = (absDir, relDir, containerId) => {
    const dirNode = directoryNode(relDir);
    nodes.push(dirNode);
    edges.push(edge('CONTAINS', containerId, dirNode.id));

    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory → no children
    }

    const sorted = entries
      .map((dirent) => ({ dirent, fsName: dirent.name, name: dirent.name.normalize('NFC') }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const { dirent, fsName, name } of sorted) {
      const childRel = relDir === '.' ? name : `${relDir}/${name}`;
      const childAbs = join(absDir, fsName);
      const isDir = dirent.isDirectory();
      if (rules.shouldSkip(childRel, isDir)) continue;
      if (isDir) {
        walkDir(childAbs, childRel, dirNode.id);
      } else {
        addFile(childAbs, childRel, dirNode.id, dirent);
      }
    }
  };

  walkDir(repoRoot, '.', sId);

  return { nodes, edges, files };
}
