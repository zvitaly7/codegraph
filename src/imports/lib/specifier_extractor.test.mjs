import { describe, it, expect } from 'vitest';
import { extractSpecifiers, scanImports } from './specifier_extractor.mjs';

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

// A dynamic import whose specifier is not a literal — `import(pathToFileURL(x).href)`
// — cannot be followed by anyone: not by this tool, not by the type-checker. We
// cannot resolve it, so the least we can do is COUNT it, and say so wherever the
// answer it distorts is shown.
describe('scanImports — computed dynamic import detection', () => {
  const count = (text, file = '/x/f.ts') => scanImports(file, text).computedDynamicImports;

  it('counts a dynamic import with a computed specifier', () => {
    expect(count('const m = await import(pathToFileURL(x).href);')).toBe(1);
  });

  it('counts a template literal WITH a substitution', () => {
    expect(count('await import(`./${name}.mjs`);')).toBe(1);
  });

  it('counts each site separately', () => {
    expect(count('import(a); import(b); import(c);')).toBe(3);
  });

  it('does NOT count a plain string-literal specifier', () => {
    expect(count("await import('./lazy.mjs');")).toBe(0);
  });

  it('does NOT count a template literal with no substitution (still a literal)', () => {
    expect(count('await import(`./lazy.mjs`);')).toBe(0);
  });

  it('does NOT count a literal specifier carrying import attributes', () => {
    expect(count("await import('./d.json', { with: { type: 'json' } });")).toBe(0);
  });

  it('does NOT count static imports or import.meta', () => {
    expect(count("import a from './a';\nconst u = import.meta.url;")).toBe(0);
  });

  it('does NOT count a method that merely happens to be called `import`', () => {
    expect(count('registry.import(thing);')).toBe(0);
  });

  it('does NOT count `import(` appearing inside a string or a comment', () => {
    expect(count('const s = "import(x)"; // import(y)\n/* import(z) */')).toBe(0);
  });

  it('does NOT count `import(` inside a regular-expression literal', () => {
    expect(count('const re = /\\bimport\\s*\\(/g; export { re };')).toBe(0);
  });

  it('finds them inside nested functions and JSX files', () => {
    const tsx = 'export const C = () => { const go = () => import(mod); return <b onClick={go} />; };';
    expect(count(tsx, '/x/C.tsx')).toBe(1);
  });

  it('still returns the same specifiers as extractSpecifiers', () => {
    const text = "import a from './a';\nawait import('./b.mjs');\nawait import(c);";
    const { specifiers } = scanImports('/x/f.ts', text);
    expect(specifiers).toEqual(extractSpecifiers('/x/f.ts', text));
    expect(specifiers).toEqual(expect.arrayContaining(['./a', './b.mjs']));
  });

  it('reports zero for a file with no dynamic imports at all', () => {
    expect(scanImports('/x/f.ts', 'export const k = 1;')).toEqual({
      specifiers: [], computedDynamicImports: 0,
    });
  });
});
