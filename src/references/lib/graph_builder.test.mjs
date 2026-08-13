import { describe, it, expect } from 'vitest';
import { buildGraph } from './graph_builder.mjs';

const ref = (fromPath, symId, sameFile) => ({ fromPath, symId, sameFile });

describe('buildGraph — nodes, edges, shapes', () => {
  it('emits referencing File nodes, referenced Symbol nodes and REFERENCES edges', () => {
    const g = buildGraph({
      references: [ref('b.ts', 'sym:a.ts#foo', false)],
    });

    expect(g.nodes).toContainEqual({ id: 'file:b.ts', labels: ['File'], properties: { path: 'b.ts' } });
    // With no injected symbol node, a minimal Symbol node is synthesized from the id.
    expect(g.nodes).toContainEqual({
      id: 'sym:a.ts#foo',
      labels: ['Symbol'],
      properties: { name: 'foo', path: 'a.ts' },
    });
    expect(g.edges).toContainEqual({
      id: 'edge:file:b.ts:REFERENCES:sym:a.ts#foo',
      type: 'REFERENCES', from: 'file:b.ts', to: 'sym:a.ts#foo',
      properties: { sameFile: false },
    });
  });

  it('carries the sameFile flag on the edge', () => {
    const g = buildGraph({ references: [ref('a.ts', 'sym:a.ts#foo', true)] });
    expect(g.edges[0].properties).toEqual({ sameFile: true });
  });

  it('reuses injected full Symbol nodes verbatim when provided', () => {
    const full = {
      id: 'sym:a.ts#foo', labels: ['Symbol'],
      properties: { name: 'foo', kind: 'function', exported: true, path: 'a.ts', line: 1 },
    };
    const g = buildGraph({
      references: [ref('b.ts', 'sym:a.ts#foo', false)],
      symbolNodesById: new Map([['sym:a.ts#foo', full]]),
    });
    expect(g.nodes).toContainEqual(full);
  });

  it('counts referencing files, referenced symbols and edges', () => {
    const g = buildGraph({
      references: [
        ref('b.ts', 'sym:a.ts#foo', false),
        ref('b.ts', 'sym:a.ts#bar', false),
        ref('c.ts', 'sym:a.ts#foo', false),
      ],
    });
    // 2 files (b,c), 2 symbols (foo,bar), 3 edges.
    expect(g.counts).toEqual({ files: 2, symbolsReferenced: 2, edges: 3 });
  });
});

describe('buildGraph — dedupe & determinism', () => {
  it('dedupes duplicate (file,symbol) reference records into one edge', () => {
    const g = buildGraph({
      references: [ref('b.ts', 'sym:a.ts#foo', false), ref('b.ts', 'sym:a.ts#foo', false)],
    });
    expect(g.edges).toHaveLength(1);
    expect(g.counts.edges).toBe(1);
  });

  it('sorts nodes and edges by id, byte-stable regardless of input order', () => {
    const refs = [
      ref('z.ts', 'sym:a.ts#foo', false),
      ref('a.ts', 'sym:z.ts#bar', false),
    ];
    const a = buildGraph({ references: refs });
    const b = buildGraph({ references: [...refs].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const nodeIds = a.nodes.map((n) => n.id);
    expect(nodeIds).toEqual([...nodeIds].sort());
    const edgeIds = a.edges.map((e) => e.id);
    expect(edgeIds).toEqual([...edgeIds].sort());
  });
});
