import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../../lib/graph_load.mjs';
import { buildBrief, formatBrief } from './brief.mjs';

function writeLayer(cache, layer, { nodes = [], edges = [] }) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

const file = (path, extra = {}) => ({
  id: `file:${path}`,
  labels: ['File'],
  properties: { path, name: path.split('/').pop(), language: 'TypeScript', kind: 'code', sizeBytes: 100, ...extra },
});
const sym = (path, name, kind, exported, line) => ({
  id: `sym:${path}#${name}`, labels: ['Symbol'], properties: { name, kind, exported, path, line },
});
const decl = (path, name) => ({ id: `edge:file:${path}:DECLARES:sym:${path}#${name}`, type: 'DECLARES', from: `file:${path}`, to: `sym:${path}#${name}`, properties: {} });
const imp = (from, to, kind, specifier) => ({ id: `edge:file:${from}:IMPORTS:${to}`, type: 'IMPORTS', from: `file:${from}`, to, properties: { kind, specifier } });
const ref = (from, symId, sameFile) => ({ id: `edge:file:${from}:REFERENCES:${symId}`, type: 'REFERENCES', from: `file:${from}`, to: symId, properties: { sameFile } });
const uses = (a, b) => ({ id: `edge:${a}:USES:${b}`, type: 'USES', from: a, to: b, properties: {} });
const domain = (id, kind = 'product') => ({ id: `domain:${id}`, labels: ['Domain'], properties: { name: id, kind } });
const belongs = (path, d) => ({ id: `edge:file:${path}:BELONGS_TO:domain:${d}`, type: 'BELONGS_TO', from: `file:${path}`, to: `domain:${d}`, properties: {} });
const dependsOn = (a, b, weight) => ({ id: `edge:domain:${a}:DEPENDS_ON:domain:${b}`, type: 'DEPENDS_ON', from: `domain:${a}`, to: `domain:${b}`, properties: { weight } });

/**
 * Synthetic six-layer graph:
 *   test/pay.test.ts → src/checkout/pay.ts → src/core/index.ts → src/core/util.ts
 *   src/ui/button.tsx → src/core/index.ts
 *   pay.ts also imports the external `react`.
 * Two `Cart.tsx` files exist (in ui/ and checkout/) to exercise ambiguity.
 */
function buildFixture() {
  const cache = mkdtempSync(join(tmpdir(), 'cg-brief-'));
  writeLayer(cache, 'inventory', {
    nodes: [
      file('src/core/util.ts', { sizeBytes: 2048 }),
      file('src/core/index.ts'),
      file('src/checkout/pay.ts'),
      file('src/ui/button.tsx'),
      file('src/ui/Cart.tsx'),
      file('src/checkout/Cart.tsx'),
      file('test/pay.test.ts', { kind: 'test' }),
    ],
  });
  writeLayer(cache, 'imports', {
    nodes: [{ id: 'pkg:react', labels: ['Package'], properties: { name: 'react' } }],
    edges: [
      imp('src/core/index.ts', 'file:src/core/util.ts', 'internal', './util'),
      imp('src/checkout/pay.ts', 'file:src/core/index.ts', 'internal', '../core'),
      imp('src/checkout/pay.ts', 'pkg:react', 'external', 'react'),
      imp('src/ui/button.tsx', 'file:src/core/index.ts', 'internal', '../core'),
      imp('src/ui/button.tsx', 'pkg:react', 'external', 'react'),
      imp('test/pay.test.ts', 'file:src/checkout/pay.ts', 'internal', '../src/checkout/pay'),
    ],
  });
  writeLayer(cache, 'symbols', {
    nodes: [
      sym('src/core/util.ts', 'format', 'function', true, 12),
      sym('src/core/util.ts', 'INTERNAL', 'const', false, 3),
      sym('src/core/index.ts', 'setup', 'function', true, 5),
      sym('src/checkout/pay.ts', 'pay', 'function', true, 9),
    ],
    edges: [
      decl('src/core/util.ts', 'format'),
      decl('src/core/util.ts', 'INTERNAL'),
      decl('src/core/index.ts', 'setup'),
      decl('src/checkout/pay.ts', 'pay'),
    ],
  });
  writeLayer(cache, 'references', {
    edges: [
      ref('src/core/index.ts', 'sym:src/core/util.ts#format', false),
      ref('src/core/util.ts', 'sym:src/core/util.ts#INTERNAL', true),
      ref('src/checkout/pay.ts', 'sym:src/core/index.ts#setup', false),
      ref('src/ui/button.tsx', 'sym:src/core/index.ts#setup', false),
    ],
  });
  writeLayer(cache, 'usages', {
    edges: [
      uses('sym:src/core/index.ts#setup', 'sym:src/core/util.ts#format'),
      uses('sym:src/checkout/pay.ts#pay', 'sym:src/core/index.ts#setup'),
    ],
  });
  writeLayer(cache, 'domains', {
    nodes: [domain('core', 'platform'), domain('checkout'), domain('ui'), domain('test')],
    edges: [
      belongs('src/core/util.ts', 'core'),
      belongs('src/core/index.ts', 'core'),
      belongs('src/checkout/pay.ts', 'checkout'),
      belongs('src/checkout/Cart.tsx', 'checkout'),
      belongs('src/ui/button.tsx', 'ui'),
      belongs('src/ui/Cart.tsx', 'ui'),
      belongs('test/pay.test.ts', 'test'),
      dependsOn('checkout', 'core', 3),
      dependsOn('ui', 'core', 1),
      dependsOn('test', 'checkout', 1),
    ],
  });
  return loadGraph(cache);
}

