import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../../lib/graph_load.mjs';
import { buildImpact, formatImpact } from './impact.mjs';

function writeLayer(cache, layer, { nodes = [], edges = [] }) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

const file = (path, kind = 'code') => ({
  id: `file:${path}`, labels: ['File'],
  properties: { path, name: path.split('/').pop(), language: 'TypeScript', kind, sizeBytes: 100 },
});
const sym = (path, name, exported, line) => ({
  id: `sym:${path}#${name}`, labels: ['Symbol'],
  properties: { name, kind: 'function', exported, path, line },
});
const decl = (path, name) => ({ id: `edge:file:${path}:DECLARES:sym:${path}#${name}`, type: 'DECLARES', from: `file:${path}`, to: `sym:${path}#${name}`, properties: {} });
const imp = (from, to) => ({ id: `edge:file:${from}:IMPORTS:${to}`, type: 'IMPORTS', from: `file:${from}`, to, properties: { kind: to.startsWith('pkg:') ? 'external' : 'internal' } });
const ref = (from, symId, sameFile) => ({ id: `edge:file:${from}:REFERENCES:${symId}`, type: 'REFERENCES', from: `file:${from}`, to: symId, properties: { sameFile } });
const domain = (id) => ({ id: `domain:${id}`, labels: ['Domain'], properties: { name: id, kind: 'product' } });
const belongs = (path, d) => ({ id: `edge:file:${path}:BELONGS_TO:domain:${d}`, type: 'BELONGS_TO', from: `file:${path}`, to: `domain:${d}`, properties: {} });

/**
 * Synthetic graph:
 *   core/util.ts ← core/index.ts ← checkout/pay.ts ← test/pay.test.ts
 *                               ← ui/button.tsx  ← test/ui.test.ts
 *   test/util.test.ts imports core/util.ts DIRECTLY.
 * So a change to core/util.ts reaches all three test files — one directly,
 * two only transitively.
 */
function buildFixture() {
  const cache = mkdtempSync(join(tmpdir(), 'cg-impact-'));
  writeLayer(cache, 'inventory', {
    nodes: [
      file('src/core/util.ts'),
      file('src/core/index.ts'),
      file('src/checkout/pay.ts'),
      file('src/ui/button.tsx'),
      file('docs/readme.md', 'doc'),
      file('test/pay.test.ts', 'test'),
      file('test/ui.test.ts', 'test'),
      file('test/util.test.ts', 'test'),
    ],
  });
  writeLayer(cache, 'imports', {
    nodes: [{ id: 'pkg:react', labels: ['Package'], properties: { name: 'react' } }],
    edges: [
      imp('src/core/index.ts', 'file:src/core/util.ts'),
      imp('src/checkout/pay.ts', 'file:src/core/index.ts'),
      imp('src/ui/button.tsx', 'file:src/core/index.ts'),
      imp('src/ui/button.tsx', 'pkg:react'),
      imp('test/pay.test.ts', 'file:src/checkout/pay.ts'),
      imp('test/ui.test.ts', 'file:src/ui/button.tsx'),
      imp('test/util.test.ts', 'file:src/core/util.ts'),
    ],
  });
  writeLayer(cache, 'symbols', {
    nodes: [
      sym('src/core/util.ts', 'format', true, 12),
      sym('src/core/util.ts', 'INTERNAL', false, 3),
      sym('src/core/util.ts', 'unusedHelper', true, 30),
      sym('src/core/index.ts', 'setup', true, 5),
    ],
    edges: [
      decl('src/core/util.ts', 'format'),
      decl('src/core/util.ts', 'INTERNAL'),
      decl('src/core/util.ts', 'unusedHelper'),
      decl('src/core/index.ts', 'setup'),
    ],
  });
  writeLayer(cache, 'references', {
    edges: [
      ref('src/core/index.ts', 'sym:src/core/util.ts#format', false),
      ref('test/util.test.ts', 'sym:src/core/util.ts#format', false),
      ref('src/core/util.ts', 'sym:src/core/util.ts#INTERNAL', true),
      ref('src/checkout/pay.ts', 'sym:src/core/index.ts#setup', false),
    ],
  });
  writeLayer(cache, 'domains', {
    nodes: [domain('core'), domain('checkout'), domain('ui'), domain('test')],
    edges: [
      belongs('src/core/util.ts', 'core'),
      belongs('src/core/index.ts', 'core'),
      belongs('src/checkout/pay.ts', 'checkout'),
      belongs('src/ui/button.tsx', 'ui'),
      belongs('test/pay.test.ts', 'test'),
      belongs('test/ui.test.ts', 'test'),
      belongs('test/util.test.ts', 'test'),
    ],
  });
  return loadGraph(cache);
}

let g;
beforeEach(() => { g = buildFixture(); });

describe('buildImpact — changed set', () => {
  it('groups the changed files by domain', () => {
    const r = buildImpact(g, ['src/core/util.ts', 'src/checkout/pay.ts']);
    expect(r.changed.count).toBe(2);
    expect(r.changed.byDomain).toEqual([
      { domain: 'checkout', files: ['src/checkout/pay.ts'] },
      { domain: 'core', files: ['src/core/util.ts'] },
    ]);
  });

  it('flags changed paths the graph has never seen', () => {
    const r = buildImpact(g, ['src/core/util.ts', 'src/brand-new.ts']);
    expect(r.changed.unknown).toEqual(['src/brand-new.ts']);
    expect(r.changed.count).toBe(2);
  });

  it('accepts file: ids as well as bare paths', () => {
    const r = buildImpact(g, ['file:src/core/util.ts']);
    expect(r.changed.unknown).toEqual([]);
    expect(r.changed.files).toEqual(['src/core/util.ts']);
  });

  it('returns an all-empty answer for an empty change set', () => {
    const r = buildImpact(g, []);
    expect(r.changed.count).toBe(0);
    expect(r.blastRadius.count).toBe(0);
    expect(r.domains).toEqual([]);
    expect(r.riskyExports.count).toBe(0);
    expect(r.tests.count).toBe(0);
    expect(r.note).toMatch(/no changed files/i);
  });
});

