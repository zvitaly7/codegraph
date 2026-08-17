// End-to-end behaviour of the two answer knobs, through the real `brief` and
// `impact` builders rather than a hand-written payload: does a compressed
// `--json` answer reconstruct, and does `--max-tokens` actually hold the line?

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrief, fitBrief } from '../brief/lib/brief.mjs';
import { buildImpact, fitImpact } from '../impact/lib/impact.mjs';
import { buildOutline, fitOutline } from '../outline/lib/outline.mjs';
import { loadGraph } from './graph_load.mjs';
import { expandPathGroups } from './path_compress.mjs';
import { approxTokens, BUDGET_MARKER } from './answer_budget.mjs';
import { ANSWER_OPTIONS, COMPRESS_PATHS_DEFAULT, resolveCompressPaths, resolveMaxTokens } from './answer_render.mjs';

/** A deep monorepo-shaped graph: one hub file that everything imports. */
function deepGraph({ leaves = 24 } = {}) {
  const base = 'scenarios/6-mf-ssr/apps/shell/src';
  const hub = `${base}/lib/state.ts`;
  const paths = [hub, 'index.ts'];
  for (let i = 0; i < leaves; i += 1) paths.push(`${base}/features/part-${i}/View.tsx`);

  const nodes = paths.map((path) => ({
    id: `file:${path}`,
    labels: ['File'],
    properties: { path, name: path.split('/').pop(), language: 'TypeScript', kind: 'code', sizeBytes: 100 },
  }));
  nodes.push({
    id: `sym:${hub}#useState`,
    labels: ['Symbol'],
    properties: { name: 'useState', kind: 'function', path: hub, line: 3, exported: true },
  });

  const edges = [{
    id: 'e:declares', type: 'DECLARES', from: `file:${hub}`, to: `sym:${hub}#useState`, properties: {},
  }];
  for (const path of paths) {
    if (path === hub) continue;
    edges.push({
      id: `e:i:${path}`, type: 'IMPORTS', from: `file:${path}`, to: `file:${hub}`, properties: { kind: 'internal' },
    });
    edges.push({
      id: `e:r:${path}`,
      type: 'REFERENCES',
      from: `file:${path}`,
      to: `sym:${hub}#useState`,
      properties: { sameFile: false },
    });
  }
  const cache = mkdtempSync(join(tmpdir(), 'cg-answer-'));
  const writeLayer = (layer, payload) => {
    const dir = join(cache, layer);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nodes.jsonl'), (payload.nodes ?? []).map((n) => JSON.stringify(n)).join('\n'));
    writeFileSync(join(dir, 'edges.jsonl'), (payload.edges ?? []).map((e) => JSON.stringify(e)).join('\n'));
  };
  writeLayer('inventory', { nodes: nodes.filter((n) => n.labels.includes('File')) });
  writeLayer('symbols', { nodes: nodes.filter((n) => n.labels.includes('Symbol')), edges: edges.filter((e) => e.type === 'DECLARES') });
  writeLayer('imports', { edges: edges.filter((e) => e.type === 'IMPORTS') });
  writeLayer('references', { edges: edges.filter((e) => e.type === 'REFERENCES') });
  return { graph: loadGraph(cache), hub, base };
}

describe('flag plumbing', () => {
  it('declares the flags a budget-aware command needs', () => {
    expect(Object.keys(ANSWER_OPTIONS).sort())
      .toEqual(['compress-paths', 'max-tokens', 'no-compress-paths']);
  });

  it('reads --max-tokens, and rejects anything that is not a positive integer', () => {
    expect(resolveMaxTokens({})).toEqual({ value: null });
    expect(resolveMaxTokens({ 'max-tokens': '500' })).toEqual({ value: 500 });
    for (const bad of ['0', '-3', 'lots', '1.5', '']) {
      expect(resolveMaxTokens({ 'max-tokens': bad }).error).toMatch(/positive integer/);
    }
  });

  it('resolves compression flag → config → measured default, in that order', () => {
    expect(resolveCompressPaths({}, {})).toBe(COMPRESS_PATHS_DEFAULT);
    expect(resolveCompressPaths({}, { compressPaths: true })).toBe(true);
    expect(resolveCompressPaths({}, { compressPaths: false })).toBe(false);
    expect(resolveCompressPaths({ 'compress-paths': true }, { compressPaths: false })).toBe(true);
    expect(resolveCompressPaths({ 'no-compress-paths': true }, { compressPaths: true })).toBe(false);
    // The off switch wins over the on switch — the safe way round.
    expect(resolveCompressPaths({ 'compress-paths': true, 'no-compress-paths': true }, {})).toBe(false);
  });
});

