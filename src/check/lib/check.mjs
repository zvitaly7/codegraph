// The `loregraph check` rule engine — the part that turns a description of the
// repo into a verdict on it.
//
// `evaluateCheck(graph, check, opts)` is PURE: it reads the loaded graph and the
// `check` block of `loregraph.config.mjs`, and returns one row per configured
// rule with its verdict and the specific offenders behind a failure. Nothing
// here exits, prints or reads the filesystem — `../run.mjs` does all three.
//
// Two design rules the whole thing hangs on:
//
//   1. A GREEN CHECK THAT CHECKED NOTHING IS A LIE. With no rules configured the
//      report is not "passed" — it is `configured: false` plus the list of rules
//      that could have run. A mistyped rule name is caught by `unknownRuleKeys`
//      and a rule whose layer is missing from the cache by `missingPrerequisites`,
//      both of which the CLI turns into a usage error rather than a green tick.
//
//   2. A FAILURE MUST BE ACTIONABLE. Every failing rule names the offenders —
//      the ring of a cycle, the dead export by name and line, and, for a
//      `domainRules` violation, the ACTUAL file→file imports that created the
//      forbidden domain edge. "ui must not depend on server" is not something you
//      can go and fix; `src/ui/a.ts → src/server/db.ts` is.

import { buildCycles, SCOPES as CYCLE_SCOPES } from '../../lib/cycles.mjs';
// The same dead-export implementation the MCP tool and the explorer use — which
// is how `maxDeadExports` inherits the entry-point exclusions for free, instead
// of growing a second, subtly different definition of "dead".
import { deadExports } from '../../mcp/lib/tools.mjs';

/** Every key the `check` config block understands. */
export const RULE_KEYS = ['noCycles', 'maxDeadExports', 'minResolutionRate', 'domainRules'];

/** How many offenders a failing rule lists before "+N more". */
export const DEFAULT_MAX_OFFENDERS = 10;

/** Which graph layer each rule cannot answer without. */
const RULE_LAYER = {
  maxDeadExports: 'references',
  minResolutionRate: 'imports',
  domainRules: 'domains',
};

/** Keys in the `check` block that are not rules — almost always a typo. */
export function unknownRuleKeys(check = {}) {
  return Object.keys(check ?? {}).filter((k) => !RULE_KEYS.includes(k));
}

/** The scope a `noCycles` value asks for (`true` means both). */
function cycleScope(value) {
  const scope = value === true ? 'both' : value?.scope ?? 'both';
  return CYCLE_SCOPES.includes(scope) ? scope : 'both';
}

/**
 * Layers a configured rule needs that `loadedLayers` does not have.
 * @returns {Array<{rule: string, layer: string}>} in RULE_KEYS order.
 */
export function missingPrerequisites(check = {}, loadedLayers = []) {
  const missing = [];
  const need = (rule, layer) => {
    if (!loadedLayers.includes(layer)) missing.push({ rule, layer });
  };
  for (const key of RULE_KEYS) {
    if (check?.[key] === undefined || check[key] === null || check[key] === false) continue;
    if (key === 'noCycles') {
      const scope = cycleScope(check.noCycles);
      if (scope === 'file' || scope === 'both') need('noCycles', 'imports');
      if (scope === 'domain' || scope === 'both') need('noCycles', 'domains');
    } else {
      need(key, RULE_LAYER[key]);
    }
  }
  return missing;
}

/** `a → b → a` — a cycle's ring, closed. */
function ring(members) {
  return [...members, members[0]].join(' → ');
}

/** Cap a list, remembering how long it really was. */
function cap(list, max) {
  return { offenders: list.slice(0, max), offendersTotal: list.length };
}

// ---- individual rules ---------------------------------------------------

