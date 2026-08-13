import { describe, it, expect } from 'vitest';
import { buildGraph } from './graph_builder.mjs';

const domainsConfig = {
  CANONICAL_DOMAINS: {
    cart: { kind: 'product' },
    checkout: { kind: 'product' },
    docs: { kind: 'infra' },
    unassigned: { kind: 'infra' },
  },
  ALIASES: {},
  AREA_BUCKETS: [],
};

const files = [
  { path: 'src/cart/index.ts', domain: 'cart' },
  { path: 'src/cart/util.ts', domain: 'cart' },
  { path: 'src/checkout/pay.ts', domain: 'checkout' },
  { path: 'docs/readme.md', domain: 'docs' },
  { path: 'package.json', domain: 'unassigned' },
];

describe('buildGraph — Domain nodes', () => {
  it('emits one Domain node per canonical domain with name + kind', () => {
    const g = buildGraph({ domainsConfig, files, importEdges: [] });
    expect(g.nodes).toContainEqual({
      id: 'domain:cart', labels: ['Domain'], properties: { name: 'cart', kind: 'product' },
    });
    expect(g.nodes).toContainEqual({
      id: 'domain:docs', labels: ['Domain'], properties: { name: 'docs', kind: 'infra' },
    });
    // A canonical domain with zero files still gets a node (e.g. unassigned when empty).
    const empty = buildGraph({ domainsConfig, files: [], importEdges: [] });
    expect(empty.nodes.map((n) => n.id).sort()).toEqual(
      ['domain:cart', 'domain:checkout', 'domain:docs', 'domain:unassigned'],
    );
  });

  it('materializes a node for a soft-derived domain not in CANONICAL_DOMAINS', () => {
    const g = buildGraph({
      domainsConfig,
      files: [{ path: 'src/orders/x.ts', domain: 'orders' }],
      importEdges: [],
    });
    expect(g.nodes).toContainEqual({
      id: 'domain:orders', labels: ['Domain'], properties: { name: 'orders', kind: 'product' },
    });
  });
});

describe('buildGraph — BELONGS_TO edges', () => {
  it('emits a File→Domain BELONGS_TO edge per file', () => {
    const g = buildGraph({ domainsConfig, files, importEdges: [] });
    expect(g.edges).toContainEqual({
      id: 'edge:file:src/cart/index.ts:BELONGS_TO:domain:cart',
      type: 'BELONGS_TO', from: 'file:src/cart/index.ts', to: 'domain:cart', properties: {},
    });
    expect(g.edges).toContainEqual({
      id: 'edge:file:package.json:BELONGS_TO:domain:unassigned',
      type: 'BELONGS_TO', from: 'file:package.json', to: 'domain:unassigned', properties: {},
    });
    expect(g.counts.belongsTo).toBe(5);
  });
});

describe('buildGraph — DEPENDS_ON aggregation', () => {
  const importEdges = [
    // cart → checkout (twice) — aggregates to weight 2
    { fromPath: 'src/cart/index.ts', toPath: 'src/checkout/pay.ts' },
    { fromPath: 'src/cart/util.ts', toPath: 'src/checkout/pay.ts' },
    // checkout → cart (once)
    { fromPath: 'src/checkout/pay.ts', toPath: 'src/cart/index.ts' },
    // self-loop within cart — skipped
    { fromPath: 'src/cart/index.ts', toPath: 'src/cart/util.ts' },
  ];

  it('aggregates cross-domain import edges into weighted Domain→Domain edges', () => {
    const g = buildGraph({ domainsConfig, files, importEdges });
    expect(g.edges).toContainEqual({
      id: 'edge:domain:cart:DEPENDS_ON:domain:checkout',
      type: 'DEPENDS_ON', from: 'domain:cart', to: 'domain:checkout', properties: { weight: 2 },
    });
    expect(g.edges).toContainEqual({
      id: 'edge:domain:checkout:DEPENDS_ON:domain:cart',
      type: 'DEPENDS_ON', from: 'domain:checkout', to: 'domain:cart', properties: { weight: 1 },
    });
    expect(g.counts.dependsOn).toBe(2);
  });

  it('skips self-loops and edges whose endpoints are unknown files', () => {
    const g = buildGraph({
      domainsConfig,
      files,
      importEdges: [
        { fromPath: 'src/cart/index.ts', toPath: 'src/cart/util.ts' }, // self-loop
        { fromPath: 'src/cart/index.ts', toPath: 'ghost/none.ts' },    // unknown target
      ],
    });
    expect(g.edges.filter((e) => e.type === 'DEPENDS_ON')).toEqual([]);
    expect(g.counts.dependsOn).toBe(0);
  });
});

describe('buildGraph — determinism', () => {
  it('sorts nodes and edges by id, byte-stable regardless of input order', () => {
    const importEdges = [
      { fromPath: 'src/checkout/pay.ts', toPath: 'src/cart/index.ts' },
      { fromPath: 'src/cart/index.ts', toPath: 'src/checkout/pay.ts' },
    ];
    const a = buildGraph({ domainsConfig, files, importEdges });
    const b = buildGraph({ domainsConfig, files: [...files].reverse(), importEdges: [...importEdges].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.nodes.map((n) => n.id)).toEqual([...a.nodes.map((n) => n.id)].sort());
    expect(a.edges.map((e) => e.id)).toEqual([...a.edges.map((e) => e.id)].sort());
  });
});
