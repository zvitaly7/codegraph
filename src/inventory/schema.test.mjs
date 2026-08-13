import { describe, it, expect } from 'vitest';
import {
  normPosix, projectId, snapshotId, directoryId, fileId, edgeId,
  projectNode, snapshotNode, directoryNode, fileNode, fileIndexRow, edge,
} from './schema.mjs';

describe('normPosix', () => {
  it('normalizes backslashes, trailing slashes and empties', () => {
    expect(normPosix('a\\b\\c')).toBe('a/b/c');
    expect(normPosix('src/foo/')).toBe('src/foo');
    expect(normPosix('src/foo///')).toBe('src/foo');
    expect(normPosix('')).toBe('.');
    expect(normPosix('.')).toBe('.');
    expect(normPosix('/')).toBe('.');
  });
});

describe('ids', () => {
  it('builds stable ids', () => {
    expect(projectId('demo')).toBe('project:demo');
    expect(snapshotId('demo', 'abc')).toBe('snapshot:demo:abc');
    expect(directoryId('src\\a/')).toBe('dir:src/a');
    expect(fileId('src/a.js')).toBe('file:src/a.js');
    expect(edgeId('CONTAINS', 'dir:.', 'file:a.js')).toBe('edge:dir:.:CONTAINS:file:a.js');
  });

  it('snapshotId falls back to no-revision', () => {
    expect(snapshotId('demo', '')).toBe('snapshot:demo:no-revision');
    expect(snapshotId('demo', null)).toBe('snapshot:demo:no-revision');
    expect(snapshotId('demo', undefined)).toBe('snapshot:demo:no-revision');
  });
});

describe('nodes', () => {
  it('projectNode', () => {
    expect(projectNode('project:demo', 'demo', '/abs')).toEqual({
      id: 'project:demo', labels: ['Project'], properties: { name: 'demo', root: '/abs' },
    });
  });

  it('snapshotNode carries no wall-clock', () => {
    const n = snapshotNode('snapshot:demo:r1', 'project:demo', { revision: 'r1', branch: 'main' });
    expect(n).toEqual({
      id: 'snapshot:demo:r1', labels: ['Snapshot'],
      properties: { projectId: 'project:demo', revision: 'r1', branch: 'main' },
    });
    expect(JSON.stringify(n)).not.toMatch(/\d{4}-\d\d-\d\dT/); // no ISO timestamp
  });

  it('directoryNode depth: root is 0, segments otherwise', () => {
    expect(directoryNode('.').properties).toEqual({ path: '.', name: '.', depth: 0 });
    expect(directoryNode('src').properties).toEqual({ path: 'src', name: 'src', depth: 1 });
    expect(directoryNode('src/a/b').properties).toEqual({ path: 'src/a/b', name: 'b', depth: 3 });
  });

  it('fileNode composes classification + size + sha', () => {
    const cls = { extension: '.js', language: 'JavaScript', kind: 'code', trust: 'code', isBinary: false, isGenerated: false };
    const n = fileNode('src/a.js', { size: 12 }, cls, 'deadbeef');
    expect(n.id).toBe('file:src/a.js');
    expect(n.labels).toEqual(['File']);
    expect(n.properties).toEqual({
      path: 'src/a.js', name: 'a.js', extension: '.js', language: 'JavaScript',
      kind: 'code', trust: 'code', sizeBytes: 12, sha256: 'deadbeef',
      isBinary: false, isGenerated: false,
    });
  });
});

describe('fileIndexRow', () => {
  it('has EXACT key order', () => {
    const cls = { extension: '.js', language: 'JavaScript', kind: 'code', trust: 'code', isBinary: false, isGenerated: false };
    const row = fileIndexRow('src/a.js', { size: 12 }, cls, 'deadbeef');
    expect(Object.keys(row)).toEqual(['id', 'path', 'language', 'kind', 'trust', 'sizeBytes', 'sha256']);
    expect(row).toEqual({
      id: 'file:src/a.js', path: 'src/a.js', language: 'JavaScript',
      kind: 'code', trust: 'code', sizeBytes: 12, sha256: 'deadbeef',
    });
  });

  it('never carries hashError', () => {
    const cls = { extension: '.js', language: 'JavaScript', kind: 'code', trust: 'code', isBinary: false, isGenerated: false };
    const row = fileIndexRow('a.js', { size: 0 }, cls, null);
    expect(row).not.toHaveProperty('hashError');
  });
});

describe('edge', () => {
  it('builds an edge with derived id', () => {
    expect(edge('CONTAINS', 'dir:.', 'file:a.js')).toEqual({
      id: 'edge:dir:.:CONTAINS:file:a.js', type: 'CONTAINS',
      from: 'dir:.', to: 'file:a.js', properties: {},
    });
  });
});
