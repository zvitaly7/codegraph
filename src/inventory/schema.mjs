// Pure, deterministic builders for inventory graph nodes/edges/rows.
// No I/O, no wall-clock, no randomness — identical inputs → identical outputs.

/**
 * Normalize a path to POSIX form:
 *  - backslashes → '/'
 *  - strip trailing '/' (except the root, which is '.')
 *  - empty → '.'
 */
export function normPosix(p) {
  let s = String(p ?? '').replace(/\\/g, '/');
  if (s === '') return '.';
  s = s.replace(/\/+$/, '');
  return s === '' ? '.' : s;
}

function baseName(normalized) {
  if (normalized === '.') return '.';
  const parts = normalized.split('/');
  return parts[parts.length - 1];
}

// ---- IDs ----------------------------------------------------------------

export function projectId(name) {
  return `project:${name}`;
}

export function snapshotId(name, rev) {
  return `snapshot:${name}:${rev || 'no-revision'}`;
}

export function directoryId(p) {
  return `dir:${normPosix(p)}`;
}

export function fileId(p) {
  return `file:${normPosix(p)}`;
}

export function edgeId(type, from, to) {
  return `edge:${from}:${type}:${to}`;
}

// ---- Nodes --------------------------------------------------------------

export function projectNode(id, name, root) {
  return { id, labels: ['Project'], properties: { name, root } };
}

export function snapshotNode(id, projectId, vcsMeta) {
  return {
    id,
    labels: ['Snapshot'],
    properties: {
      projectId,
      revision: vcsMeta.revision,
      branch: vcsMeta.branch,
    },
  };
}

export function directoryNode(relPath) {
  const p = normPosix(relPath);
  const depth = p === '.' ? 0 : p.split('/').length;
  return {
    id: directoryId(p),
    labels: ['Directory'],
    properties: { path: p, name: baseName(p), depth },
  };
}

export function fileNode(relPath, { size }, classification, sha256) {
  const p = normPosix(relPath);
  return {
    id: fileId(p),
    labels: ['File'],
    properties: {
      path: p,
      name: baseName(p),
      extension: classification.extension,
      language: classification.language,
      kind: classification.kind,
      trust: classification.trust,
      sizeBytes: size,
      sha256,
      isBinary: classification.isBinary,
      isGenerated: classification.isGenerated,
    },
  };
}

/** Flat row for files.jsonl — EXACT key order is part of the contract. */
export function fileIndexRow(relPath, { size }, classification, sha256) {
  const p = normPosix(relPath);
  return {
    id: fileId(p),
    path: p,
    language: classification.language,
    kind: classification.kind,
    trust: classification.trust,
    sizeBytes: size,
    sha256,
  };
}

// ---- Edges --------------------------------------------------------------

export function edge(type, from, to, props = {}) {
  return { id: edgeId(type, from, to), type, from, to, properties: props };
}
