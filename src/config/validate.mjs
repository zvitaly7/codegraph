// Config validation for `loregraph.config.{mjs,json}`.
//
// A silently ignored key is the worst kind of configuration bug: the run
// succeeds, the setting does nothing, and nothing says so. `describe` makes
// that expensive — a mistyped `budget` or `pricing` key spends real money at
// defaults the user never chose. So every key is checked against the set the
// code actually reads, and a near miss names the key it probably meant.
//
// `validateConfig(fileCfg)` returns a list of problems; an empty list means the
// file only uses keys and value shapes that something in the codebase reads.

import { DEFAULTS } from './defaults.mjs';

/** Keys read from a config file. `lang`, `describe` and `check` are per-command. */
const TOP_LEVEL_KEYS = [...Object.keys(DEFAULTS), 'lang', 'describe', 'check'];

/** Keys of the `describe` block, mirroring what `describe/run.mjs` reads. */
const DESCRIBE_KEYS = ['command', 'model', 'scope', 'top', 'timeoutMs', 'pricing'];

/** USD per million tokens, in and out. */
const PRICING_KEYS = ['input', 'output'];

const INCREMENTAL_MODES = ['off', 'incremental'];
const VCS_MODES = ['auto', 'git', 'arc', 'none'];
const LANGS = ['en', 'ru'];

/** A near miss is worth naming; anything further apart is a different word. */
const MAX_SUGGESTION_DISTANCE = 3;

/** Levenshtein distance, iterative single-row. */
function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** The closest known key to `key`, or undefined when nothing is near. */
function nearest(key, known) {
  let best;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = distance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) { bestDistance = d; best = candidate; }
  }
  return bestDistance <= MAX_SUGGESTION_DISTANCE ? best : undefined;
}

function problem(key, message, suggestion) {
  return suggestion ? { key, message, suggestion } : { key, message };
}

/** Unknown keys of `obj`, reported under `prefix`. */
function unknownKeys(obj, known, prefix = '') {
  return Object.keys(obj)
    .filter((key) => !known.includes(key))
    .map((key) => problem(
      `${prefix}${key}`,
      `unknown config key "${prefix}${key}"`,
      nearest(key, known),
    ));
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Type/range checks for the keys whose values have a fixed shape. */
function checkTypes(cfg) {
  const problems = [];
  const oneOf = (key, allowed) => {
    if (cfg[key] !== undefined && !allowed.includes(cfg[key])) {
      problems.push(problem(key, `${key} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(cfg[key])}`));
    }
  };
  const stringArray = (key) => {
    if (cfg[key] !== undefined && !isStringArray(cfg[key])) {
      problems.push(problem(key, `${key} must be an array of strings`));
    }
  };

  stringArray('srcRoots');
  stringArray('entryPoints');
  oneOf('incremental', INCREMENTAL_MODES);
  oneOf('vcs', VCS_MODES);
  oneOf('lang', LANGS);

  if (cfg.describe !== undefined && !isPlainObject(cfg.describe)) {
    problems.push(problem('describe', 'describe must be an object'));
  }
  const pricing = isPlainObject(cfg.describe) ? cfg.describe.pricing : undefined;
  if (pricing !== undefined && isPlainObject(pricing)) {
    for (const key of PRICING_KEYS) {
      if (pricing[key] !== undefined && typeof pricing[key] !== 'number') {
        problems.push(problem(
          `describe.pricing.${key}`,
          `describe.pricing.${key} must be a number (USD per million tokens)`,
        ));
      }
    }
  }
  return problems;
}

/**
 * Validate a parsed config file.
 * @param {object} cfg the object a config file default-exported.
 * @returns {Array<{key: string, message: string, suggestion?: string}>} problems.
 */
export function validateConfig(cfg) {
  if (!isPlainObject(cfg)) return [];

  const problems = unknownKeys(cfg, TOP_LEVEL_KEYS);

  if (isPlainObject(cfg.describe)) {
    problems.push(...unknownKeys(cfg.describe, DESCRIBE_KEYS, 'describe.'));
    if (isPlainObject(cfg.describe.pricing)) {
      problems.push(...unknownKeys(cfg.describe.pricing, PRICING_KEYS, 'describe.pricing.'));
    }
  }

  problems.push(...checkTypes(cfg));
  return problems;
}

/** One multi-line message naming every problem, with the fix where known. */
export function formatProblems(problems, configPath) {
  const lines = [`invalid config in ${configPath}:`];
  for (const p of problems) {
    lines.push(p.suggestion ? `  ${p.message} — did you mean "${p.suggestion}"?` : `  ${p.message}`);
  }
  return lines.join('\n');
}
