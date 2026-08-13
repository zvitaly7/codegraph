import { describe, it, expect } from 'vitest';
import { buildGraph } from './graph_builder.mjs';

function file(path, symbols) {
  return { path, symbols };
}
const sym = (name, kind, exported, line) => ({ name, kind, exported, line });

describe('buildGraph — nodes, edges, shapes', () => {
  it('emits a File node, Symbol nodes and DECLARES edges', () => {
    const g = buildGraph({
      files: [file('src/a.ts', [sym('foo', 'function', true, 1), sym('bar', 'variable', false, 2)])],
    });

    expect(g.nodes).toContainEqual({ id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts' } });
    expect(g.nodes).toContainEqual({
      id: 'sym:src/a.ts#foo',
      labels: ['Symbol'],
      properties: { name: 'foo', kind: 'function', exported: true, path: 'src/a.ts', line: 1 },
    });
    expect(g.nodes).toContainEqual({
      id: 'sym:src/a.ts#bar',
      labels: ['Symbol'],
      properties: { name: 'bar', kind: 'variable', exported: false, path: 'src/a.ts', line: 2 },
    });

    expect(g.edges).toContainEqual({
      id: 'edge:file:src/a.ts:DECLARES:sym:src/a.ts#foo',
      type: 'DECLARES', from: 'file:src/a.ts', to: 'sym:src/a.ts#foo',
      properties: { kind: 'function' },
    });
    expect(g.edges).toContainEqual({
      id: 'edge:file:src/a.ts:DECLARES:sym:src/a.ts#bar',
      type: 'DECLARES', from: 'file:src/a.ts', to: 'sym:src/a.ts#bar',
      properties: { kind: 'variable' },
    });
  });

  it('a file with no symbols still yields a File node and no edges', () => {
    const g = buildGraph({ files: [file('src/empty.ts', [])] });
    expect(g.nodes).toEqual([{ id: 'file:src/empty.ts', labels: ['File'], properties: { path: 'src/empty.ts' } }]);
    expect(g.edges).toEqual([]);
  });

  it('counts files, symbols, edges and exported', () => {
    const g = buildGraph({
      files: [
        file('a.ts', [sym('x', 'variable', true, 1), sym('y', 'function', false, 2)]),
        file('b.ts', [sym('z', 'class', true, 1)]),
      ],
    });
    expect(g.counts).toEqual({ files: 2, symbols: 3, edges: 3, exported: 2 });
  });
});

describe('buildGraph — within-file name collisions get unique ids', () => {
  it('first keeps the canonical id, subsequent get a ~n ordinal suffix', () => {
    const g = buildGraph({
      files: [file('a.ts', [
        sym('foo', 'function', true, 1),
        sym('foo', 'function', true, 2),
        sym('foo', 'function', true, 3),
      ])],
    });
    const ids = g.nodes.filter((n) => n.labels[0] === 'Symbol').map((n) => n.id);
    expect(ids).toEqual(['sym:a.ts#foo', 'sym:a.ts#foo~2', 'sym:a.ts#foo~3']);
    // The `name` property stays the real declared name on every collision node.
    for (const n of g.nodes.filter((n) => n.labels[0] === 'Symbol')) {
      expect(n.properties.name).toBe('foo');
    }
    // Distinct lines preserved, one edge per symbol, all unique.
    expect(g.nodes.filter((n) => n.labels[0] === 'Symbol').map((n) => n.properties.line)).toEqual([1, 2, 3]);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(3);
  });

  it('same name across two different files does NOT collide (path-scoped)', () => {
    const g = buildGraph({
      files: [file('a.ts', [sym('foo', 'function', false, 1)]), file('b.ts', [sym('foo', 'function', false, 1)])],
    });
    const ids = g.nodes.filter((n) => n.labels[0] === 'Symbol').map((n) => n.id);
    expect(ids).toEqual(['sym:a.ts#foo', 'sym:b.ts#foo']);
  });
});

describe('buildGraph — determinism / ordering', () => {
  it('sorts nodes and edges by id and is byte-stable regardless of file order', () => {
    const files = [
      file('src/z.ts', [sym('Zeta', 'class', true, 1)]),
      file('src/a.ts', [sym('alpha', 'function', false, 1), sym('beta', 'variable', true, 2)]),
    ];
    const a = buildGraph({ files });
    const b = buildGraph({ files: [...files].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const nodeIds = a.nodes.map((n) => n.id);
    expect(nodeIds).toEqual([...nodeIds].sort());
    const edgeIds = a.edges.map((e) => e.id);
    expect(edgeIds).toEqual([...edgeIds].sort());
  });
});
