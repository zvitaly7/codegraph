import { describe, it, expect } from 'vitest';
import { validateConfig } from './validate.mjs';

describe('validateConfig — unknown keys', () => {
  it('accepts a config that only uses known keys', () => {
    expect(validateConfig({
      srcRoots: ['src', 'app'],
      outDir: '.kg-cache',
      incremental: 'incremental',
      entryPoints: ['src/index.ts'],
      lang: 'ru',
      describe: { command: 'llm', top: 20, pricing: { input: 3, output: 15 } },
      check: { noCycles: true },
    })).toEqual([]);
  });

  it('rejects an unknown top-level key', () => {
    const problems = validateConfig({ nonsenseKey: 42 });
    expect(problems).toHaveLength(1);
    expect(problems[0].key).toBe('nonsenseKey');
  });

  it('suggests the nearest known key for a near miss', () => {
    expect(validateConfig({ srcRoot: ['lib'] })[0].suggestion).toBe('srcRoots');
    expect(validateConfig({ entryPoint: [] })[0].suggestion).toBe('entryPoints');
  });

  it('offers no suggestion when nothing is close', () => {
    expect(validateConfig({ zzzzzzzz: 1 })[0].suggestion).toBeUndefined();
  });

  // `describe` is the one command that spends money, so a silently ignored
  // budget or pricing key is the expensive kind of typo.
  it('rejects an unknown key inside the describe block', () => {
    const problems = validateConfig({ describe: { timeout: 5000 } });
    expect(problems).toHaveLength(1);
    expect(problems[0].key).toBe('describe.timeout');
    expect(problems[0].suggestion).toBe('timeoutMs');
  });

  it('rejects an unknown key inside describe.pricing', () => {
    const problems = validateConfig({ describe: { pricing: { in: 3 } } });
    expect(problems).toHaveLength(1);
    expect(problems[0].key).toBe('describe.pricing.in');
    expect(problems[0].suggestion).toBe('input');
  });

  it('reports every unknown key, not just the first', () => {
    const problems = validateConfig({ aaa: 1, bbb: 2, describe: { ccc: 3 } });
    expect(problems.map((p) => p.key)).toEqual(['aaa', 'bbb', 'describe.ccc']);
  });
});

describe('validateConfig — types', () => {
  it('rejects srcRoots that is not an array of strings', () => {
    expect(validateConfig({ srcRoots: 'src' })[0].key).toBe('srcRoots');
    expect(validateConfig({ srcRoots: [1, 2] })[0].key).toBe('srcRoots');
  });

  it('rejects an out-of-range incremental mode', () => {
    const problems = validateConfig({ incremental: 'yes' });
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('incremental');
  });

  it('rejects a non-object describe block', () => {
    expect(validateConfig({ describe: 'on' })[0].key).toBe('describe');
  });

  it('accepts a null domains override (the auto-derive default)', () => {
    expect(validateConfig({ domains: null })).toEqual([]);
  });

  it('rejects entryPoints that is not an array of strings', () => {
    expect(validateConfig({ entryPoints: 'src/index.ts' })[0].key).toBe('entryPoints');
  });

  it('rejects an unsupported docs language', () => {
    expect(validateConfig({ lang: 'de' })[0].key).toBe('lang');
    expect(validateConfig({ lang: 'ru' })).toEqual([]);
  });

  it('rejects an unsupported vcs mode', () => {
    expect(validateConfig({ vcs: 'svn' })[0].key).toBe('vcs');
    expect(validateConfig({ vcs: 'none' })).toEqual([]);
  });

  it('rejects non-numeric describe pricing', () => {
    expect(validateConfig({ describe: { pricing: { input: 'three' } } })[0].key)
      .toBe('describe.pricing.input');
  });
});
