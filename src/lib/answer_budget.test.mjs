import { describe, it, expect } from 'vitest';
import {
  BUDGET_MARKER, BUDGET_NOTE, approxTokens, moreMarker,
  budgetBlock, fitPayload, headerFloor, truncatedSectionsOf,
} from './answer_budget.mjs';

/** A three-section payload: a fixed header plus two lists of known size. */
function payloadOf(aCount = 40, bCount = 40) {
  return {
    header: 'FILE src/example.ts',
    alpha: { count: aCount, files: Array.from({ length: aCount }, (_, i) => `alpha/file-${i}.ts`) },
    beta: { count: bCount, files: Array.from({ length: bCount }, (_, i) => `beta/file-${i}.ts`) },
  };
}

/** Least important first: beta is cut before alpha. */
const SECTIONS = [
  { id: 'alpha', drop: 1, get: (p) => p.alpha, key: 'files' },
  { id: 'beta', drop: 2, get: (p) => p.beta, key: 'files' },
];

function renderText(p) {
  const line = (label, box) => {
    const hidden = box.count - box.files.length;
    const marker = moreMarker(hidden, { budget: box.budgetTruncated === true });
    return `${label} (${box.count}): ${[...box.files, marker].filter(Boolean).join(', ')}`;
  };
  return [p.header, line('alpha', p.alpha), line('beta', p.beta)].join('\n');
}

describe('approxTokens', () => {
  it('is the ~4-chars-per-token approximation, rounded up', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('abcde')).toBe(2);
  });
});

describe('moreMarker', () => {
  it('says nothing when nothing is hidden', () => {
    expect(moreMarker(0)).toBe('');
    expect(moreMarker(-1)).toBe('');
  });

  it('distinguishes a --limit cut from a --max-tokens cut', () => {
    expect(moreMarker(7)).toBe('(+7 more)');
    expect(moreMarker(7, { budget: true })).toBe(`(+7 more, ${BUDGET_MARKER})`);
  });
});

describe('fitPayload — no cap, or already small enough', () => {
  it('touches nothing when no cap is given', () => {
    const p = payloadOf();
    const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: undefined });
    expect(fit.truncated).toBe(false);
    expect(fit.maxTokens).toBeNull();
    expect(p.alpha.files).toHaveLength(40);
    expect(fit.text).toBe(renderText(payloadOf()));
  });

  it('touches nothing when the full answer already fits', () => {
    const p = payloadOf(2, 2);
    const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: 10_000 });
    expect(fit.truncated).toBe(false);
    expect(fit.truncatedSections).toEqual([]);
    expect(p.beta.files).toHaveLength(2);
  });

  it('ignores a nonsensical cap rather than truncating to nothing', () => {
    for (const bad of [0, -5, Number.NaN, Infinity, 'lots']) {
      const p = payloadOf(5, 5);
      const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: bad });
      expect(fit.truncated).toBe(false);
      expect(p.alpha.files).toHaveLength(5);
    }
  });
});

describe('fitPayload — stays under the cap', () => {
  // 40 is already close to the floor for this payload — three lines of
  // header and markers. Below that, see the floor cases further down.
  const CAPS = [400, 300, 200, 120, 80, 40];

  for (const cap of CAPS) {
    it(`a large answer under --max-tokens ${cap} stays under the cap`, () => {
      const p = payloadOf(60, 60);
      const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: cap });
      expect(fit.approxTokens).toBeLessThanOrEqual(cap);
      expect(approxTokens(fit.text)).toBeLessThanOrEqual(cap);
      expect(fit.overBudget).toBe(false);
    });
  }

  it('marks the cut visibly, with the untruncated count intact', () => {
    const p = payloadOf(60, 60);
    const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: 200 });
    expect(fit.truncated).toBe(true);
    expect(fit.text).toContain(BUDGET_MARKER);
    expect(fit.text).toContain('beta (60)');
  });
});

describe('fitPayload — drops least-important-first', () => {
  it('cuts the higher-drop section first and leaves the other whole', () => {
    const p = payloadOf(60, 60);
    const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: 300 });
    expect(fit.truncatedSections).toEqual(['beta']);
    expect(p.alpha.files).toHaveLength(60);
    expect(p.beta.files.length).toBeLessThan(60);
  });

  it('only reaches the more important section once the other is empty', () => {
    const p = payloadOf(60, 60);
    const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: 60 });
    expect(p.beta.files).toHaveLength(0);
    expect(p.alpha.files.length).toBeLessThan(60);
    expect(fit.truncatedSections).toEqual(['alpha', 'beta']);
  });

  it('reports sections in output order, not in drop order', () => {
    const p = payloadOf(60, 60);
    const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: 60 });
    expect(fit.truncatedSections).toEqual(SECTIONS.map((s) => s.id));
  });

  it('breaks a drop-rank tie by section id, deterministically', () => {
    const sections = [
      { id: 'zeta', drop: 1, get: (p) => p.alpha, key: 'files' },
      { id: 'alpha', drop: 1, get: (p) => p.beta, key: 'files' },
    ];
    const first = fitPayload(payloadOf(60, 60), { sections, render: renderText, maxTokens: 300 });
    const again = fitPayload(payloadOf(60, 60), { sections, render: renderText, maxTokens: 300 });
    expect(first.truncatedSections).toEqual(again.truncatedSections);
    // Ties break on ascending id, so `alpha` goes before `zeta`.
    expect(first.truncatedSections).toEqual(['alpha']);
  });
});