function evalNoCycles(graph, value, max) {
  const scope = cycleScope(value);
  const report = buildCycles(graph, { scope, limit: Math.max(max, DEFAULT_MAX_OFFENDERS) });
  const lines = [];
  for (const section of [report.file, report.domain]) {
    if (!section) continue;
    for (const c of section.cycles) {
      const weight = c.minWeight === undefined ? '' : `  [weight min ${c.minWeight}, total ${c.totalWeight}]`;
      lines.push(`${section.scope}: ${ring(c.members)}${weight}`);
    }
  }
  const total = report.total;
  return {
    id: 'noCycles',
    title: `noCycles (scope: ${scope})`,
    ok: total === 0,
    detail: total === 0
      ? `no cycles in scope ${scope}`
      : `${total} cycle${total === 1 ? '' : 's'} in scope ${scope}`,
    ...cap(lines, max),
  };
}

function evalMaxDeadExports(graph, budget, max) {
  const found = deadExports(graph, { limit: Math.max(max, DEFAULT_MAX_OFFENDERS) });
  const excluded = found.entryPointExclusions ?? 0;
  const lines = found.candidates.map((c) => `${c.path}:${c.line} ${c.name} (${c.kind})`);
  return {
    id: 'maxDeadExports',
    title: `maxDeadExports (budget: ${budget})`,
    ok: found.total <= budget,
    detail: `${found.total} dead export${found.total === 1 ? '' : 's'} vs a budget of ${budget}`
      + `; ${excluded} excluded as entry-point exports`,
    ...cap(lines, max),
    // `found.total` is already post-exclusion; `capped` reflects the listing cap.
    offendersTotal: found.total,
  };
}

function evalMinResolutionRate(floor, rate) {
  const shown = rate === null ? 'unknown' : rate.toFixed(4);
  return {
    id: 'minResolutionRate',
    title: `minResolutionRate (floor: ${floor})`,
    ok: rate !== null && rate >= floor,
    detail: `imports resolved ${shown}, floor ${floor}`,
    offenders: [],
    offendersTotal: 0,
  };
}

/** Repo-relative path behind a `file:` id. */
const pathOf = (id) => (id.startsWith('file:') ? id.slice('file:'.length) : id);

/**
 * One architectural boundary. A forbidden `DEPENDS_ON` edge is the finding; the
 * file→file imports underneath it are what makes the finding fixable.
 */
function evalDomainRule(graph, rule, index, max) {
  const from = typeof rule?.from === 'string' ? rule.from : '';
  const forbidden = (Array.isArray(rule?.mustNotDependOn)
    ? rule.mustNotDependOn
    : [rule?.mustNotDependOn]).filter((d) => typeof d === 'string');
  const fromId = `domain:${from}`;
  const row = {
    id: `domainRules[${index}]`,
    title: `domainRules: ${from} must not depend on ${forbidden.join(', ') || '(nothing declared)'}`,
  };

  if (!graph.nodesById.has(fromId)) {
    return {
      ...row,
      ok: true,
      detail: `no DEPENDS_ON edge from ${from}`,
      note: `domain "${from}" is not in the graph — this rule matched nothing`,
      offenders: [],
      offendersTotal: 0,
    };
  }

  const forbiddenIds = new Set(forbidden.map((d) => `domain:${d}`));
  const hits = graph.neighbors(fromId, { dir: 'out', type: 'DEPENDS_ON' })
    .filter((e) => forbiddenIds.has(e.to));
  if (hits.length === 0) {
    return { ...row, ok: true, detail: `no DEPENDS_ON edge from ${from} to ${forbidden.join(', ')}`, offenders: [], offendersTotal: 0 };
  }

  // Which file BELONGS_TO which domain — the evidence behind each edge.
  const domainOfFile = new Map();
  for (const e of graph.byType('BELONGS_TO')) domainOfFile.set(e.from, e.to);
  const offenders = graph.byType('IMPORTS')
    .filter((e) => e.to.startsWith('file:')
      && domainOfFile.get(e.from) === fromId
      && forbiddenIds.has(domainOfFile.get(e.to)))
    .map((e) => `${pathOf(e.from)} → ${pathOf(e.to)}`)
    .sort();

  const targets = hits.map((e) => e.to.replace(/^domain:/, '')).sort();
  return {
    ...row,
    ok: false,
    detail: `${from} depends on ${targets.join(', ')} via ${offenders.length} import${offenders.length === 1 ? '' : 's'}`,
    ...cap([...new Set(offenders)], max),
  };
}