let g;
beforeEach(() => { g = buildFixture(); });

describe('buildBrief — target resolution', () => {
  it('resolves an exact repo-relative file path', () => {
    expect(buildBrief(g, 'src/core/index.ts').kind).toBe('file');
  });

  it('resolves a unique basename suffix to its file', () => {
    const b = buildBrief(g, 'button.tsx');
    expect(b.kind).toBe('file');
    expect(b.path).toBe('src/ui/button.tsx');
  });

  it('resolves a full node id', () => {
    expect(buildBrief(g, 'file:src/core/util.ts').path).toBe('src/core/util.ts');
    expect(buildBrief(g, 'sym:src/core/util.ts#format').kind).toBe('symbol');
  });

  it('resolves a domain name', () => {
    const b = buildBrief(g, 'core');
    expect(b.kind).toBe('domain');
    expect(b.name).toBe('core');
  });

  it('resolves a symbol name', () => {
    const b = buildBrief(g, 'format');
    expect(b.kind).toBe('symbol');
    expect(b.path).toBe('src/core/util.ts');
  });

  it('reports ambiguity compactly instead of guessing', () => {
    const b = buildBrief(g, 'Cart.tsx');
    expect(b.kind).toBe('ambiguous');
    expect(b.total).toBe(2);
    expect(b.candidates.map((c) => c.id).sort())
      .toEqual(['file:src/checkout/Cart.tsx', 'file:src/ui/Cart.tsx']);
  });

  it('reports not-found with near-miss suggestions', () => {
    const b = buildBrief(g, 'nope-does-not-exist');
    expect(b.kind).toBe('not-found');
    expect(b.candidates).toEqual([]);
  });

  it('suggests substring matches when nothing resolves exactly', () => {
    const b = buildBrief(g, 'chec');
    expect(b.kind).toBe('not-found');
    expect(b.candidates.length).toBeGreaterThan(0);
  });
});

