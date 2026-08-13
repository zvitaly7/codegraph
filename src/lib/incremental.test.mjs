import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  symIdPath,
  revisionOfArtifactManifest,
  loadImportersIndex,
  computeAffectedFiles,
  changedFilesRiskGlobals,
  affectedFilesToWalk,
  buildIncrementalProgram,
} from './incremental.mjs';
import { defaultCompilerOptions } from './ts_resolve.mjs';

describe('symIdPath', () => {
  it('returns the declaring path of a symbol id', () => {
    expect(symIdPath('sym:src/a.ts#foo')).toBe('src/a.ts');
    expect(symIdPath('sym:src/dir/b.mts#Thing')).toBe('src/dir/b.mts');
  });
});

describe('revisionOfArtifactManifest', () => {
  it('parses the revision from basedOnSnapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-rev-'));
    const p = join(dir, 'manifest.json');
    writeFileSync(p, JSON.stringify({ basedOnSnapshot: 'snapshot:proj:abc123' }));
    expect(revisionOfArtifactManifest(p)).toBe('abc123');
  });

  it('returns null for unknown / no-revision / missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-rev-'));
    const p1 = join(dir, 'm1.json');
    writeFileSync(p1, JSON.stringify({ basedOnSnapshot: 'unknown' }));
    expect(revisionOfArtifactManifest(p1)).toBeNull();
    const p2 = join(dir, 'm2.json');
    writeFileSync(p2, JSON.stringify({ basedOnSnapshot: 'snapshot:proj:no-revision' }));
    expect(revisionOfArtifactManifest(p2)).toBeNull();
    expect(revisionOfArtifactManifest(join(dir, 'nope.json'))).toBeNull();
  });
});

describe('loadImportersIndex + computeAffectedFiles', () => {
  function writeImports(dir, edges) {
    const p = join(dir, 'edges.jsonl');
    writeFileSync(p, edges.map((e) => JSON.stringify(e)).join('\n'));
    return p;
  }
  const imp = (from, to, kind = 'internal') => ({
    type: 'IMPORTS', from: `file:${from}`, to: `file:${to}`, properties: { kind },
  });

  it('reverses internal IMPORTS edges only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-imp-'));
    // a → b → c ; d → b ; e → pkg (external, ignored)
    const p = writeImports(dir, [
      imp('src/a.ts', 'src/b.ts'),
      imp('src/b.ts', 'src/c.ts'),
      imp('src/d.ts', 'src/b.ts'),
      { type: 'IMPORTS', from: 'file:src/e.ts', to: 'pkg:lodash', properties: { kind: 'external' } },
    ]);
    const idx = loadImportersIndex(p);
    expect([...idx.get('src/b.ts')].sort()).toEqual(['src/a.ts', 'src/d.ts']);
    expect([...idx.get('src/c.ts')]).toEqual(['src/b.ts']);
    expect(idx.has('pkg:lodash')).toBe(false);
  });

  it('computes the transitive importer closure of a changed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-imp-'));
    // a → b → c ; d → b
    const p = writeImports(dir, [
      imp('src/a.ts', 'src/b.ts'),
      imp('src/b.ts', 'src/c.ts'),
      imp('src/d.ts', 'src/b.ts'),
    ]);
    const idx = loadImportersIndex(p);
    // Changing c should pull in b (imports c), then a and d (import b).
    const affected = computeAffectedFiles(['src/c.ts'], idx);
    expect([...affected].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });

  it('missing imports file → empty index → affected = changed only', () => {
    const idx = loadImportersIndex(join(tmpdir(), 'does-not-exist', 'edges.jsonl'));
    expect(idx.size).toBe(0);
    expect([...computeAffectedFiles(['src/x.ts'], idx)]).toEqual(['src/x.ts']);
  });
});

describe('changedFilesRiskGlobals', () => {
  it('flags a .d.ts change (even a deleted one)', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cg-g-'));
    expect(changedFilesRiskGlobals({ deleted: ['types/globals.d.ts'], repoRoot })).toBe(true);
  });

  it('flags a readable file with `declare global`', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cg-g-'));
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'aug.ts'), 'declare global { interface Window { x: number } }\nexport {};\n');
    expect(changedFilesRiskGlobals({ modified: ['src/aug.ts'], repoRoot })).toBe(true);
  });

  it('does not flag ordinary module code', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cg-g-'));
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n');
    expect(changedFilesRiskGlobals({ added: ['src/a.ts'], modified: [], deleted: [], repoRoot })).toBe(false);
  });
});

describe('affectedFilesToWalk', () => {
  it('keeps only affected paths that are current sources and exist on disk', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cg-walk-'));
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n');
    // b.ts is a current source but does NOT exist on disk (e.g. just deleted).
    const current = new Set(['src/a.ts', 'src/b.ts']);
    // c.ts is on disk but NOT a current source → excluded.
    writeFileSync(join(repoRoot, 'src', 'c.ts'), 'export const c = 3;\n');
    const affected = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const walk = affectedFilesToWalk(affected, current, repoRoot);
    expect(walk).toEqual([join(repoRoot, 'src/a.ts')]);
  });
});

describe('buildIncrementalProgram', () => {
  it('builds a usable program and persists a .tsbuildinfo (no JS emitted)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cg-ip-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'b.ts'), 'export function helper(x: number) { return x + 1; }\n');
    writeFileSync(join(root, 'src', 'a.ts'), "import { helper } from './b';\nexport const y = helper(41);\n");
    const tsbuild = join(root, '.tsbuildinfo');
    const program = buildIncrementalProgram({
      rootNames: [join(root, 'src/a.ts'), join(root, 'src/b.ts')],
      options: defaultCompilerOptions(),
      tsBuildInfoFile: tsbuild,
    });
    expect(program.getTypeChecker()).toBeTruthy();
    expect(program.getSourceFile(join(root, 'src/a.ts'))).toBeTruthy();
    expect(existsSync(tsbuild)).toBe(true);
    // noEmit → no JS leaked next to the sources.
    expect(existsSync(join(root, 'src/a.js'))).toBe(false);
  });
});
