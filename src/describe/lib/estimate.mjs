// What this run will cost, printed BEFORE anything is spent.
//
// Two honesty rules govern this file:
//
//   - Token counts are an ESTIMATE and say so. There is no tokenizer in
//     loregraph's runtime dependencies, so we use the ~4-chars-per-token rule
//     of thumb. It is labelled `~` everywhere it appears.
//
//   - A price is only ever quoted when we actually have one, with the date we
//     had it. An unknown model — and every OpenAI model, whose prices we do not
//     track — reports "unknown", never a made-up number. `describe.pricing` in
//     the config lets anyone supply their own rates and get a real figure.
//
// The quoted figure is an UPPER BOUND: output is capped at MAX_OUTPUT_TOKENS
// per item and most descriptions come in far under it, so a run typically costs
// less than the estimate. Never more.

import { MAX_OUTPUT_TOKENS } from './provider.mjs';

/** Characters per token, the standard rough approximation. */
const CHARS_PER_TOKEN = 4;

/**
 * Published list prices in USD per million tokens, and the date we recorded
 * them. Only models we can attribute to a dated source are here; everything
 * else reports an unknown cost, which is the correct answer.
 *
 * Sonnet's introductory discount is deliberately NOT applied — quoting the
 * standard rate keeps the estimate an upper bound.
 */
export const PRICES = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
};

/** When the table above was recorded. Printed with every quoted price. */
export const PRICES_AS_OF = '2026-06-24';

/** Rough token count for a string. Deliberately approximate; always shown as `~`. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

/** `1234` → `1,234`. */
function commas(n) {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Price a run, or say we cannot.
 *
 * @param {{inputTokens: number, outputTokens: number}} tokens
 * @param {{model?: string, pricing?: {input: number, output: number}}} opts
 *   `pricing` is the user's own USD-per-million rates from the config, which
 *   always win over the built-in table.
 * @returns {{known: boolean, usd?: number, source?: string, reason?: string}}
 */
export function priceRun({ inputTokens, outputTokens }, { model, pricing } = {}) {
  const rate = (pricing && Number.isFinite(pricing.input) && Number.isFinite(pricing.output))
    ? { rate: pricing, source: 'describe.pricing from your config' }
    : (Object.hasOwn(PRICES, model)
      ? { rate: PRICES[model], source: `published list price as of ${PRICES_AS_OF}` }
      : null);

  if (!rate) {
    return {
      known: false,
      reason: `no price on record for "${model ?? 'this provider'}" — set describe.pricing `
        + '{ input, output } (USD per million tokens) in loregraph.config.mjs for a figure',
    };
  }
  const usd = (inputTokens / 1e6) * rate.rate.input + (outputTokens / 1e6) * rate.rate.output;
  return { known: true, usd, source: rate.source };
}

/**
 * Estimate a whole run from the prompts it would send.
 *
 * @param {string[]} prompts one per item that would actually be described
 *   (cached items are excluded by the caller — they cost nothing).
 * @param {{model?: string, provider?: string, pricing?: object}} [opts]
 * @returns {object} the estimate payload, also used by `--json`.
 */
export function estimateRun(prompts, { model, provider, pricing } = {}) {
  const inputTokens = prompts.reduce((sum, p) => sum + estimateTokens(p), 0);
  const outputTokens = prompts.length * MAX_OUTPUT_TOKENS;
  return {
    items: prompts.length,
    inputTokens,
    outputTokens,
    maxOutputTokensPerItem: MAX_OUTPUT_TOKENS,
    model: model ?? null,
    provider: provider ?? null,
    cost: priceRun({ inputTokens, outputTokens }, { model, pricing }),
  };
}

/**
 * Render the estimate as the block printed before the confirmation prompt.
 * @param {object} est from `estimateRun`.
 * @param {{cached?: number, skipped?: number}} [counts] context lines.
 */
export function formatEstimate(est, { cached = 0, totals } = {}) {
  const lines = [
    `provider:      ${est.provider ?? 'unknown'}`,
    `model:         ${est.model ?? 'unspecified'}`,
    `to describe:   ${est.items} item(s)${cached > 0 ? `  (${cached} already cached and unchanged — free)` : ''}`,
  ];
  if (totals) {
    const totalLine = Object.entries(totals).map(([k, n]) => `${k}=${n}`).join(' ');
    if (totalLine) lines.push(`in the graph:  ${totalLine}`);
  }
  lines.push(
    `input tokens:  ~${commas(est.inputTokens)}   (estimated at ~${CHARS_PER_TOKEN} chars/token)`,
    `output tokens: ~${commas(est.outputTokens)}  (upper bound: ${est.maxOutputTokensPerItem}/item)`,
  );
  lines.push(est.cost.known
    ? `cost:          ~$${est.cost.usd.toFixed(4)} at most  (${est.cost.source})`
    : `cost:          unknown — ${est.cost.reason}`);
  return lines.join('\n');
}
