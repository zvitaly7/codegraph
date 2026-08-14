import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../../lib/graph_load.mjs';
import { renderDocs, STRINGS } from './render.mjs';

function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

const file = (path, extra = {}) => ({
  id: `file:${path}`,
  labels: ['File'],
  properties: {
    path, name: path.split('/').pop(), language: 'TypeScript', kind: 'code', sizeBytes: 100, ...extra,
  },
});
const pkg = (name) => ({ id: `pkg:${name}`, labels: ['Package'], properties: { name } });
const sym = (path, name, kind, exported, line) => ({
  id: `sym:${path}#${name}`, labels: ['Symbol'], properties: { name, kind, exported, path, line },
});
const edge = (type, from, to, properties = {}) => ({ id: `edge:${from}:${type}:${to}`, type, from, to, properties });
const imp = (from, to) => edge('IMPORTS', `file:${from}`, to, { kind: to.startsWith('pkg:') ? 'external' : 'internal' });
const decl = (path, name) => edge('DECLARES', `file:${path}`, `sym:${path}#${name}`);
const ref = (from, symId, sameFile) => edge('REFERENCES', `file:${from}`, symId, { sameFile });
const domain = (name, kind) => ({ id: `domain:${name}`, labels: ['Domain'], properties: { name, kind } });
const belongs = (path, d) => edge('BELONGS_TO', `file:${path}`, `domain:${d}`);
const dependsOn = (a, b, weight) => edge('DEPENDS_ON', `domain:${a}`, `domain:${b}`, { weight });

/**
 * Synthetic six-layer graph:
 *   checkout/pay.ts → core/index.ts → core/util.ts, ui/button.tsx → core/index.ts
 *   checkout/cart.ts exports `cart`, which nobody references (dead export)
 *   src/orphan.ts has no importers and is not entry-like (orphan candidate)
 */
function buildFixture() {
  const cache = mkdtempSync(join(tmpdir(), 'cg-docs-render-'));
  mkdirSync(join(cache, 'inventory'), { recursive: true });
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({
    projectId: 'project:demo-shop',
    snapshotId: 'snapshot:demo-shop:abc123def',
    repoRoot: '/tmp/demo-shop',
    vcs: { type: 'git', branch: 'main', revision: 'abc123def' },
  }));
  writeLayer(cache, 'inventory', {
    nodes: [
      { id: 'project:demo-shop', labels: ['Project'], properties: { name: 'demo-shop', root: '/tmp/demo-shop' } },
      file('src/core/util.ts'),
      file('src/core/index.ts'),
      file('src/checkout/pay.ts'),
      file('src/checkout/cart.ts'),
      file('src/ui/button.tsx', { language: 'TypeScript' }),
      file('src/orphan.ts'),
      file('test/pay.test.ts', { kind: 'test' }),
      file('package.json', { language: 'JSON', extension: '.json' }),
    ],
  });
  writeLayer(cache, 'imports', {
    nodes: [pkg('react'), pkg('lodash')],
    edges: [
      imp('src/core/index.ts', 'file:src/core/util.ts'),
      imp('src/checkout/pay.ts', 'file:src/core/index.ts'),
      imp('src/checkout/cart.ts', 'file:src/core/index.ts'),
      imp('src/ui/button.tsx', 'file:src/core/index.ts'),
      imp('src/checkout/pay.ts', 'pkg:react'),
      imp('src/ui/button.tsx', 'pkg:react'),
      imp('src/core/util.ts', 'pkg:lodash'),
      imp('test/pay.test.ts', 'file:src/checkout/pay.ts'),
    ],
  });
  writeLayer(cache, 'symbols', {
    nodes: [
      sym('src/core/util.ts', 'format', 'function', true, 12),
      sym('src/core/util.ts', 'INTERNAL', 'const', false, 3),
      sym('src/core/index.ts', 'setup', 'function', true, 5),
      sym('src/checkout/pay.ts', 'pay', 'function', true, 9),
      sym('src/checkout/cart.ts', 'cart', 'function', true, 4),
      sym('src/orphan.ts', 'lonely', 'function', true, 1),
    ],
    edges: [
      decl('src/core/util.ts', 'format'), decl('src/core/util.ts', 'INTERNAL'),
      decl('src/core/index.ts', 'setup'), decl('src/checkout/pay.ts', 'pay'),
      decl('src/checkout/cart.ts', 'cart'), decl('src/orphan.ts', 'lonely'),
    ],
  });
  writeLayer(cache, 'references', {
    edges: [
      ref('src/core/index.ts', 'sym:src/core/util.ts#format', false),
      ref('src/checkout/pay.ts', 'sym:src/core/util.ts#format', false),
      ref('src/ui/button.tsx', 'sym:src/core/util.ts#format', false),
      ref('src/checkout/pay.ts', 'sym:src/core/index.ts#setup', false),
      ref('test/pay.test.ts', 'sym:src/checkout/pay.ts#pay', false),
      ref('src/checkout/cart.ts', 'sym:src/checkout/cart.ts#cart', true), // same-file only → dead
    ],
  });
  writeLayer(cache, 'usages', {});
  writeLayer(cache, 'domains', {
    nodes: [domain('checkout', 'product'), domain('core', 'platform'), domain('ui', 'product')],
    edges: [
      belongs('src/checkout/pay.ts', 'checkout'), belongs('src/checkout/cart.ts', 'checkout'),
      belongs('src/core/index.ts', 'core'), belongs('src/core/util.ts', 'core'),
      belongs('src/orphan.ts', 'core'),
      belongs('src/ui/button.tsx', 'ui'),
      dependsOn('checkout', 'core', 3),
      dependsOn('ui', 'core', 1),
    ],
  });
  return loadGraph(cache);
}

