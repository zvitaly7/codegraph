// `--max-tokens N` — a cap the caller chooses on how big an answer may be.
//
// Three properties, in the order they matter:
//
//   VISIBLE. A truncated answer never looks like a complete one. Every list
//   that lost items keeps its real, untruncated count and gains
//   `(+N more, truncated to fit --max-tokens)`. In `--json` the same fact is a
//   `budgetDropped: N` field on the affected container plus one `budget` block
//   naming every section that was cut — and saying so when the cap could not be
//   met at all.
//
//   DETERMINISTIC. Sections are cut in a fixed, declared order — least
//   important first — and the same input under the same cap always produces
//   byte-identical output. There is no sampling and no "whatever fits".
//
//   APPROXIMATE, AND SAID SO. Token counts use the same ~4-chars-per-token rule
//   of thumb as `loregraph describe` (there is no tokenizer in the runtime
//   dependencies, on purpose). Being a little under the cap is fine; going over
//   it silently is not — when even the header cannot fit, the answer says so
//   rather than pretending.
//
// Pure: no I/O, no throwing. `fitPayload` DOES mutate the payload it is given
// (that is how truncation is expressed); callers pass a payload they own.

import { estimateTokens } from '../describe/lib/estimate.mjs';

/** The phrase that marks every budget-driven cut. One spelling, everywhere. */
export const BUDGET_MARKER = 'truncated to fit --max-tokens';

/** What the `budget` block in `--json` says about its own accuracy. */
export const BUDGET_NOTE = 'approximate: ~4 chars/token';

/** Rough token count of a rendered answer. Deliberately the `describe` estimator. */
export const approxTokens = estimateTokens;

/**
 * `(+N more)` — or the budget-marked form when the items went missing because
 * of `--max-tokens` rather than because of `--limit`.
 * @param {number} hidden how many items are not shown.
 * @param {{budget?: boolean}} [opts]
 * @returns {string} the marker, or `''` when nothing is hidden.
 */
export function moreMarker(hidden, { budget = false } = {}) {
  if (!(hidden > 0)) return '';
  return budget ? `(+${hidden} more, ${BUDGET_MARKER})` : `(+${hidden} more)`;
}

/**
 * How many items a cut took, recorded on the container. One field, not two: a
 * positive count already says "truncated", and it is the number the `(+N more)`
 * marker needs for the lists whose container carries no untruncated `count`.
 */
const DEFAULT_DROPPED = 'budgetDropped';

const droppedOf = (section) => section.dropped ?? DEFAULT_DROPPED;

/**
 * Which sections are currently cut, in output order. Read off the payload, so a
 * `budget` block built with it can never disagree with the lists themselves.
 * @param {object} payload
 * @param {Array<object>} sections see `fitPayload`.
 * @returns {string[]} section ids.
 */
export function truncatedSectionsOf(payload, sections) {
  return sections.filter((s) => (s.get(payload)?.[droppedOf(s)] ?? 0) > 0).map((s) => s.id);
}

/**
 * The `budget` block for a `--json` answer. Built from the payload's own flags
 * and therefore safe to include INSIDE the render that gets measured — no
 * chicken-and-egg between "how big is it" and "what does it say it is".
 * @returns {{maxTokens: number, truncated: boolean, truncatedSections: string[], note: string}}
 */
export function budgetBlock(payload, { sections, maxTokens }) {
  const cut = truncatedSectionsOf(payload, sections);
  return {
    maxTokens,
    truncated: cut.length > 0,
    truncatedSections: cut,
    note: BUDGET_NOTE,
  };
}

/**
 * The floor: when not even one line per section fits, keep the ONE line that
 * says what the answer is about and state plainly what is missing.
 *
 * A cap small enough to reach this point may be smaller than the header itself.
 * The header is never dropped — an answer with no subject is not an answer — so
 * in that case the note says the cap was MISSED rather than quietly implying it
 * was met.
 *
 * @param {string} text the full rendering (its first line identifies the target).
 * @param {string[]} omitted section ids that were cut.
 * @param {{maxTokens?: number|null}} [opts]
 */
