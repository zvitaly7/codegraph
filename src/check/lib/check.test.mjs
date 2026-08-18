import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../../lib/graph_load.mjs';
import {
  evaluateCheck, renderCheck, unknownRuleKeys, missingPrerequisites, RULE_KEYS,
} from './check.mjs';
import { CHECK_RULE_KEYS } from '../../../bin/lib/help.mjs';

function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

const file = (path, extra = {}) => ({ id: `file:${path}`, labels: ['File'], properties: { path, name: path.split('/').pop(), kind: 'code', ...extra } });
const sym = (path, name, exported = true) => ({ id: `sym:${path}#${name}`, labels: ['Symbol'], properties: { name, kind: 'function', exported, path, line: 1 } });
const domain = (name) => ({ id: `domain:${name}`, labels: ['Domain'], properties: { name, kind: 'product' } });
const edge = (type, from, to, properties = {}) => ({ id: `edge:${from}:${type}:${to}`, type, from, to, properties });

/**
 * A repo with everything a rule can trip on:
 *   files    ui/a.ts ↔ ui/b.ts (a cycle), ui/a.ts → server/db.ts (a boundary crossing)
 *   symbols  server/db.ts#unusedThing is exported and referenced by nobody
 *   domains  ui ↔ server (a domain cycle), plus ui → server as a forbidden edge
 */
function buildGraph({ cyclic = true, entryPoint = false } = {}) {
  const cache = mkdtempSync(join(tmpdir(), 'cg-check-'));
  writeLayer(cache, 'inventory', {
    nodes: [
      file('src/ui/a.ts', entryPoint ? { entryPoint: true } : {}),
      file('src/ui/b.ts'),
      file('src/server/db.ts', entryPoint ? { entryPoint: true } : {}),
    ],
  });
  writeLayer(cache, 'imports', {
    edges: [
      edge('IMPORTS', 'file:src/ui/a.ts', 'file:src/ui/b.ts', { kind: 'internal' }),
      ...(cyclic ? [edge('IMPORTS', 'file:src/ui/b.ts', 'file:src/ui/a.ts', { kind: 'internal' })] : []),
      edge('IMPORTS', 'file:src/ui/a.ts', 'file:src/server/db.ts', { kind: 'internal' }),
      edge('IMPORTS', 'file:src/ui/b.ts', 'file:src/server/db.ts', { kind: 'internal' }),
    ],
  });
  writeLayer(cache, 'symbols', {
    nodes: [sym('src/server/db.ts', 'connect'), sym('src/server/db.ts', 'unusedThing'), sym('src/ui/a.ts', 'render')],
    edges: [
      edge('DECLARES', 'file:src/server/db.ts', 'sym:src/server/db.ts#connect'),
      edge('DECLARES', 'file:src/server/db.ts', 'sym:src/server/db.ts#unusedThing'),
      edge('DECLARES', 'file:src/ui/a.ts', 'sym:src/ui/a.ts#render'),
    ],
  });
  writeLayer(cache, 'references', {
    edges: [
      edge('REFERENCES', 'file:src/ui/a.ts', 'sym:src/server/db.ts#connect', { sameFile: false }),
      edge('REFERENCES', 'file:src/server/db.ts', 'sym:src/server/db.ts#unusedThing', { sameFile: true }),
      edge('REFERENCES', 'file:src/ui/a.ts', 'sym:src/ui/a.ts#render', { sameFile: true }),
    ],
  });
  writeLayer(cache, 'domains', {
    nodes: [domain('ui'), domain('server')],
    edges: [
      edge('BELONGS_TO', 'file:src/ui/a.ts', 'domain:ui'),
      edge('BELONGS_TO', 'file:src/ui/b.ts', 'domain:ui'),
      edge('BELONGS_TO', 'file:src/server/db.ts', 'domain:server'),
      edge('DEPENDS_ON', 'domain:ui', 'domain:server', { weight: 2 }),
      ...(cyclic ? [edge('DEPENDS_ON', 'domain:server', 'domain:ui', { weight: 1 })] : []),
    ],
  });
  return loadGraph(cache);
}

const ruleById = (report, id) => report.rules.find((r) => r.id === id);

describe('evaluateCheck — no rules configured', () => {
  it('is not a silent pass: it says nothing was configured and lists what could be', () => {
    const report = evaluateCheck(buildGraph(), {});
    expect(report.configured).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.counts.evaluated).toBe(0);
    expect(report.note).toMatch(/no .*rules? .*configured/i);
    for (const key of RULE_KEYS) expect(report.available).toContain(key);
  });

  it('says so loudly in the rendered report too', () => {
    const text = renderCheck(evaluateCheck(buildGraph(), {}));
    expect(text).toMatch(/nothing/i);
    expect(text).toContain('noCycles');
    expect(text).toContain('maxDeadExports');
  });
});