// ---- the engine ---------------------------------------------------------

/**
 * Evaluate the `check` config block against a loaded graph.
 *
 * @param {object} graph loaded graph (see ../../lib/graph_load.mjs).
 * @param {object} check the `check` block; `{}` means nothing configured.
 * @param {{resolutionRate?: number|null, maxOffenders?: number}} [opts]
 * @returns {object} `{ configured, ok, counts, rules, available, note? }`.
 */
export function evaluateCheck(graph, check = {}, opts = {}) {
  const max = Number.isInteger(opts.maxOffenders) && opts.maxOffenders > 0
    ? opts.maxOffenders
    : DEFAULT_MAX_OFFENDERS;
  const cfg = check ?? {};
  const rules = [];

  if (cfg.noCycles !== undefined && cfg.noCycles !== null && cfg.noCycles !== false) {
    rules.push(evalNoCycles(graph, cfg.noCycles, max));
  }
  if (Number.isFinite(cfg.maxDeadExports)) {
    rules.push(evalMaxDeadExports(graph, cfg.maxDeadExports, max));
  }
  if (Number.isFinite(cfg.minResolutionRate)) {
    rules.push(evalMinResolutionRate(cfg.minResolutionRate, opts.resolutionRate ?? null));
  }
  if (Array.isArray(cfg.domainRules)) {
    cfg.domainRules.forEach((rule, i) => rules.push(evalDomainRule(graph, rule, i, max)));
  }

  const failed = rules.filter((r) => !r.ok).length;
  const report = {
    configured: rules.length > 0,
    ok: failed === 0,
    counts: { evaluated: rules.length, passed: rules.length - failed, failed },
    rules,
    available: [...RULE_KEYS],
  };
  if (rules.length === 0) {
    report.note = 'No check rules configured — nothing was verified. Add a `check` block to '
      + `loregraph.config.mjs to gate a build on any of: ${RULE_KEYS.join(', ')}.`;
  }
  return report;
}

/** One-line example per rule, printed when nothing is configured. */
const RULE_EXAMPLES = {
  noCycles: "noCycles: true            // or { scope: 'file' | 'domain' | 'both' }",
  maxDeadExports: 'maxDeadExports: 0         // fail when unreferenced exports exceed N',
  minResolutionRate: 'minResolutionRate: 0.95   // fail when the imports layer resolved less',
  domainRules: "domainRules: [{ from: 'ui', mustNotDependOn: ['server', 'db'] }]",
};

/** Human-readable form of an `evaluateCheck` report. */
export function renderCheck(report) {
  if (!report.configured) {
    return [
      'CHECK  nothing configured — no rules were evaluated, so nothing was verified.',
      '',
      'Add a `check` block to loregraph.config.mjs. Available rules:',
      ...RULE_KEYS.map((k) => `  ${RULE_EXAMPLES[k]}`),
    ].join('\n');
  }

  const { evaluated, passed, failed } = report.counts;
  const lines = [
    `CHECK  ${evaluated} rule${evaluated === 1 ? '' : 's'} evaluated · ${passed} passed · ${failed} failed`,
    '',
  ];
  for (const rule of report.rules) {
    lines.push(`${rule.ok ? 'PASS' : 'FAIL'}  ${rule.title}`);
    lines.push(`      ${rule.detail}`);
    if (rule.note) lines.push(`      note: ${rule.note}`);
    for (const offender of rule.offenders) lines.push(`      - ${offender}`);
    const hidden = rule.offendersTotal - rule.offenders.length;
    if (hidden > 0) lines.push(`      … +${hidden} more`);
    lines.push('');
  }
  lines.push(report.ok ? 'CHECK PASSED' : `CHECK FAILED — ${failed} rule${failed === 1 ? '' : 's'} violated`);
  return lines.join('\n');
}