describe('fitPayload — determinism', () => {
  it('truncates the same input identically, every time', () => {
    const runs = Array.from({ length: 5 }, () => fitPayload(payloadOf(60, 60), {
      sections: SECTIONS, render: renderText, maxTokens: 220,
    }).text);
    expect(new Set(runs).size).toBe(1);
  });

  it('a larger cap never yields less content than a smaller one', () => {
    const sizes = [80, 120, 200, 400, 800].map((cap) => fitPayload(payloadOf(60, 60), {
      sections: SECTIONS, render: renderText, maxTokens: cap,
    }).text.length);
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
  });

  it('keeps a prefix of each list — never a sample from the middle', () => {
    const p = payloadOf(60, 60);
    fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: 300 });
    expect(p.beta.files).toEqual(payloadOf(60, 60).beta.files.slice(0, p.beta.files.length));
  });
});

describe('fitPayload — the floor', () => {
  it('still produces something valid when only the header can fit', () => {
    const p = payloadOf(60, 60);
    const fit = fitPayload(p, {
      sections: SECTIONS,
      render: renderText,
      maxTokens: 8,
      floor: (payload, cut) => headerFloor(renderText(payload), cut),
    });
    expect(fit.text.split('\n')[0]).toBe('FILE src/example.ts');
    expect(fit.text).toContain(`2 section(s) omitted, ${BUDGET_MARKER}`);
    expect(fit.truncated).toBe(true);
  });

  it('does not crash, and does not lie, on an absurdly small cap', () => {
    const p = payloadOf(60, 60);
    const fit = fitPayload(p, {
      sections: SECTIONS,
      render: renderText,
      maxTokens: 1,
      floor: (payload, cut) => headerFloor(renderText(payload), cut),
    });
    expect(fit.text.length).toBeGreaterThan(0);
    // Over the cap — and it says so rather than pretending to have obeyed.
    expect(fit.overBudget).toBe(true);
    expect(fit.approxTokens).toBeGreaterThan(1);
  });

  it('falls back to the all-empty rendering when no floor is supplied', () => {
    const p = payloadOf(60, 60);
    const fit = fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: 8 });
    expect(fit.text).toContain('alpha (60)');
    expect(fit.text).toContain(BUDGET_MARKER);
  });

  it('tolerates a payload with no truncatable sections at all', () => {
    const p = { header: 'FILE src/example.ts' };
    const fit = fitPayload(p, { sections: [], render: (x) => x.header, maxTokens: 1 });
    expect(fit.text).toBe('FILE src/example.ts');
    expect(fit.overBudget).toBe(true);
  });

  it('skips a section whose container is missing from this payload shape', () => {
    const p = { header: 'H', alpha: { count: 3, files: ['a', 'b', 'c'] } };
    const sections = [...SECTIONS];
    const fit = fitPayload(p, {
      sections,
      render: (x) => `${x.header} ${x.alpha.files.join(',')}`,
      maxTokens: 1,
    });
    expect(approxTokens(fit.text)).toBeLessThanOrEqual(1);
    expect(fit.truncatedSections).toEqual(['alpha']);
  });
});

describe('budgetBlock / truncatedSectionsOf', () => {
  it('reads what was cut off the payload itself', () => {
    const p = payloadOf(60, 60);
    fitPayload(p, { sections: SECTIONS, render: renderText, maxTokens: 300 });
    expect(truncatedSectionsOf(p, SECTIONS)).toEqual(['beta']);
    expect(budgetBlock(p, { sections: SECTIONS, maxTokens: 300 })).toEqual({
      maxTokens: 300,
      truncated: true,
      truncatedSections: ['beta'],
      note: BUDGET_NOTE,
    });
  });

  it('reports an untouched payload as not truncated', () => {
    expect(budgetBlock(payloadOf(1, 1), { sections: SECTIONS, maxTokens: 900 })).toEqual({
      maxTokens: 900,
      truncated: false,
      truncatedSections: [],
      note: BUDGET_NOTE,
    });
  });

  it('lets a JSON render carry its own budget block and still respect the cap', () => {
    const p = payloadOf(60, 60);
    const render = (x) => JSON.stringify({ ...x, budget: budgetBlock(x, { sections: SECTIONS, maxTokens: 500 }) });
    const fit = fitPayload(p, { sections: SECTIONS, render, maxTokens: 500 });
    expect(fit.approxTokens).toBeLessThanOrEqual(500);
    const parsed = JSON.parse(fit.text);
    expect(parsed.budget.truncated).toBe(true);
    expect(parsed.budget.truncatedSections).toEqual(['beta']);
    expect(parsed.beta.count).toBe(60);
    expect(parsed.beta.budgetTruncated).toBe(true);
  });
});

describe('two sections sharing one container', () => {
  it('records each cut under its own flag', () => {
    const p = {
      header: 'H',
      imports: {
        counts: { internal: 30, external: 30 },
        internal: Array.from({ length: 30 }, (_, i) => `int-${i}`),
        external: Array.from({ length: 30 }, (_, i) => `ext-${i}`),
      },
    };
    const sections = [
      { id: 'internal', drop: 1, get: (x) => x.imports, key: 'internal', flag: 'internalTruncated' },
      { id: 'external', drop: 2, get: (x) => x.imports, key: 'external', flag: 'externalTruncated' },
    ];
    const render = (x) => `${x.header} ${x.imports.internal.join(',')} | ${x.imports.external.join(',')}`;
    fitPayload(p, { sections, render, maxTokens: 55 });
    expect(p.imports.externalTruncated).toBe(true);
    expect(p.imports.internalTruncated).toBeUndefined();
    expect(truncatedSectionsOf(p, sections)).toEqual(['external']);
  });
});
