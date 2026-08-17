import { describe, it, expect } from 'vitest';
import {
  estimateTokens, estimateRun, priceRun, formatEstimate, PRICES, PRICES_AS_OF,
} from './estimate.mjs';
import { MAX_OUTPUT_TOKENS } from './provider.mjs';

describe('estimateTokens', () => {
  it('approximates 4 characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });
});

describe('estimateRun', () => {
  it('sums input tokens and caps output per item', () => {
    const est = estimateRun(['a'.repeat(400), 'b'.repeat(800)], { model: 'claude-opus-5', provider: 'anthropic' });
    expect(est.items).toBe(2);
    expect(est.inputTokens).toBe(300);
    expect(est.outputTokens).toBe(2 * MAX_OUTPUT_TOKENS);
    expect(est.maxOutputTokensPerItem).toBe(MAX_OUTPUT_TOKENS);
  });

  it('is zero for an empty run', () => {
    const est = estimateRun([], { model: 'claude-opus-5' });
    expect(est).toMatchObject({ items: 0, inputTokens: 0, outputTokens: 0 });
    expect(est.cost.usd).toBe(0);
  });
});

describe('priceRun', () => {
  it('quotes a price for a model on record, naming the date it was recorded', () => {
    const cost = priceRun({ inputTokens: 1e6, outputTokens: 1e6 }, { model: 'claude-opus-5' });
    expect(cost.known).toBe(true);
    expect(cost.usd).toBeCloseTo(PRICES['claude-opus-5'].input + PRICES['claude-opus-5'].output, 6);
    expect(cost.source).toContain(PRICES_AS_OF);
  });

  it('says UNKNOWN rather than inventing a number for an unknown model', () => {
    const cost = priceRun({ inputTokens: 1000, outputTokens: 1000 }, { model: 'some-local-llama' });
    expect(cost.known).toBe(false);
    expect(cost.usd).toBeUndefined();
    expect(cost.reason).toContain('no price on record');
    expect(cost.reason).toContain('describe.pricing');
  });

  it('says UNKNOWN when there is no model at all (the --command case)', () => {
    expect(priceRun({ inputTokens: 10, outputTokens: 10 }, {}).known).toBe(false);
  });

  it("uses the user's own configured rates over the built-in table", () => {
    const cost = priceRun(
      { inputTokens: 1e6, outputTokens: 0 },
      { model: 'claude-opus-5', pricing: { input: 100, output: 200 } },
    );
    expect(cost.usd).toBeCloseTo(100, 6);
    expect(cost.source).toContain('your config');
  });

  it('ignores malformed configured pricing rather than computing nonsense', () => {
    const cost = priceRun({ inputTokens: 10, outputTokens: 10 }, { model: 'mystery', pricing: { input: 'free' } });
    expect(cost.known).toBe(false);
  });
});

describe('formatEstimate', () => {
  it('shows items, both token counts and a bounded cost', () => {
    const est = estimateRun(['x'.repeat(4000)], { model: 'claude-opus-5', provider: 'anthropic' });
    const text = formatEstimate(est, { cached: 3, totals: { domain: 22 } });
    expect(text).toContain('provider:      anthropic');
    expect(text).toContain('model:         claude-opus-5');
    expect(text).toContain('to describe:   1 item(s)');
    expect(text).toContain('3 already cached and unchanged — free');
    expect(text).toContain('in the graph:  domain=22');
    expect(text).toContain('input tokens:  ~1,000');
    expect(text).toContain(`output tokens: ~${MAX_OUTPUT_TOKENS}`);
    expect(text).toContain('at most');
  });

  it('prints "unknown" for a provider whose pricing we do not know', () => {
    const est = estimateRun(['abcd'], { model: 'unspecified', provider: 'command' });
    const text = formatEstimate(est);
    expect(text).toContain('cost:          unknown');
    expect(text).not.toMatch(/\$\d/);
  });

  it('labels the token counts as estimates', () => {
    const text = formatEstimate(estimateRun(['abcd'], { model: 'claude-opus-5' }));
    expect(text).toContain('~');
    expect(text).toContain('chars/token');
  });
});