describe('evaluateCheck — noCycles', () => {
  it('fails when a cycle exists and names the ring', () => {
    const report = evaluateCheck(buildGraph({ cyclic: true }), { noCycles: true });
    const rule = ruleById(report, 'noCycles');
    expect(report.ok).toBe(false);
    expect(rule.ok).toBe(false);
    expect(rule.offenders.join('\n')).toContain('src/ui/a.ts → src/ui/b.ts → src/ui/a.ts');
    expect(rule.offenders.join('\n')).toContain('server → ui → server');
  });

  it('passes on an acyclic graph', () => {
    const report = evaluateCheck(buildGraph({ cyclic: false }), { noCycles: true });
    expect(report.ok).toBe(true);
    expect(ruleById(report, 'noCycles').ok).toBe(true);
  });

  it('honours an explicit scope', () => {
    // File-scope only: the domain cycle must not fail it.
    const graph = buildGraph({ cyclic: true });
    const domainOnly = evaluateCheck(graph, { noCycles: { scope: 'domain' } });
    expect(ruleById(domainOnly, 'noCycles').offenders.join('\n')).not.toContain('src/ui/a.ts');
    expect(ruleById(domainOnly, 'noCycles').ok).toBe(false);
  });
});

describe('evaluateCheck — maxDeadExports', () => {
  it('fails when the count exceeds the budget and names the exports', () => {
    const report = evaluateCheck(buildGraph(), { maxDeadExports: 0 });
    const rule = ruleById(report, 'maxDeadExports');
    expect(rule.ok).toBe(false);
    // `unusedThing` and `render` are both exported and referenced only same-file.
    expect(rule.detail).toContain('2 dead exports vs a budget of 0');
    expect(rule.offenders.join('\n')).toContain('unusedThing');
  });

  it('passes when the count is within the budget', () => {
    expect(ruleById(evaluateCheck(buildGraph(), { maxDeadExports: 5 }), 'maxDeadExports').ok).toBe(true);
  });

  it('counts AFTER the entry-point exclusion, not before', () => {
    // The only dead export lives in an entry-point file → it does not count.
    const report = evaluateCheck(buildGraph({ entryPoint: true }), { maxDeadExports: 0 });
    const rule = ruleById(report, 'maxDeadExports');
    expect(rule.ok).toBe(true);
    expect(rule.detail).toMatch(/entry.point/i);
  });
});

describe('evaluateCheck — minResolutionRate', () => {
  it('fails when the imports layer resolved less than the floor', () => {
    const report = evaluateCheck(buildGraph(), { minResolutionRate: 0.95 }, { resolutionRate: 0.82 });
    const rule = ruleById(report, 'minResolutionRate');
    expect(rule.ok).toBe(false);
    expect(rule.detail).toContain('0.82');
    expect(rule.detail).toContain('0.95');
  });

  it('passes when the rate meets the floor exactly', () => {
    const report = evaluateCheck(buildGraph(), { minResolutionRate: 0.95 }, { resolutionRate: 0.95 });
    expect(ruleById(report, 'minResolutionRate').ok).toBe(true);
  });
});

describe('evaluateCheck — domainRules', () => {
  it('fails on a forbidden edge and names the ACTUAL files causing it', () => {
    const report = evaluateCheck(buildGraph(), {
      domainRules: [{ from: 'ui', mustNotDependOn: ['server', 'db'] }],
    });
    const rule = report.rules.find((r) => r.id.startsWith('domainRules'));
    expect(rule.ok).toBe(false);
    expect(rule.offenders).toContain('src/ui/a.ts → src/server/db.ts');
    expect(rule.offenders).toContain('src/ui/b.ts → src/server/db.ts');
  });

  it('passes when the forbidden edge does not exist', () => {
    const report = evaluateCheck(buildGraph(), {
      domainRules: [{ from: 'server', mustNotDependOn: ['ui'] }],
    });
    // The fixture's cyclic variant does have server → ui, so use the acyclic one.
    expect(report.rules[0].ok).toBe(false);
    const clean = evaluateCheck(buildGraph({ cyclic: false }), {
      domainRules: [{ from: 'server', mustNotDependOn: ['ui'] }],
    });
    expect(clean.rules[0].ok).toBe(true);
    expect(clean.ok).toBe(true);
  });

  it('flags a rule whose `from` domain is not in the graph instead of passing it silently', () => {
    const report = evaluateCheck(buildGraph(), {
      domainRules: [{ from: 'nope', mustNotDependOn: ['server'] }],
    });
    expect(report.rules[0].ok).toBe(true);
    expect(report.rules[0].note).toMatch(/not in the graph/i);
  });

  it('evaluates every rule in the list, with a distinct id each', () => {
    const report = evaluateCheck(buildGraph(), {
      domainRules: [
        { from: 'ui', mustNotDependOn: ['server'] },
        { from: 'server', mustNotDependOn: ['ui'] },
      ],
    });
    expect(report.counts.evaluated).toBe(2);
    expect(new Set(report.rules.map((r) => r.id)).size).toBe(2);
  });
});