describe('compressed --json reconstructs exactly', () => {
  it('a brief blast radius rebuilds from pathPrefix + suffix', () => {
    const { graph, hub } = deepGraph();
    const plain = fitBrief(buildBrief(graph, hub, { limit: 200 }), { mode: 'json' }).payload;
    const packed = fitBrief(buildBrief(graph, hub, { limit: 200 }), { mode: 'json', compress: true }).payload;

    expect(plain.blastRadius.files).toHaveLength(25);
    // The flat list is GONE, not silently partial — a consumer notices at once.
    expect(packed.blastRadius.files).toBeUndefined();
    expect(expandPathGroups(packed.blastRadius.pathGroups).sort())
      .toEqual([...plain.blastRadius.files].sort());
    expect(packed.blastRadius.count).toBe(plain.blastRadius.count);
  });

  it('an impact report rebuilds every compressed list', () => {
    const { graph, hub } = deepGraph();
    const changed = [hub];
    const plain = fitImpact(buildImpact(graph, changed, { limit: 200 }), { mode: 'json' }).payload;
    const packed = fitImpact(buildImpact(graph, changed, { limit: 200 }), { mode: 'json', compress: true }).payload;
    expect(expandPathGroups(packed.blastRadius.pathGroups).sort())
      .toEqual([...plain.blastRadius.files].sort());
  });

  it('a symbol brief rebuilds its referencedBy list', () => {
    const { graph } = deepGraph();
    const plain = fitBrief(buildBrief(graph, 'useState', { limit: 200 }), { mode: 'json' }).payload;
    const packed = fitBrief(buildBrief(graph, 'useState', { limit: 200 }), { mode: 'json', compress: true }).payload;
    expect(expandPathGroups(packed.referencedBy.pathGroups).sort())
      .toEqual([...plain.referencedBy.files].sort());
  });

  it('leaves the answer untouched when compression is off', () => {
    const { graph, hub } = deepGraph();
    const off = fitBrief(buildBrief(graph, hub, { limit: 200 }), { mode: 'json', compress: false }).payload;
    expect(off.blastRadius.pathGroups).toBeUndefined();
    expect(off.blastRadius.files).toHaveLength(25);
  });
});

describe('compressed text names its prefix on every factored line', () => {
  it('prints the prefix once and the suffixes beneath it', () => {
    const { graph, hub, base } = deepGraph();
    const text = fitBrief(buildBrief(graph, hub, { limit: 200 }), { compress: true }).text;
    const factored = text.split('\n').filter((l) => l.trim().startsWith('under '));
    expect(factored.length).toBeGreaterThan(0);
    expect(factored.some((l) => l.includes(`under ${base}/features/`))).toBe(true);
    // Full paths appear only on lines that are NOT prefix lines.
    for (const line of factored) expect(line).not.toContain(`${base}/features/part-0/View.tsx`);
  });

  it('is smaller than the uncompressed rendering on a deep tree', () => {
    const { graph, hub } = deepGraph();
    const plain = fitBrief(buildBrief(graph, hub, { limit: 200 }), { compress: false }).text;
    const packed = fitBrief(buildBrief(graph, hub, { limit: 200 }), { compress: true }).text;
    expect(approxTokens(packed)).toBeLessThan(approxTokens(plain));
  });
});

