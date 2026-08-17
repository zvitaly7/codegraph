import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../../lib/graph_load.mjs';
import { collectTargets, kindsForScope, contentHashOf, SCOPES } from './targets.mjs';

const CART_SRC = `import { total } from './total';

/** Renders the cart screen. */
export function Cart(props) {
  const secretBodyMarker = 'DO-NOT-LEAK';
  return secretBodyMarker + total(props);
}
`;

const edge = (type, from, to, properties = {}) => ({ id: `edge:${from}:${type}:${to}`, type, from, to, properties });
const fileNode = (path, over = {}) => ({
  id: `file:${path}`,
  labels: ['File'],
  properties: {
    path, name: path.split('/').pop(), language: 'TypeScript', kind: 'code', sizeBytes: 10, sha256: `sha-${path}`, ...over,
  },
});
const symNode = (path, name, over = {}) => ({
  id: `sym:${path}#${name}`,
  labels: ['Symbol'],
  properties: { name, path, kind: 'function', exported: true, line: 4, ...over },
});

function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

/** cart domain (2 files) + util domain (1 file); Cart.tsx imports total.ts. */
function seed() {
  const repo = mkdtempSync(join(tmpdir(), 'lg-desc-targets-repo-'));
  mkdirSync(join(repo, 'src', 'cart'), { recursive: true });
  mkdirSync(join(repo, 'src', 'util'), { recursive: true });
  writeFileSync(join(repo, 'src', 'cart', 'Cart.tsx'), CART_SRC);
  writeFileSync(join(repo, 'src', 'cart', 'total.ts'), 'export function total(p) { return 1; }\n');
  writeFileSync(join(repo, 'src', 'util', 'fmt.ts'), 'export const fmt = 1;\n');

  const cache = mkdtempSync(join(tmpdir(), 'lg-desc-targets-cache-'));
  writeLayer(cache, 'inventory', {
    nodes: [fileNode('src/cart/Cart.tsx'), fileNode('src/cart/total.ts'), fileNode('src/util/fmt.ts')],
  });
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({ repoRoot: repo }));
  writeLayer(cache, 'imports', {
    nodes: [{ id: 'pkg:react', labels: ['Package'], properties: { name: 'react' } }],
    edges: [
      edge('IMPORTS', 'file:src/cart/Cart.tsx', 'file:src/cart/total.ts', { kind: 'internal' }),
      edge('IMPORTS', 'file:src/cart/Cart.tsx', 'pkg:react', { kind: 'external' }),
      edge('IMPORTS', 'file:src/util/fmt.ts', 'file:src/cart/total.ts', { kind: 'internal' }),
    ],
  });
  writeLayer(cache, 'symbols', {
    nodes: [symNode('src/cart/Cart.tsx', 'Cart'), symNode('src/cart/total.ts', 'total')],
    edges: [
      edge('DECLARES', 'file:src/cart/Cart.tsx', 'sym:src/cart/Cart.tsx#Cart'),
      edge('DECLARES', 'file:src/cart/total.ts', 'sym:src/cart/total.ts#total'),
    ],
  });
  writeLayer(cache, 'references', {
    edges: [
      edge('REFERENCES', 'file:src/cart/Cart.tsx', 'sym:src/cart/total.ts#total', { sameFile: false }),
      edge('REFERENCES', 'file:src/util/fmt.ts', 'sym:src/cart/total.ts#total', { sameFile: false }),
    ],
  });
  writeLayer(cache, 'domains', {
    nodes: [
      { id: 'domain:cart', labels: ['Domain'], properties: { name: 'cart', kind: 'product' } },
      { id: 'domain:util', labels: ['Domain'], properties: { name: 'util', kind: 'platform' } },
    ],
    edges: [
      edge('BELONGS_TO', 'file:src/cart/Cart.tsx', 'domain:cart'),
      edge('BELONGS_TO', 'file:src/cart/total.ts', 'domain:cart'),
      edge('BELONGS_TO', 'file:src/util/fmt.ts', 'domain:util'),
      edge('DEPENDS_ON', 'domain:util', 'domain:cart', { weight: 1 }),
    ],
  });
  return { repo, cache, graph: loadGraph(cache) };
}

let seeded;
beforeEach(() => { seeded = seed(); });