export function headerFloor(text, omitted, { maxTokens = null } = {}) {
  const head = String(text ?? '').split('\n', 1)[0];
  const fitted = `${head}\n(${omitted.length} section(s) omitted, ${BUDGET_MARKER})`;
  if (maxTokens === null || approxTokens(fitted) <= maxTokens) return fitted;
  return `${head}\n(${omitted.length} section(s) omitted; this header alone is `
    + `~${approxTokens(head)} tokens, OVER --max-tokens=${maxTokens})`;
}

/**
 * Shrink `payload` until its rendering fits `maxTokens`.
 *
 * The algorithm, in full:
 *   1. Render everything. Fits → done, nothing touched.
 *   2. Otherwise walk the sections in drop order (highest `drop` first, ties by
 *      id) and empty each one in turn, re-rendering after each. As soon as it
 *      fits, hand items BACK to the section that just got emptied — the largest
 *      prefix of it that still fits — and stop.
 *   3. Everything emptied and still over the cap → `floor(payload, cut)`, or
 *      the all-empty rendering when no floor is supplied. `overBudget` says
 *      whether even that exceeded the cap.
 *
 * @param {object} payload MUTATED: each cut list is replaced by its kept prefix
 *   and its container gains the section's truncation flag.
 * @param {object} o
 * @param {Array<{id: string, drop: number, get: (p: object) => object|undefined,
 *   key: string, dropped?: string}>} o.sections
 *   `get(payload)` is the container, `key` its list field, `drop` the rank
 *   (HIGHER = cut earlier) and `dropped` the field that records how many items
 *   the cut took (default `budgetDropped`). Two sections sharing one container
 *   must name different `dropped` fields.
 * @param {(p: object) => string} o.render renders the payload as the caller will emit it.
 * @param {number} o.maxTokens the cap; a non-positive or non-finite value means "no cap".
 * @param {(p: object, cut: string[]) => string} [o.floor] step 3's last resort.
 * @returns {{text: string, approxTokens: number, maxTokens: number|null,
 *   truncated: boolean, truncatedSections: string[], overBudget: boolean}}
 */
export function fitPayload(payload, { sections = [], render, maxTokens, floor } = {}) {
  const cap = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null;
  const answer = (text, truncated) => ({
    text,
    approxTokens: approxTokens(text),
    maxTokens: cap,
    truncated,
    truncatedSections: truncatedSectionsOf(payload, sections),
    overBudget: cap !== null && approxTokens(text) > cap,
  });

  const full = render(payload);
  if (cap === null || approxTokens(full) <= cap) return answer(full, false);

  // Only sections that actually hold something can give anything up.
  const live = sections
    .map((section) => ({ section, box: section.get(payload) }))
    .filter(({ section, box }) => box && Array.isArray(box[section.key]) && box[section.key].length > 0);

  const items = new Map(live.map(({ section, box }) => [section.id, box[section.key].slice()]));
  const keep = new Map(live.map(({ section }) => [section.id, items.get(section.id).length]));

  const apply = () => {
    for (const { section, box } of live) {
      const all = items.get(section.id);
      const n = keep.get(section.id);
      box[section.key] = all.slice(0, n);
      if (n < all.length) box[droppedOf(section)] = all.length - n;
      else delete box[droppedOf(section)];
    }
  };

  const order = [...live].sort((a, b) => b.section.drop - a.section.drop
    || (a.section.id < b.section.id ? -1 : 1));

  for (const { section } of order) {
    keep.set(section.id, 0);
    apply();
    let text = render(payload);
    if (approxTokens(text) > cap) continue;

    // It fits with this section empty — so give back as much of it as fits.
    // Adding items only ever grows the rendering, so the first n that overflows
    // is the boundary and stopping there is deterministic.
    const all = items.get(section.id);
    let best = 0;
    for (let n = 1; n <= all.length; n += 1) {
      keep.set(section.id, n);
      apply();
      const candidate = render(payload);
      if (approxTokens(candidate) > cap) break;
      best = n;
      text = candidate;
    }
    keep.set(section.id, best);
    apply();
    return answer(text, true);
  }

  // Every section is empty and the cap is still not met.
  const emptied = render(payload);
  const cut = truncatedSectionsOf(payload, sections);
  return answer(typeof floor === 'function' ? floor(payload, cut) : emptied, true);
}