describe('buildImpact — blast radius', () => {
  it('walks importers transitively and excludes the changed files themselves', () => {
    const r = buildImpact(g, ['src/core/util.ts']);
    expect(r.blastRadius.count).toBe(6);
    expect(r.blastRadius.files).toEqual([
      'src/checkout/pay.ts',
      'src/core/index.ts',
      'src/ui/button.tsx',
      'test/pay.test.ts',
      'test/ui.test.ts',
      'test/util.test.ts',
    ]);
    expect(r.blastRadius.files).not.toContain('src/core/util.ts');
  });

  it('honors maxDepth', () => {
    const r = buildImpact(g, ['src/core/util.ts'], { maxDepth: 1 });
    expect(r.blastRadius.files).toEqual(['src/core/index.ts', 'test/util.test.ts']);
    expect(r.blastRadius.depthCapReached).toBe(true);
  });

  it('caps the printed list at limit but keeps the true count', () => {
    const r = buildImpact(g, ['src/core/util.ts'], { limit: 2 });
    expect(r.blastRadius.count).toBe(6);
    expect(r.blastRadius.files).toHaveLength(2);
  });

  it('unions the radius of several changed files without double counting', () => {
    const r = buildImpact(g, ['src/core/util.ts', 'src/core/index.ts']);
    expect(r.blastRadius.files).not.toContain('src/core/index.ts'); // it is a seed
    expect(r.blastRadius.count).toBe(5);
  });
});

describe('buildImpact — affected domains', () => {
  it('counts impacted files per domain, changed plus radius, ranked', () => {
    const r = buildImpact(g, ['src/core/util.ts']);
    expect(r.domains).toEqual([
      { domain: 'test', files: 3 },
      { domain: 'core', files: 2 },
      { domain: 'checkout', files: 1 },
      { domain: 'ui', files: 1 },
    ]);
  });
});

describe('buildImpact — risky exports', () => {
  it('lists exported symbols of changed files that other files reference', () => {
    const r = buildImpact(g, ['src/core/util.ts']);
    expect(r.riskyExports.count).toBe(1);
    expect(r.riskyExports.list[0]).toMatchObject({
      name: 'format',
      path: 'src/core/util.ts',
      line: 12,
      refs: 2,
    });
    expect(r.riskyExports.list[0].files).toEqual(['src/core/index.ts', 'test/util.test.ts']);
  });

  it('omits unreferenced exports and non-exported symbols', () => {
    const names = buildImpact(g, ['src/core/util.ts']).riskyExports.list.map((s) => s.name);
    expect(names).not.toContain('unusedHelper'); // exported, but nobody references it
    expect(names).not.toContain('INTERNAL');     // referenced, but not exported
  });

  it('ranks by reference count across several changed files', () => {
    const r = buildImpact(g, ['src/core/util.ts', 'src/core/index.ts']);
    expect(r.riskyExports.list.map((s) => `${s.name}:${s.refs}`)).toEqual(['format:2', 'setup:1']);
  });
});

describe('buildImpact — likely tests', () => {
  it('collects test files that reach a changed file directly or transitively', () => {
    const r = buildImpact(g, ['src/core/util.ts']);
    expect(r.tests.count).toBe(3);
    expect(r.tests.files).toEqual(['test/pay.test.ts', 'test/ui.test.ts', 'test/util.test.ts']);
  });

  it('keeps only the tests that actually reach the change', () => {
    const r = buildImpact(g, ['src/ui/button.tsx']);
    expect(r.tests.files).toEqual(['test/ui.test.ts']);
  });

  it('includes a changed file that is itself a test', () => {
    const r = buildImpact(g, ['test/pay.test.ts']);
    expect(r.tests.files).toEqual(['test/pay.test.ts']);
  });

  it('reports no tests when nothing testable is reached', () => {
    expect(buildImpact(g, ['docs/readme.md']).tests.count).toBe(0);
  });
});

describe('formatImpact', () => {
  it('renders a short dense report', () => {
    const text = formatImpact(buildImpact(g, ['src/core/util.ts'], { source: 'diff HEAD' }));
    const lines = text.split('\n');
    expect(lines.length).toBeLessThan(60);
    expect(lines[0]).toContain('IMPACT');
    expect(lines[0]).toContain('diff HEAD');
    expect(text).toContain('core (1)');
    expect(text).toContain('blast radius (6)');
    expect(text).toContain('format');
    expect(text).toContain('test/util.test.ts');
  });

  it('marks truncated lists with a (+N more) tail', () => {
    const text = formatImpact(buildImpact(g, ['src/core/util.ts'], { limit: 2 }));
    expect(text).toContain('+4 more');
  });

  it('renders the empty change set as one line', () => {
    expect(formatImpact(buildImpact(g, []))).toMatch(/no changed files/i);
  });

  it('surfaces unknown paths so a stale cache is visible', () => {
    const text = formatImpact(buildImpact(g, ['src/brand-new.ts']));
    expect(text).toMatch(/not in graph/i);
    expect(text).toContain('src/brand-new.ts');
  });
});
