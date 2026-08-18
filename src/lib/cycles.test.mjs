import { describe, it, expect } from 'vitest';
import { findCycles, fileCycles, domainCycles, buildCycles, renderCycles } from './cycles.mjs';

// ---- synthetic-graph builders -------------------------------------------

function edge(type, from, to, properties = {}) {
  return { id: `edge:${from}:${type}:${to}`, type, from, to, properties };
}

/** The minimum of the loadGraph index surface the cycle finders read. */
function graphOf(nodes, edges) {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const byTypeIndex = new Map();
  for (const e of edges) {
    const list = byTypeIndex.get(e.type);
    if (list) list.push(e);
    else byTypeIndex.set(e.type, [e]);
  }
  return {
    nodesById,
    edges,
    loadedLayers: ['inventory', 'imports', 'domains'],
    getNode: (id) => nodesById.get(id),
    byType: (t) => byTypeIndex.get(t) ?? [],
  };
}

function fileNode(path) {
  return { id: `file:${path}`, labels: ['File'], properties: { path } };
}
function domainNode(name) {
  return { id: `domain:${name}`, labels: ['Domain'], properties: { name, kind: 'product' } };
}

/** file→file IMPORTS graph from `['a.ts b.ts', ...]` pairs. */
function importGraph(pairs) {
  const paths = [...new Set(pairs.flatMap((p) => p.split(' ')))].sort();
  return graphOf(
    paths.map(fileNode),
    pairs.map((p) => {
      const [from, to] = p.split(' ');
      return edge('IMPORTS', `file:${from}`, `file:${to}`, { kind: 'internal' });
    }),
  );
}

// ---- the pure finder ----------------------------------------------------