describe('--max-tokens holds the line', () => {
  const CAPS = [600, 400, 250, 150, 90];

  for (const cap of CAPS) {
    it(`a big brief under --max-tokens ${cap} stays under the cap and says what it cut`, () => {
      const { graph, hub } = deepGraph();
      const fit = fitBrief(buildBrief(graph, hub, { limit: 200 }), { maxTokens: cap });
      expect(fit.approxTokens).toBeLessThanOrEqual(cap);
      expect(fit.text).toContain(BUDGET_MARKER);
      expect(fit.truncated).toBe(true);
    });

    it(`a big impact report under --max-tokens ${cap} stays under the cap`, () => {
      const { graph, hub } = deepGraph();
      const fit = fitImpact(buildImpact(graph, [hub], { limit: 200 }), { maxTokens: cap });
      expect(fit.approxTokens).toBeLessThanOrEqual(cap);
      // Marked if and only if something was actually cut — never a marker on a
      // complete answer, never a silent cut on an incomplete one.
      expect(fit.text.includes(BUDGET_MARKER)).toBe(fit.truncated);
    });
  }

  it('cuts the blast radius before the imports, on a file brief', () => {
    const { graph, hub } = deepGraph();
    const fit = fitBrief(buildBrief(graph, hub, { limit: 200 }), { maxTokens: 400 });
    expect(fit.truncatedSections).toContain('blastRadius');
    expect(fit.truncatedSections).not.toContain('imports');
  });

  it('cuts the blast radius before the tests to run, on an impact report', () => {
    const { graph, hub } = deepGraph();
    const fit = fitImpact(buildImpact(graph, [hub], { limit: 200 }), { maxTokens: 250 });
    expect(fit.truncatedSections).toContain('blastRadius');
    expect(fit.truncatedSections).not.toContain('changedByDomain');
  });

  it('keeps the real count next to the marker, so nothing looks complete', () => {
    const { graph, hub } = deepGraph();
    const fit = fitBrief(buildBrief(graph, hub, { limit: 200 }), { maxTokens: 150 });
    expect(fit.text).toMatch(/blast radius \(25\)/);
  });

  it('truncates the same input identically, every time', () => {
    const runs = Array.from({ length: 5 }, () => {
      const { graph, hub } = deepGraph();
      return fitBrief(buildBrief(graph, hub, { limit: 200 }), { maxTokens: 300 }).text;
    });
    expect(new Set(runs).size).toBe(1);
  });

  it('produces something valid when only the header fits', () => {
    const { graph, hub } = deepGraph();
    const fit = fitBrief(buildBrief(graph, hub, { limit: 200 }), { maxTokens: 5 });
    expect(fit.text.split('\n')[0]).toContain('FILE ');
    expect(fit.text).toContain('OVER --max-tokens=5');
    expect(fit.overBudget).toBe(true);
  });

  it('composes with compression: still under the cap, still reconstructable', () => {
    const { graph, hub } = deepGraph();
    const fit = fitBrief(buildBrief(graph, hub, { limit: 200 }), {
      mode: 'json', compress: true, maxTokens: 400,
    });
    expect(fit.approxTokens).toBeLessThanOrEqual(400);
    const groups = fit.payload.blastRadius.pathGroups;
    if (groups) {
      for (const full of expandPathGroups(groups)) expect(full.startsWith('scenarios/') || full === 'index.ts').toBe(true);
    }
    expect(fit.payload.budget.maxTokens).toBe(400);
    expect(fit.payload.budget.truncated).toBe(true);
  });

  it('reports an impossible cap in the JSON payload, not only in the metadata', () => {
    const { graph, hub } = deepGraph();
    const fit = fitBrief(buildBrief(graph, hub, { limit: 200 }), { mode: 'json', maxTokens: 4 });
    expect(fit.overBudget).toBe(true);
    expect(fit.payload.budget.overBudget).toBe(true);
  });

  it('caps an outline too, cutting imports before declarations', () => {
    const source = ['import a from "./a";', 'import b from "./b";', 'import c from "./c";']
      .concat(Array.from({ length: 40 }, (_, i) => `export function fn${i}(argument${i}: string): void {}`))
      .join('\n');
    const built = buildOutline('src/big.ts', source, { limit: 200 });
    const fit = fitOutline(built, { maxTokens: 200 });
    expect(fit.approxTokens).toBeLessThanOrEqual(200);
    expect(fit.truncatedSections).toContain('imports');
    expect(fit.text).toContain(BUDGET_MARKER);
  });

  it('leaves a small answer completely alone', () => {
    const { graph } = deepGraph({ leaves: 1 });
    const untouched = fitBrief(buildBrief(graph, 'index.ts', { limit: 200 }), {}).text;
    const capped = fitBrief(buildBrief(graph, 'index.ts', { limit: 200 }), { maxTokens: 10_000 }).text;
    expect(capped).toBe(untouched);
    expect(capped).not.toContain(BUDGET_MARKER);
  });
});