let g;
let pages;
const page = (kind, name) => pages.find((p) => p.kind === kind && (!name || p.path.endsWith(name)));

beforeEach(() => {
  g = buildFixture();
  pages = renderDocs(g);
});

describe('renderDocs — page set', () => {
  it('emits AGENTS.md, an index, dependencies, health and one page per domain', () => {
    const paths = pages.map((p) => p.path).sort();
    expect(paths).toEqual([
      'AGENTS.md', 'README.md', 'dependencies.md',
      'domains/checkout.md', 'domains/core.md', 'domains/ui.md', 'health.md',
    ]);
    expect(page('agents').path).toBe('AGENTS.md');
    expect(pages.filter((p) => p.kind === 'domain')).toHaveLength(3);
  });

  it('every page carries the honesty header: revision, structure-not-intent, notes go outside', () => {
    for (const p of pages) {
      expect(p.content).toContain('abc123def');            // the rev from the manifest
      expect(p.content.toLowerCase()).toMatch(/auto-generated/);
      expect(p.content.toLowerCase()).toMatch(/structure/);
      expect(p.content).toContain('codegraph:begin generated'); // where human notes must NOT go
    }
  });

  it('renders no markers in the body itself (merge.mjs owns those)', () => {
    // The header mentions the marker name in prose, but no page ships a real block —
    // wrapping is the merge step's job, so a body is never double-wrapped.
    for (const p of pages) {
      expect(p.content).not.toContain('<!-- codegraph:begin generated -->');
    }
  });

  it('is deterministic — no timestamps, same bytes on a second render', () => {
    expect(renderDocs(g).map((p) => p.content)).toEqual(pages.map((p) => p.content));
  });

  it('emits plain text — no control bytes that would make the page look binary', () => {
    for (const p of [...pages, ...renderDocs(g, { lang: 'ru' })]) {
      // eslint-disable-next-line no-control-regex
      expect(p.content).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    }
  });
});

describe('AGENTS.md', () => {
  it('states what the project is and how big it is', () => {
    const c = page('agents').content;
    expect(c).toContain('demo-shop');
    expect(c).toMatch(/\b8\b/);   // files
    expect(c).toMatch(/\b6\b/);   // symbols
    expect(c).toMatch(/\b3\b/);   // domains
    expect(c).toMatch(/\b2\b/);   // external packages
  });

  it('lists tech signals the graph can prove', () => {
    const c = page('agents').content;
    expect(c).toContain('TypeScript');
    expect(c).toContain('react');       // top external package
    expect(c).toMatch(/test/i);         // test files exist → said so
  });

  it('maps every domain with one line each, linking to its page', () => {
    const c = page('agents').content;
    for (const d of ['checkout', 'core', 'ui']) {
      expect(c).toContain(d);
      expect(c).toContain(`domains/${d}.md`);
    }
    expect(c).toContain('platform'); // the domain kind
  });

  it('shows where things live (top-level structure)', () => {
    const c = page('agents').content;
    expect(c).toContain('src/');
    expect(c).toContain('test/');
  });

  it('tells the agent to prefer brief/impact/MCP over reading many files', () => {
    const c = page('agents').content;
    expect(c).toContain('codegraph brief');
    expect(c).toContain('codegraph impact');
    expect(c).toMatch(/MCP/);
    expect(c.toLowerCase()).toMatch(/token/);
  });
});