describe('findCycles — detection', () => {
  it('finds a 3-node cycle', () => {
    const { cycles } = findCycles([
      { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].members).toEqual(['a', 'b', 'c']);
    expect(cycles[0].length).toBe(3);
  });

  it('finds nothing in an acyclic graph', () => {
    const { cycles } = findCycles([
      { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' },
    ]);
    expect(cycles).toEqual([]);
  });

  it('reports two independent cycles separately', () => {
    const { cycles } = findCycles([
      { from: 'a', to: 'b' }, { from: 'b', to: 'a' },
      { from: 'x', to: 'y' }, { from: 'y', to: 'z' }, { from: 'z', to: 'x' },
      { from: 'b', to: 'x' }, // a one-way bridge — must NOT merge the two
    ]);
    expect(cycles).toHaveLength(2);
    expect(cycles.map((c) => c.members)).toEqual([['a', 'b'], ['x', 'y', 'z']]);
  });

  it('reports one big SCC once, not once per member', () => {
    // A 6-clique-ish blob: a ring plus chords, every node reaches every other.
    const ring = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges = ring.map((n, i) => ({ from: n, to: ring[(i + 1) % ring.length] }));
    edges.push({ from: 'c', to: 'a' }, { from: 'e', to: 'b' }, { from: 'f', to: 'd' });
    const { cycles } = findCycles(edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].componentSize).toBe(6);
    // The full component is listed whenever the reported ring is shorter.
    expect(cycles[0].component).toEqual(ring);
  });

  it('excludes self-loops and counts them', () => {
    const { cycles, selfLoops } = findCycles([
      { from: 'a', to: 'a' },
      { from: 'b', to: 'c' }, { from: 'c', to: 'b' },
    ]);
    expect(selfLoops).toEqual(['a']);
    expect(cycles.map((c) => c.members)).toEqual([['b', 'c']]);
  });

  it('is deterministic, including the rotation of each cycle', () => {
    const edges = [
      { from: 'c', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' },
    ];
    // Same ring, declared starting from a different node and in another order.
    const shuffled = [
      { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'a', to: 'b' },
    ];
    const first = findCycles(edges);
    const second = findCycles(shuffled);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Rotated to the lexicographically smallest member.
    expect(first.cycles[0].members[0]).toBe('a');
  });

  it('sorts cycles: shortest first, then by members', () => {
    const { cycles } = findCycles([
      { from: 'p', to: 'q' }, { from: 'q', to: 'r' }, { from: 'r', to: 'p' },
      { from: 'm', to: 'n' }, { from: 'n', to: 'm' },
    ]);
    expect(cycles.map((c) => c.length)).toEqual([2, 3]);
    expect(cycles.map((c) => c.members)).toEqual([['m', 'n'], ['p', 'q', 'r']]);
  });
});

describe('findCycles — weights', () => {
  it('carries the per-hop weight of each edge on the cycle', () => {
    const { cycles } = findCycles([
      { from: 'ui', to: 'server', weight: 200 },
      { from: 'server', to: 'ui', weight: 1 },
    ], { weighted: true });
    expect(cycles[0].weights).toEqual([
      { from: 'server', to: 'ui', weight: 1 },
      { from: 'ui', to: 'server', weight: 200 },
    ]);
    expect(cycles[0].minWeight).toBe(1);
    expect(cycles[0].totalWeight).toBe(201);
  });

  it('leaves weights off when the caller did not ask for them', () => {
    const { cycles } = findCycles([
      { from: 'a', to: 'b', weight: 5 }, { from: 'b', to: 'a', weight: 5 },
    ]);
    expect(cycles[0].weights).toBeUndefined();
  });
});

// ---- graph adapters -----------------------------------------------------

describe('fileCycles', () => {
  it('finds a file cycle over internal IMPORTS edges, reported as paths', () => {
    const graph = importGraph(['src/a.ts src/b.ts', 'src/b.ts src/c.ts', 'src/c.ts src/a.ts']);
    const report = fileCycles(graph);
    expect(report.scope).toBe('file');
    expect(report.total).toBe(1);
    expect(report.cycles[0].members).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('reports none for an acyclic import graph', () => {
    const report = fileCycles(importGraph(['src/a.ts src/b.ts', 'src/b.ts src/c.ts']));
    expect(report.total).toBe(0);
    expect(report.cycles).toEqual([]);
  });

  it('ignores package imports — only file→file edges form a cycle', () => {
    const graph = graphOf(
      [fileNode('src/a.ts'), { id: 'pkg:react', labels: ['Package'], properties: { name: 'react' } }],
      [
        edge('IMPORTS', 'file:src/a.ts', 'pkg:react', { kind: 'external' }),
        edge('IMPORTS', 'pkg:react', 'file:src/a.ts', { kind: 'external' }),
      ],
    );
    expect(fileCycles(graph).total).toBe(0);
  });

  it('excludes a file that imports itself, and says so', () => {
    const graph = importGraph(['src/a.ts src/a.ts']);
    const report = fileCycles(graph);
    expect(report.total).toBe(0);
    expect(report.selfLoops).toEqual(['src/a.ts']);
  });

  it('caps the listed cycles at `limit` while keeping the true total', () => {
    const graph = importGraph([
      'src/a.ts src/b.ts', 'src/b.ts src/a.ts',
      'src/c.ts src/d.ts', 'src/d.ts src/c.ts',
      'src/e.ts src/f.ts', 'src/f.ts src/e.ts',
    ]);
    const report = fileCycles(graph, { limit: 2 });
    expect(report.total).toBe(3);
    expect(report.returned).toBe(2);
    expect(report.truncated).toBe(true);
    expect(report.cycles).toHaveLength(2);
  });
});

describe('domainCycles', () => {
  it('finds a domain cycle over DEPENDS_ON and carries the edge weights', () => {
    const graph = graphOf(
      [domainNode('ui'), domainNode('server')],
      [
        edge('DEPENDS_ON', 'domain:ui', 'domain:server', { weight: 200 }),
        edge('DEPENDS_ON', 'domain:server', 'domain:ui', { weight: 1 }),
      ],
    );
    const report = domainCycles(graph);
    expect(report.scope).toBe('domain');
    expect(report.total).toBe(1);
    expect(report.cycles[0].members).toEqual(['server', 'ui']);
    expect(report.cycles[0].weights).toEqual([
      { from: 'server', to: 'ui', weight: 1 },
      { from: 'ui', to: 'server', weight: 200 },
    ]);
    expect(report.cycles[0].minWeight).toBe(1);
  });

  it('reports none when domains only depend one way', () => {
    const graph = graphOf(
      [domainNode('ui'), domainNode('server')],
      [edge('DEPENDS_ON', 'domain:ui', 'domain:server', { weight: 3 })],
    );
    expect(domainCycles(graph).total).toBe(0);
  });
});

describe('buildCycles', () => {
  it('runs both scopes by default and totals them', () => {
    const graph = graphOf(
      [fileNode('src/a.ts'), fileNode('src/b.ts'), domainNode('ui'), domainNode('server')],
      [
        edge('IMPORTS', 'file:src/a.ts', 'file:src/b.ts', { kind: 'internal' }),
        edge('IMPORTS', 'file:src/b.ts', 'file:src/a.ts', { kind: 'internal' }),
        edge('DEPENDS_ON', 'domain:ui', 'domain:server', { weight: 2 }),
        edge('DEPENDS_ON', 'domain:server', 'domain:ui', { weight: 9 }),
      ],
    );
    const report = buildCycles(graph, { scope: 'both' });
    expect(report.scope).toBe('both');
    expect(report.file.total).toBe(1);
    expect(report.domain.total).toBe(1);
    expect(report.total).toBe(2);
  });

  it('runs only the requested scope', () => {
    const graph = importGraph(['src/a.ts src/b.ts', 'src/b.ts src/a.ts']);
    const report = buildCycles(graph, { scope: 'file' });
    expect(report.file.total).toBe(1);
    expect(report.domain).toBeUndefined();
  });

  it('renders a readable report that names the cycle members', () => {
    const graph = importGraph(['src/a.ts src/b.ts', 'src/b.ts src/a.ts']);
    const text = renderCycles(buildCycles(graph, { scope: 'file' }));
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
    expect(text).toMatch(/1 cycle/i);
  });

  it('says plainly when there are no cycles at all', () => {
    const text = renderCycles(buildCycles(importGraph(['src/a.ts src/b.ts']), { scope: 'both' }));
    expect(text).toMatch(/no cycles/i);
  });
});
