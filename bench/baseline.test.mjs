// The benchmark's baseline is an argument about what an agent would read, so
// the code that models it has to be right about the boring parts: which files
// grep would search, which import specifiers really point at the target, and
// where the transitive walk stops.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Corpus, SKIM_LINES,
  listSourceFiles, grep, renderHits, renderList,
  resolveRelativeSpecifier, importersFromHits,
  importerClosure, grepThenRead, fileOrientation, readDir, readAll,
  priceContext, runProcedure,
} from './baseline.mjs';

/** Character-count stand-in for a tokenizer — deterministic and easy to assert on. */
const fakeCount = (text) => text.length;

let repo;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'lg-bench-'));
});

function write(rel, text) {
  const abs = join(repo, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

describe('listSourceFiles', () => {
  it('keeps JS/TS sources, sorted, and drops everything else', () => {
    write('src/a.mjs', 'x');
    write('src/b.ts', 'x');
    write('src/notes.md', 'x');
    write('src/data.json', 'x');
    expect(listSourceFiles(repo)).toEqual(['src/a.mjs', 'src/b.ts']);
  });

  it('honours .gitignore and hard-skips node_modules / .git', () => {
    write('.gitignore', 'generated/\n');
    write('src/a.mjs', 'x');
    write('generated/big.mjs', 'x');
    write('node_modules/pkg/index.mjs', 'x');
    write('.git/hooks/pre-commit.mjs', 'x');
    expect(listSourceFiles(repo)).toEqual(['src/a.mjs']);
  });

  it('drops explicitly excluded directories (how the bench skips its own source)', () => {
    write('src/a.mjs', 'x');
    write('bench/run.mjs', 'x');
    expect(listSourceFiles(repo, { exclude: ['bench'] })).toEqual(['src/a.mjs']);
    expect(listSourceFiles(repo, { exclude: [] })).toEqual(['bench/run.mjs', 'src/a.mjs']);
  });
});

describe('grep', () => {
  beforeEach(() => {
    write('src/a.mjs', "import { loadGraph } from './g.mjs';\nconst x = loadGraph();\n// loadGraphExtra\n");
    write('src/b.mjs', 'const y = 1;\n');
  });

  it('matches whole words only and reports path/line/text', () => {
    const c = Corpus.from(repo);
    const { hits, files } = grep(c, { needle: 'loadGraph' });
    expect(files).toEqual(['src/a.mjs']);
    expect(hits.map((h) => h.lineNo)).toEqual([1, 2]); // not line 3: loadGraphExtra
    expect(renderHits(hits)).toContain("src/a.mjs:1:import { loadGraph } from './g.mjs';");
  });

  it('importOnly keeps only lines that look like module specifiers', () => {
    const c = Corpus.from(repo);
    const { hits } = grep(c, { needle: 'loadGraph', importOnly: true });
    expect(hits.map((h) => h.lineNo)).toEqual([1]);
  });
});

describe('resolveRelativeSpecifier', () => {
  it('resolves ./ and ../ against the importing file and drops the extension', () => {
    expect(resolveRelativeSpecifier('src/mcp/run.mjs', './lib/rpc.mjs')).toBe('src/mcp/lib/rpc');
    expect(resolveRelativeSpecifier('src/mcp/lib/rpc.mjs', '../../lib/graph_load.mjs')).toBe('src/lib/graph_load');
    expect(resolveRelativeSpecifier('src/a.ts', './b')).toBe('src/b');
  });

  it('returns null for bare/package specifiers', () => {
    expect(resolveRelativeSpecifier('src/a.mjs', 'node:fs')).toBeNull();
    expect(resolveRelativeSpecifier('src/a.mjs', 'vitest')).toBeNull();
  });
});

describe('importersFromHits', () => {
  it('accepts only hits whose specifier resolves to the target', () => {
    const hits = [
      { path: 'src/brief/run.mjs', lineNo: 1, text: "import { loadGraph } from '../lib/graph_load.mjs';" },
      { path: 'src/other/run.mjs', lineNo: 1, text: "import { loadGraph } from './graph_load.mjs';" },
      { path: 'src/lib/graph_load.mjs', lineNo: 9, text: 'export function loadGraph() {}' },
    ];
    expect(importersFromHits(hits, 'src/lib/graph_load.mjs')).toEqual(['src/brief/run.mjs']);
  });

  it('treats a directory specifier as its index file', () => {
    const hits = [{ path: 'src/a.mjs', lineNo: 1, text: "import x from './pkg';" }];
    expect(importersFromHits(hits, 'src/pkg/index.mjs')).toEqual(['src/a.mjs']);
  });
});

describe('importerClosure', () => {
  beforeEach(() => {
    // target <- mid <- top, plus a same-basename decoy that must NOT be followed.
    write('src/lib/target.mjs', 'export const t = 1;\n');
    write('src/mid.mjs', "import { t } from './lib/target.mjs';\nexport const m = t;\n");
    write('src/top.mjs', "import { m } from './mid.mjs';\nexport const p = m;\n");
    write('src/decoy/target.mjs', 'export const t = 2;\n');
    write('src/decoy/user.mjs', "import { t } from './target.mjs';\n");
  });

  it('walks importers transitively and ignores same-basename decoys', () => {
    const c = Corpus.from(repo);
    const r = importerClosure(c, { target: 'src/lib/target.mjs' });
    expect(r.readFiles).toEqual(['src/mid.mjs', 'src/top.mjs']);
  });

  it('charges a repeated grep only once', () => {
    write('src/also.mjs', "import { t } from './lib/target.mjs';\n");
    const c = Corpus.from(repo);
    const r = importerClosure(c, { target: 'src/lib/target.mjs' });
    const charged = r.steps.filter((s) => s.includes('hit(s)'));
    const reused = r.steps.filter((s) => s.includes('already in context'));
    // `also` and `mid` are distinct needles; the second visit to any needle is free.
    expect(new Set(charged.map((s) => s.split("'")[1])).size).toBe(charged.length);
    expect(charged.length + reused.length).toBe(r.steps.length);
  });
});

describe('the other procedures', () => {
  beforeEach(() => {
    write('src/mod/a.mjs', "import './b.mjs';\nexport const a = 1;\n");
    write('src/mod/b.mjs', 'export const b = 2;\n');
    write('src/outside.mjs', "import { a } from './mod/a.mjs';\n");
  });

  it('grepThenRead reads every file the symbol appears in', () => {
    const c = Corpus.from(repo);
    const r = grepThenRead(c, { symbol: 'a' });
    expect(r.readFiles).toContain('src/mod/a.mjs');
    expect(r.readFiles).toContain('src/outside.mjs');
    expect(r.toolOutput).toBe(renderList(r.readFiles));
  });

  it('fileOrientation reads the target plus its direct importers only', () => {
    const c = Corpus.from(repo);
    const r = fileOrientation(c, { target: 'src/mod/a.mjs' });
    expect(r.readFiles).toEqual(['src/mod/a.mjs', 'src/outside.mjs']);
  });

  it('readDir is scoped to the directory', () => {
    const c = Corpus.from(repo);
    expect(readDir(c, { dir: 'src/mod' }).readFiles).toEqual(['src/mod/a.mjs', 'src/mod/b.mjs']);
  });

  it('readAll takes the whole source universe', () => {
    const c = Corpus.from(repo);
    expect(readAll(c).readFiles).toEqual(c.files);
  });

  it('runProcedure dispatches by kind and rejects unknown ones', () => {
    const c = Corpus.from(repo);
    expect(runProcedure(c, { kind: 'read-dir', dir: 'src/mod' }).readFiles).toHaveLength(2);
    expect(() => runProcedure(c, { kind: 'nope' })).toThrow(/unknown baseline procedure/);
  });
});

describe('priceContext', () => {
  it('adds tool output to full file text, and the skim floor never exceeds it', () => {
    write('src/long.mjs', `${Array.from({ length: SKIM_LINES + 20 }, (_, i) => `// line ${i}`).join('\n')}\n`);
    const c = Corpus.from(repo);
    const result = { steps: [], toolOutput: 'abc', readFiles: ['src/long.mjs'] };
    const p = priceContext(c, result, fakeCount);
    expect(p.toolTokens).toBe(3);
    expect(p.full).toBe(3 + c.text('src/long.mjs').length);
    expect(p.skim).toBeLessThan(p.full);
    expect(p.filesRead).toBe(1);
    expect(p.bytesRead).toBe(Buffer.byteLength(c.text('src/long.mjs')));
  });

  it('prices an empty procedure at zero', () => {
    const c = Corpus.from(repo);
    const p = priceContext(c, { steps: [], toolOutput: '', readFiles: [] }, fakeCount);
    expect(p).toMatchObject({ full: 0, skim: 0, filesRead: 0, bytesRead: 0 });
  });
});
