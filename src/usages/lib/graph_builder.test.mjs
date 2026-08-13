import { describe, it, expect } from 'vitest';
import { buildGraph } from './graph_builder.mjs';

const use = (fromSymId, toSymId) => ({ fromSymId, toSymId });

describe('buildGraph — nodes, edges, shapes', () => {
  it('emits involved Symbol nodes and a USES edge per record', () => {
    const g = buildGraph({ usages: [use('sym:f.ts#a', 'sym:f.ts#b')] });

    // Both endpoints are re-emitted (synthesized minimally when not injected).
    expect(g.nodes).toContainEqual({
      id: 'sym:f.ts#a', labels: ['Symbol'], properties: { name: 'a', path: 'f.ts' },
    });
    expect(g.nodes).toContainEqual({
      id: 'sym:f.ts#b', labels: ['Symbol'], properties: { name: 'b', path: 'f.ts' },
    });
    expect(g.edges).toContainEqual({
      id: 'edge:sym:f.ts#a:USES:sym:f.ts#b',
      type: 'USES', from: 'sym:f.ts#a', to: 'sym:f.ts#b', properties: {},
    });
  });

  it('reuses injected full Symbol nodes verbatim when provided', () => {
    const full = {
      id: 'sym:a.ts#foo', labels: ['Symbol'],
      properties: { name: 'foo', kind: 'function', exported: true, path: 'a.ts', line: 1 },
    };
    const g = buildGraph({
      usages: [use('sym:b.ts#useFoo', 'sym:a.ts#foo')],
      symbolNodesById: new Map([['sym:a.ts#foo', full]]),
    });
    expect(g.nodes).toContainEqual(full);
  });

  it('counts distinct involved symbols and edges', () => {
    const g = buildGraph({
      usages: [
        use('sym:f.ts#a', 'sym:f.ts#b'),
        use('sym:f.ts#a', 'sym:f.ts#c'),
        use('sym:f.ts#c', 'sym:f.ts#b'),
      ],
    });
    // symbols involved: a, b, c → 3. edges: 3.
    expect(g.counts).toEqual({ symbols: 3, edges: 3 });
  });
});

describe('buildGraph — dedupe & determinism', () => {
  it('dedupes duplicate (from,to) records into one edge', () => {
    const g = buildGraph({
      usages: [use('sym:f.ts#a', 'sym:f.ts#b'), use('sym:f.ts#a', 'sym:f.ts#b')],
    });
    expect(g.edges).toHaveLength(1);
    expect(g.counts.edges).toBe(1);
  });

  it('sorts nodes and edges by id, byte-stable regardless of input order', () => {
    const usages = [
      use('sym:z.ts#a', 'sym:a.ts#b'),
      use('sym:a.ts#b', 'sym:z.ts#a'),
    ];
    const a = buildGraph({ usages });
    const b = buildGraph({ usages: [...usages].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const nodeIds = a.nodes.map((n) => n.id);
    expect(nodeIds).toEqual([...nodeIds].sort());
    const edgeIds = a.edges.map((e) => e.id);
    expect(edgeIds).toEqual([...edgeIds].sort());
  });
});
