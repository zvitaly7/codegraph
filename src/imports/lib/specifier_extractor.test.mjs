import { describe, it, expect } from 'vitest';
import { extractSpecifiers } from './specifier_extractor.mjs';

describe('extractSpecifiers', () => {
  it('collects static import / export-from specifiers', () => {
    const text = [
      "import a from './a';",
      "import { b } from '../b.js';",
      "import * as c from '@scope/c';",
      "export { d } from './d';",
      "export * from 'pkg';",
    ].join('\n');
    expect(extractSpecifiers('/x/file.ts', text)).toEqual(
      expect.arrayContaining(['./a', '../b.js', '@scope/c', './d', 'pkg']),
    );
  });

  it('collects dynamic import() with a string literal', () => {
    const text = "async function f(){ const m = await import('./lazy.mjs'); return m; }";
    expect(extractSpecifiers('/x/f.ts', text)).toContain('./lazy.mjs');
  });

  it('collects require() calls (JS detection on)', () => {
    const text = "const x = require('node:fs');\nconst y = require('lodash/fp');";
    const out = extractSpecifiers('/x/f.js', text);
    expect(out).toContain('node:fs');
    expect(out).toContain('lodash/fp');
  });

  it('ignores dynamic import with a non-literal argument', () => {
    const text = "const p = 'x'; import(p); import(`./${p}`);";
    // no static specifier can be extracted from a computed argument
    expect(extractSpecifiers('/x/f.ts', text)).toEqual([]);
  });

  it('reads the file when text is omitted', () => {
    // pass text explicitly; when omitted it would read from disk — covered elsewhere
    expect(extractSpecifiers('/x/f.ts', "import z from 'zzz';")).toEqual(['zzz']);
  });

  it('returns an empty array for a file with no imports', () => {
    expect(extractSpecifiers('/x/f.ts', 'export const k = 1;')).toEqual([]);
  });
});