describe('buildBrief — file', () => {
  it('reports domain, imports, importers, symbols and blast radius', () => {
    const b = buildBrief(g, 'src/core/index.ts');
    expect(b).toMatchObject({
      kind: 'file',
      id: 'file:src/core/index.ts',
      path: 'src/core/index.ts',
      language: 'TypeScript',
      fileKind: 'code',
      sizeBytes: 100,
      domain: 'core',
    });
    expect(b.imports.internal).toEqual(['src/core/util.ts']);
    expect(b.imports.external).toEqual([]);
    expect(b.importedBy.count).toBe(2);
    expect(b.importedBy.files).toEqual(['src/checkout/pay.ts', 'src/ui/button.tsx']);
    // Blast radius is transitive: pay.ts + button.tsx + the test that imports pay.ts.
    expect(b.blastRadius.count).toBe(3);
    expect(b.blastRadius.files).toContain('test/pay.test.ts');
  });

  it('lists declared symbols with kind, export flag and cross-file reference counts', () => {
    const b = buildBrief(g, 'src/core/util.ts');
    expect(b.symbols.count).toBe(2);
    const format = b.symbols.list.find((s) => s.name === 'format');
    expect(format).toMatchObject({ kind: 'function', exported: true, line: 12, refs: 1 });
    // INTERNAL is referenced only inside its own file → 0 cross-file refs.
    expect(b.symbols.list.find((s) => s.name === 'INTERNAL')).toMatchObject({ exported: false, refs: 0 });
  });

  it('separates external packages from internal imports', () => {
    const b = buildBrief(g, 'src/checkout/pay.ts');
    expect(b.imports.internal).toEqual(['src/core/index.ts']);
    expect(b.imports.external).toEqual(['react']);
  });

  it('caps lists at --limit and reports the untruncated total', () => {
    const b = buildBrief(g, 'src/core/index.ts', { limit: 1 });
    expect(b.blastRadius.count).toBe(3);
    expect(b.blastRadius.files).toHaveLength(1);
    expect(b.importedBy.files).toHaveLength(1);
    expect(b.importedBy.count).toBe(2);
  });

  it('handles a leaf file with no importers', () => {
    const b = buildBrief(g, 'test/pay.test.ts');
    expect(b.importedBy.count).toBe(0);
    expect(b.blastRadius.count).toBe(0);
    expect(b.fileKind).toBe('test');
  });
});

describe('buildBrief — domain', () => {
  it('reports file count, dependencies, top files and external packages', () => {
    const b = buildBrief(g, 'core');
    expect(b).toMatchObject({ kind: 'domain', id: 'domain:core', name: 'core', domainKind: 'platform' });
    expect(b.files.count).toBe(2);
    expect(b.dependsOn).toEqual([]);
    expect(b.dependedOnBy).toEqual([
      { domain: 'checkout', weight: 3 },
      { domain: 'ui', weight: 1 },
    ]);
    // index.ts is imported by 2 files, util.ts by 1 → ranked by in-degree.
    expect(b.topFiles.map((f) => f.path)).toEqual(['src/core/index.ts', 'src/core/util.ts']);
    expect(b.topFiles[0].importedBy).toBe(2);
  });

  it('ranks the external packages used inside the domain', () => {
    const b = buildBrief(g, 'ui');
    expect(b.packages).toEqual([{ name: 'react', files: 1 }]);
  });
});

describe('buildBrief — symbol', () => {
  it('reports declaration site, export flag, referencing files and usage edges', () => {
    const b = buildBrief(g, 'setup');
    expect(b).toMatchObject({
      kind: 'symbol',
      id: 'sym:src/core/index.ts#setup',
      name: 'setup',
      symbolKind: 'function',
      path: 'src/core/index.ts',
      line: 5,
      exported: true,
      domain: 'core',
    });
    expect(b.referencedBy.count).toBe(2);
    expect(b.referencedBy.files).toEqual(['src/checkout/pay.ts', 'src/ui/button.tsx']);
    expect(b.uses).toEqual(['sym:src/core/util.ts#format']);
    expect(b.usedBy).toEqual(['sym:src/checkout/pay.ts#pay']);
  });

  it('flags an exported symbol nothing references as dead', () => {
    const b = buildBrief(g, 'pay');
    expect(b.referencedBy.count).toBe(0);
    expect(b.dead).toBe(true);
  });
});

describe('formatBrief', () => {
  it('renders a file brief as a short dense block', () => {
    const text = formatBrief(buildBrief(g, 'src/core/index.ts'));
    const lines = text.split('\n');
    expect(lines.length).toBeLessThan(60);
    expect(lines[0]).toContain('src/core/index.ts');
    expect(text).toContain('domain: core');
    expect(text).toContain('src/core/util.ts');
    expect(text).toContain('setup');
  });

  it('renders domain, symbol, ambiguous and not-found briefs', () => {
    expect(formatBrief(buildBrief(g, 'core'))).toContain('DOMAIN core');
    expect(formatBrief(buildBrief(g, 'format'))).toContain('SYMBOL format');
    expect(formatBrief(buildBrief(g, 'Cart.tsx'))).toMatch(/ambiguous/i);
    expect(formatBrief(buildBrief(g, 'zzz'))).toMatch(/no match/i);
  });

  it('marks truncated lists with a (+N more) tail', () => {
    const text = formatBrief(buildBrief(g, 'src/core/index.ts', { limit: 1 }));
    expect(text).toContain('+2 more');
  });
});