describe('collectTargets', () => {
  it('defaults to domains, ranked by file count', () => {
    const { targets, totals } = collectTargets(seeded.graph, { repoRoot: seeded.repo });
    expect(totals).toEqual({ domain: 2 });
    expect(targets.map((t) => t.id)).toEqual(['domain:cart', 'domain:util']);
    expect(targets[0]).toMatchObject({ kind: 'domain', name: 'cart', rank: 2 });
    expect(targets[0].facts).toMatchObject({ files: 2, domainKind: 'product' });
    expect(targets[0].facts.dependedOnBy).toEqual([{ name: 'util', n: 1 }]);
    expect(targets[0].facts.packages).toEqual([{ name: 'react', n: 1 }]);
  });

  it('ranks files by importer count and attaches an outline, never a body', () => {
    const { targets } = collectTargets(seeded.graph, { scope: 'files', repoRoot: seeded.repo });
    expect(targets[0].id).toBe('file:src/cart/total.ts'); // 2 importers
    const cart = targets.find((t) => t.id === 'file:src/cart/Cart.tsx');
    expect(cart.facts.imports.external).toEqual(['react']);
    expect(cart.facts.domain).toBe('cart');
    expect(cart.outline.declarations.list.map((d) => d.name)).toContain('Cart');
    expect(JSON.stringify(cart.outline)).not.toContain('DO-NOT-LEAK');
  });

  it('ranks symbols by cross-file reference count and carries just their declaration', () => {
    const { targets } = collectTargets(seeded.graph, { scope: 'symbols', repoRoot: seeded.repo });
    expect(targets[0].id).toBe('sym:src/cart/total.ts#total');
    expect(targets[0].facts.referencedBy.count).toBe(2);
    const cart = targets.find((t) => t.name === 'Cart');
    expect(cart.outline.declarations.list).toHaveLength(1);
    expect(cart.outline.declarations.list[0].name).toBe('Cart');
  });

  it('--scope all covers every kind and --top caps each kind separately', () => {
    const { targets, totals } = collectTargets(seeded.graph, { scope: 'all', top: 1, repoRoot: seeded.repo });
    expect(totals).toEqual({ domain: 2, file: 3, symbol: 2 });
    expect(targets.map((t) => t.kind)).toEqual(['domain', 'file', 'symbol']);
  });

  it('gives each target a content hash that changes only when its material changes', () => {
    const first = collectTargets(seeded.graph, { scope: 'files', repoRoot: seeded.repo });
    const again = collectTargets(seeded.graph, { scope: 'files', repoRoot: seeded.repo });
    const hash = (r, id) => r.targets.find((t) => t.id === id).contentHash;
    expect(hash(again, 'file:src/cart/Cart.tsx')).toBe(hash(first, 'file:src/cart/Cart.tsx'));

    // Same graph, different file content hash → a different target hash.
    const nodes = [
      fileNode('src/cart/Cart.tsx', { sha256: 'CHANGED' }),
      fileNode('src/cart/total.ts'),
      fileNode('src/util/fmt.ts'),
    ];
    writeLayer(seeded.cache, 'inventory', { nodes });
    writeFileSync(join(seeded.cache, 'inventory', 'manifest.json'), JSON.stringify({ repoRoot: seeded.repo }));
    const changed = collectTargets(loadGraph(seeded.cache), { scope: 'files', repoRoot: seeded.repo });
    expect(hash(changed, 'file:src/cart/Cart.tsx')).not.toBe(hash(first, 'file:src/cart/Cart.tsx'));
    expect(hash(changed, 'file:src/util/fmt.ts')).toBe(hash(first, 'file:src/util/fmt.ts'));
  });

  it('a domain re-hashes when one of its files changes, and its neighbours do not', () => {
    const before = collectTargets(seeded.graph, { repoRoot: seeded.repo }).targets;
    writeLayer(seeded.cache, 'inventory', {
      nodes: [
        fileNode('src/cart/Cart.tsx', { sha256: 'CHANGED' }),
        fileNode('src/cart/total.ts'),
        fileNode('src/util/fmt.ts'),
      ],
    });
    writeFileSync(join(seeded.cache, 'inventory', 'manifest.json'), JSON.stringify({ repoRoot: seeded.repo }));
    const after = collectTargets(loadGraph(seeded.cache), { repoRoot: seeded.repo }).targets;
    const h = (list, id) => list.find((t) => t.id === id).contentHash;
    expect(h(after, 'domain:cart')).not.toBe(h(before, 'domain:cart'));
    expect(h(after, 'domain:util')).toBe(h(before, 'domain:util'));
  });

  it('still works without a repo root (no outline, graph hashes only)', () => {
    const { targets } = collectTargets(seeded.graph, { scope: 'files' });
    expect(targets).toHaveLength(3);
    expect(targets[0].outline).toBeNull();
    expect(targets[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('kindsForScope maps every documented scope and rejects unknown ones', () => {
    expect(SCOPES).toEqual(['domains', 'files', 'symbols', 'all']);
    expect(kindsForScope('domains')).toEqual(['domain']);
    expect(kindsForScope('all')).toEqual(['domain', 'file', 'symbol']);
    expect(kindsForScope('nope')).toBeNull();
  });

  it('contentHashOf is insensitive to key order', () => {
    const a = contentHashOf({ kind: 'file', id: 'x', facts: { a: 1, b: 2 }, sources: [['p', 'h']] });
    const b = contentHashOf({ kind: 'file', id: 'x', facts: { b: 2, a: 1 }, sources: [['p', 'h']] });
    expect(a).toBe(b);
  });
});