describe('domain pages', () => {
  it('show kind, file count and dependencies in both directions with weights', () => {
    const c = page('domain', 'checkout.md').content;
    expect(c).toContain('checkout');
    expect(c).toContain('product');   // kind
    expect(c).toMatch(/\b2\b/);       // 2 files
    expect(c).toContain('core');      // depends on core
    expect(c).toContain('3');         // with weight 3

    const core = page('domain', 'core.md').content;
    expect(core).toContain('checkout'); // depended on by checkout
    expect(core).toContain('ui');       // and by ui
  });

  it('list external packages, most-referenced exports and top files by in-degree', () => {
    const core = page('domain', 'core.md').content;
    expect(core).toContain('lodash');                 // its external package
    expect(core).toContain('format');                 // most-referenced export (3 refs)
    expect(core).toContain('src/core/index.ts');      // top file by in-degree (3 importers)
    expect(core).toContain('src/core/util.ts');
  });
});

describe('dependencies.md', () => {
  it('ranks the cross-domain map and names packages and importers', () => {
    const c = page('dependencies').content;
    // checkout→core (3) outranks ui→core (1)
    expect(c.indexOf('checkout')).toBeLessThan(c.indexOf('ui'));
    expect(c).toContain('core');
    expect(c).toContain('react');   // most-depended-on external package (2 files)
    expect(c).toContain('lodash');
    expect(c).toContain('src/checkout/pay.ts'); // a biggest-importer row
  });
});

describe('health.md', () => {
  it('lists dead exports with their paths and a count', () => {
    const c = page('health').content;
    expect(c).toContain('cart');
    expect(c).toContain('src/checkout/cart.ts');
    expect(c).toContain('lonely');
    expect(c).toContain('src/orphan.ts');
  });

  it('lists orphaned files and labels both sections as heuristics', () => {
    const c = page('health').content;
    expect(c).toContain('src/orphan.ts');
    expect(c.toLowerCase()).toMatch(/heuristic/);
    // an entry-like file with no importers is not reported as an orphan
    expect(c).not.toContain('src/core/index.ts');
  });
});

describe('i18n', () => {
  it('ru localizes headings but never identifiers or paths', () => {
    const ru = renderDocs(g, { lang: 'ru' });
    const ruAgents = ru.find((p) => p.kind === 'agents').content;
    const enAgents = page('agents').content;

    expect(ruAgents).not.toBe(enAgents);
    expect(ruAgents).toMatch(/[А-Яа-я]/);           // localized headings
    // identifiers and paths are untouched
    for (const token of ['demo-shop', 'checkout', 'core', 'ui', 'react', 'src/', 'codegraph brief']) {
      expect(ruAgents).toContain(token);
    }
    // the page set and file names are identical across languages
    expect(ru.map((p) => p.path)).toEqual(pages.map((p) => p.path));
  });

  it('an unknown language falls back to en', () => {
    const xx = renderDocs(g, { lang: 'xx' });
    expect(xx.find((p) => p.kind === 'agents').content).toBe(page('agents').content);
  });

  it('keeps all strings in one dict so a new language is a single entry', () => {
    expect(Object.keys(STRINGS).sort()).toEqual(['en', 'ru']);
    expect(Object.keys(STRINGS.ru).sort()).toEqual(Object.keys(STRINGS.en).sort());
  });
});

describe('renderDocs — degenerate graphs', () => {
  it('an empty graph still renders the fixed pages without throwing', () => {
    const empty = loadGraph(mkdtempSync(join(tmpdir(), 'cg-docs-empty-')));
    const out = renderDocs(empty);
    expect(out.map((p) => p.path).sort()).toEqual(['AGENTS.md', 'README.md', 'dependencies.md', 'health.md']);
    expect(out.every((p) => typeof p.content === 'string' && p.content.length > 0)).toBe(true);
  });
});
