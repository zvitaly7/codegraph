// The output pipeline shared by `brief`, `impact` and `outline`.
//
// One answer, two knobs, and they compose in a fixed order:
//
//   1. PATH COMPRESSION factors shared directory prefixes out of the answer's
//      path lists (see ./path_compress.mjs). Lossless — a reader can rebuild
//      every full path — and it only engages where it pays.
//   2. A TOKEN BUDGET then shrinks the answer until its rendering fits
//      `--max-tokens` (see ./answer_budget.mjs), cutting the least important
//      sections first and saying so in the output.
//
// The order matters: the budget measures what the caller will actually emit, so
// compression happens INSIDE the render it measures. Otherwise a compressed
// answer would be cut as if it were still the larger uncompressed one.
//
// Pure apart from mutating `payload` (which is how truncation is expressed) —
// callers pass an answer they just built and own.

import { compressAnswerPaths } from './path_compress.mjs';
import { budgetBlock, fitPayload, headerFloor } from './answer_budget.mjs';

/**
 * Compress, budget, render.
 *
 * @param {object} payload a freshly built answer. MUTATED by the budget step.
 * @param {object} o
 * @param {'text'|'json'} [o.mode] which rendering the budget is measured against.
 * @param {boolean} [o.compress] turn path-prefix factoring on.
 * @param {number|null} [o.maxTokens] the cap; null/absent means no cap.
 * @param {Array<{get: Function, key: string}>} [o.pathLists] compressible lists.
 * @param {Array<object>} [o.sections] budget sections (see fitPayload).
 * @param {(p: object) => string} [o.format] text renderer, required for `text` mode.
 * @param {number} [o.jsonSpace] `JSON.stringify` indent for `json` mode — the
 *   budget must measure the bytes the caller will really print, and `--json`
 *   pretty-prints while an MCP tool result does not.
 * @param {object} [o.compressOpts] threshold overrides for compressPaths.
 * @returns {{text: string, payload: object, approxTokens: number, maxTokens: number|null,
 *   truncated: boolean, truncatedSections: string[], overBudget: boolean}}
 *   `payload` is what an MCP tool should emit: compressed, budgeted, and
 *   carrying its own `budget` block when a cap was given. `text` is the exact
 *   string the CLI should print, in either mode.
 */
export function fitAnswer(payload, {
  mode = 'text', compress = false, maxTokens = null,
  pathLists = [], sections = [], format, jsonSpace = 0, compressOpts = {},
} = {}) {
  const cap = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null;
  const prepare = (p) => {
    const compressed = compressAnswerPaths(p, pathLists, { ...compressOpts, compress });
    return cap === null ? compressed : { ...compressed, budget: budgetBlock(p, { sections, maxTokens: cap }) };
  };

  const render = mode === 'json'
    ? (p) => JSON.stringify(prepare(p), null, jsonSpace)
    : (p) => format(compressAnswerPaths(p, pathLists, { ...compressOpts, compress }));

  const fit = fitPayload(payload, {
    sections,
    render,
    maxTokens: cap,
    floor: mode === 'json' ? undefined : (p, cut) => headerFloor(render(p), cut, { maxTokens: cap }),
  });

  // A cap can be impossible to meet — the identifying header is never dropped.
  // Record that in the payload as well as in the returned metadata, so an MCP
  // caller who reads nothing but the JSON still learns the cap was missed.
  const finalPayload = prepare(payload);
  if (fit.overBudget && finalPayload?.budget) finalPayload.budget.overBudget = true;

  return {
    ...fit,
    payload: finalPayload,
    text: mode === 'json' ? JSON.stringify(finalPayload, null, jsonSpace) : fit.text,
  };
}

// ---- CLI flag plumbing --------------------------------------------------

/**
 * Whether path compression is on unless a caller says otherwise.
 *
 * Measured, not assumed: see the "Path prefix compression" section of
 * bench/README.md for the numbers this value comes from.
 */
export const COMPRESS_PATHS_DEFAULT = false;

/**
 * Resolve `--compress-paths` / `--no-compress-paths` / `compressPaths` in the
 * config file, in that order of precedence. `parseArgs` has no notion of a
 * `--no-` negation, so the off switch arrives as its own flag.
 * @param {object} flags `cfg._flags`.
 * @param {object} cfg the resolved config.
 */
export function resolveCompressPaths(flags = {}, cfg = {}) {
  if (flags['no-compress-paths'] === true) return false;
  if (flags['compress-paths'] === true) return true;
  if (typeof cfg.compressPaths === 'boolean') return cfg.compressPaths;
  return COMPRESS_PATHS_DEFAULT;
}

/**
 * Parse `--max-tokens N`.
 * @returns {{value: number|null}|{error: string}} `value: null` means "no cap".
 */
export function resolveMaxTokens(flags = {}) {
  const raw = flags['max-tokens'];
  if (raw === undefined) return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { error: `--max-tokens must be a positive integer, got ${raw}` };
  return { value: n };
}

/** The two flags every budget-aware command declares, for `resolveConfig`. */
export const ANSWER_OPTIONS = {
  'max-tokens': { type: 'string' },
  'compress-paths': { type: 'boolean' },
  'no-compress-paths': { type: 'boolean' },
};