describe('evaluateCheck — offender caps and totals', () => {
  it('caps the listed offenders and keeps the true total', () => {
    const report = evaluateCheck(buildGraph(), {
      domainRules: [{ from: 'ui', mustNotDependOn: ['server'] }],
    }, { maxOffenders: 1 });
    const rule = report.rules[0];
    expect(rule.offendersTotal).toBe(2);
    expect(rule.offenders).toHaveLength(1);
    expect(renderCheck(report)).toContain('+1 more');
  });
});

describe('evaluateCheck — a passing rule is quiet', () => {
  it('lists no offenders, and the render prints none, when a rule passes', () => {
    const report = evaluateCheck(buildGraph(), { maxDeadExports: 5 });
    const rule = ruleById(report, 'maxDeadExports');
    expect(rule.ok).toBe(true);
    expect(rule.offenders).toEqual([]);
    expect(rule.offendersTotal).toBe(2); // the count is still reported
    const text = renderCheck(report);
    expect(text).not.toContain('unusedThing');
    expect(text).not.toContain('more');
  });
});

describe('evaluateCheck — every rule at once', () => {
  it('reports each rule with its verdict and totals the failures', () => {
    const report = evaluateCheck(buildGraph(), {
      noCycles: true,
      maxDeadExports: 0,
      minResolutionRate: 0.95,
      domainRules: [{ from: 'ui', mustNotDependOn: ['server'] }],
    }, { resolutionRate: 1 });
    expect(report.configured).toBe(true);
    expect(report.counts.evaluated).toBe(4);
    expect(report.counts.failed).toBe(3);
    expect(report.counts.passed).toBe(1);
    const text = renderCheck(report);
    expect(text).toContain('FAIL');
    expect(text).toContain('PASS');
    expect(text).toContain('minResolutionRate');
  });
});

describe('config hygiene', () => {
  it('spots a mistyped rule name', () => {
    expect(unknownRuleKeys({ noCycles: true, maxDeadExport: 3 })).toEqual(['maxDeadExport']);
    expect(unknownRuleKeys({ noCycles: true })).toEqual([]);
  });

  it('keeps the CLI help\'s transcribed rule list in step with the real one', () => {
    // help.mjs cannot import this module (it would drag in the TS compiler on
    // every `loregraph` invocation), so the two lists are pinned to each other.
    expect(CHECK_RULE_KEYS).toEqual(RULE_KEYS);
  });

  it('reports which layer a configured rule needs but the cache lacks', () => {
    const missing = missingPrerequisites(
      { maxDeadExports: 0, noCycles: { scope: 'domain' } },
      ['inventory', 'imports'],
    );
    expect(missing).toEqual([
      { rule: 'noCycles', layer: 'domains' },
      { rule: 'maxDeadExports', layer: 'references' },
    ]);
    expect(missingPrerequisites({ noCycles: { scope: 'file' } }, ['inventory', 'imports'])).toEqual([]);
  });
});

// `maxDeadExports` is the rule most likely to make someone delete code. It must
// carry the size of what the graph cannot see.
describe('evaluateCheck — maxDeadExports and computed dynamic imports', () => {
  function graphWithDynamic(n) {
    const cache = mkdtempSync(join(tmpdir(), 'cg-check-dyn-'));
    writeLayer(cache, 'inventory', { nodes: [file('src/a.ts'), file('src/b.ts')] });
    writeLayer(cache, 'imports', {
      nodes: [
        { id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts', computedDynamicImports: n } },
        { id: 'file:src/b.ts', labels: ['File'], properties: { path: 'src/b.ts' } },
      ],
    });
    writeLayer(cache, 'symbols', {
      nodes: [sym('src/b.ts', 'lonely')],
      edges: [edge('DECLARES', 'file:src/b.ts', 'sym:src/b.ts#lonely')],
    });
    writeLayer(cache, 'references', {});
    return loadGraph(cache);
  }

  it('notes the unfollowable sites on the rule, and renders them', () => {
    const report = evaluateCheck(graphWithDynamic(4), { maxDeadExports: 0 });
    const rule = ruleById(report, 'maxDeadExports');

    expect(rule.note).toMatch(/4 computed dynamic imports in 1 file/);
    expect(renderCheck(report)).toMatch(/4 computed dynamic imports in 1 file/);
  });

  it('adds no note when the repo has none', () => {
    const rule = ruleById(evaluateCheck(graphWithDynamic(0), { maxDeadExports: 0 }), 'maxDeadExports');
    expect(rule.note).toBeUndefined();
  });
});
