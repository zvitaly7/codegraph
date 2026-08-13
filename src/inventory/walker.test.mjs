import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInventoryGraph } from './walker.mjs';

const VCS = { type: 'none', available: false, revision: 'rev1', branch: 'main' };
let repo;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'cg-walk-'));
  const f = (rel, content = '') => writeFileSync(join(repo, rel), content);
  const d = (rel) => mkdirSync(join(repo, rel), { recursive: true });

  f('.gitignore', 'ignored-file.txt\n');
  f('README.md', '# hi\n');
  f('package.json', '{"name":"demo"}');
  d('src');
  f('src/index.ts', 'export const x = 1;\n');
  f('src/index.test.ts', 'test?\n');
  // hard-skip dirs
  d('node_modules/dep');
  f('node_modules/dep/index.js', 'module.exports = {}');
  d('.git');
  f('.git/config', '[core]');
  d('.kg-cache');
  f('.kg-cache/nodes.jsonl', '{}');
  // security skips
  f('secret.key', 'PRIVATE');
  f('id_rsa', 'PRIVATE');
  f('.env.production', 'TOKEN=x');
  // security keeps
  f('.env.sample', 'TOKEN=');
  f('key.pub', 'ssh-rsa AAAA');
  f('fullchain.pem', '-----BEGIN CERT-----');
  // gitignored
  f('ignored-file.txt', 'nope');
  // symlink
  symlinkSync('README.md', join(repo, 'link.md'));
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

function paths(graph) {
  return graph.files.map((r) => r.path).sort();
}

describe('buildInventoryGraph', () => {
  it('indexes expected files and applies every skip rule', () => {
    const g = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo' });
    const p = paths(g);
    // kept
    expect(p).toContain('README.md');
    expect(p).toContain('package.json');
    expect(p).toContain('src/index.ts');
    expect(p).toContain('src/index.test.ts');
    expect(p).toContain('.env.sample');
    expect(p).toContain('key.pub');
    expect(p).toContain('fullchain.pem');
    expect(p).toContain('link.md');
    // skipped
    expect(p).not.toContain('secret.key');
    expect(p).not.toContain('id_rsa');
    expect(p).not.toContain('.env.production');
    expect(p).not.toContain('ignored-file.txt');
  });

  it('no-leak: never emits node_modules / .git / .kg-cache', () => {
    const g = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo' });
    const blob = JSON.stringify(g);
    expect(/node_modules/.test(blob)).toBe(false);
    expect(/\.kg-cache/.test(blob)).toBe(false);
    expect(g.nodes.some((n) => n.properties.path === '.git')).toBe(false);
    for (const r of g.files) {
      expect(r.path).not.toMatch(/node_modules|\.git\/|\.kg-cache/);
    }
  });

  it('count invariant: nodes = 2 + dirs + files; edges = 1 + (dirs + files)', () => {
    const g = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo' });
    const dirs = g.nodes.filter((n) => n.labels.includes('Directory')).length;
    const fileNodes = g.nodes.filter((n) => n.labels.includes('File')).length;
    expect(fileNodes).toBe(g.files.length);
    expect(g.nodes.length).toBe(2 + dirs + fileNodes);
    expect(g.edges.length).toBe(1 + dirs + fileNodes);
    // exactly one CAPTURES, rest CONTAINS
    expect(g.edges.filter((e) => e.type === 'CAPTURES')).toHaveLength(1);
    expect(g.edges.filter((e) => e.type === 'CONTAINS')).toHaveLength(dirs + fileNodes);
  });

  it('root directory node exists and is contained by the snapshot', () => {
    const g = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo' });
    const root = g.nodes.find((n) => n.id === 'dir:.');
    expect(root.properties).toEqual({ path: '.', name: '.', depth: 0 });
    const sId = 'snapshot:demo:rev1';
    expect(g.edges.some((e) => e.type === 'CONTAINS' && e.from === sId && e.to === 'dir:.')).toBe(true);
    expect(g.edges.some((e) => e.type === 'CAPTURES' && e.from === sId && e.to === 'project:demo')).toBe(true);
  });

  it('is deterministic (byte-identical content across runs)', () => {
    const a = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo' });
    const b = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo' });
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
    expect(JSON.stringify(a.edges)).toBe(JSON.stringify(b.edges));
    expect(JSON.stringify(a.files)).toBe(JSON.stringify(b.files));
  });

  it('symlink: hashError on the node only, sha null, row has no hashError', () => {
    const g = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo' });
    const node = g.nodes.find((n) => n.id === 'file:link.md');
    expect(node.properties.hashError).toBe('skipped: symlink (target not hashed)');
    expect(node.properties.sha256).toBeNull();
    const row = g.files.find((r) => r.id === 'file:link.md');
    expect(row).not.toHaveProperty('hashError');
    expect(Object.keys(row)).toEqual(['id', 'path', 'language', 'kind', 'trust', 'sizeBytes', 'sha256']);
  });

  it('real files get a sha256 and no hashError property', () => {
    const g = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo' });
    const node = g.nodes.find((n) => n.id === 'file:README.md');
    expect(node.properties.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(node.properties).not.toHaveProperty('hashError');
  });

  it('noHash: every file node marked skipped, never sets hashError:null', () => {
    const g = buildInventoryGraph({ repoRoot: repo, vcsMeta: VCS, projectName: 'demo', noHash: true });
    for (const n of g.nodes.filter((x) => x.labels.includes('File'))) {
      expect(n.properties.sha256).toBeNull();
      // symlink keeps its specific message; others are 'skipped'
      expect(['skipped', 'skipped: symlink (target not hashed)']).toContain(n.properties.hashError);
    }
    // invariant: hashError is never literally null on any node
    const blob = JSON.stringify(g.nodes);
    expect(blob.includes('"hashError":null')).toBe(false);
  });
});
