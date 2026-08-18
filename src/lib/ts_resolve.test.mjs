// The two speed options in `defaultCompilerOptions` are only safe because of a
// property of what this tool extracts, not because of a property of TypeScript.
// These tests pin that property, so a future change to either cannot quietly
// break it.
//
//   skipLibCheck  skips type-CHECKING `.d.ts` bodies. Every `.d.ts` is still
//                 parsed, bound and resolved — and resolution is all we ask for.
//   types: []     stops `@types/*` packages being auto-loaded. A global declared
//                 in one lives OUTSIDE the repo, so it could never become a
//                 Symbol node: with the package loaded the identifier resolves
//                 into node_modules and is dropped, without it the identifier
//                 does not resolve at all and is dropped. Same records either way.
//
// The second one has a sharp edge worth stating: TypeScript resolves automatic
// `@types` inclusion against the PROCESS working directory, not `--repo-root`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

import { defaultCompilerOptions } from './ts_resolve.mjs';
import { extractReferences } from '../references/lib/reference_extractor.mjs';
import { extractUsages } from '../usages/lib/usage_extractor.mjs';

/** A repo with a `@types/amb` package declaring a global that shadows an export. */
function makeAmbientRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'cg-ambient-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '@types', 'amb'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', '@types', 'amb', 'package.json'), JSON.stringify({
    name: '@types/amb', version: '1.0.0', types: 'index.d.ts',
  }));
  writeFileSync(join(repo, 'node_modules', '@types', 'amb', 'index.d.ts'), [
    'declare global {',
    '  function helper(x: number): number;',
    '  const AMB_VERSION: string;',
    '}',
    'export {};',
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'src', 'helpers.ts'), 'export function helper(x: number): number {\n  return x * 2;\n}\n');
  // No import — resolves to the ambient global when @types is loaded.
  writeFileSync(join(repo, 'src', 'shadow.ts'), 'export function useGlobal(n: number): number {\n  return helper(n);\n}\n');
  // Imported — the module-local binding must win, with or without @types.
  writeFileSync(join(repo, 'src', 'local.ts'), "import { helper } from './helpers';\nexport function useLocal(n: number): number {\n  return helper(n);\n}\n");
  return repo;
}

let repo;
let cwd;

beforeAll(() => {
  repo = makeAmbientRepo();
  // `@types` auto-inclusion resolves against the CWD, so the test has to stand
  // where a user would stand: inside the repo being analysed.
  cwd = process.cwd();
  process.chdir(repo);
});
afterAll(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
});

const roots = () => ['helpers.ts', 'local.ts', 'shadow.ts'].map((f) => join(repo, 'src', f));

const symbolIds = () => new Set([
  'sym:src/helpers.ts#helper',
  'sym:src/local.ts#useLocal',
  'sym:src/shadow.ts#useGlobal',
]);

describe('defaultCompilerOptions', () => {
  it('turns skipLibCheck on (we never read a diagnostic, so checking .d.ts is waste)', () => {
    expect(defaultCompilerOptions().skipLibCheck).toBe(true);
  });

  it('turns off automatic @types loading', () => {
    expect(defaultCompilerOptions().types).toEqual([]);
  });
});

describe('the fixture really does load @types when TypeScript is allowed to', () => {
  it('auto-loads @types/amb without `types: []`, and drops it with', () => {
    const withTypes = { ...defaultCompilerOptions(), types: undefined };
    delete withTypes.types;
    const withoutTypes = defaultCompilerOptions();

    const loaded = (options) => ts.createProgram([...roots()].sort(), options)
      .getSourceFiles().some((sf) => sf.fileName.includes('@types/amb'));

    expect(loaded(withTypes)).toBe(true);   // the fixture is doing its job…
    expect(loaded(withoutTypes)).toBe(false); // …and `types: []` really removes it
  });

  it('a bare `helper` resolves INTO @types/amb without the flag, and nowhere with it', () => {
    const declOf = (options) => {
      const program = ts.createProgram([...roots()].sort(), options);
      const checker = program.getTypeChecker();
      const sf = program.getSourceFile(join(repo, 'src', 'shadow.ts'));
      let found = 'not-visited';
      const visit = (node) => {
        if (ts.isIdentifier(node) && node.text === 'helper') {
          const symbol = checker.getSymbolAtLocation(node);
          found = symbol?.declarations?.[0]?.getSourceFile().fileName ?? 'unresolved';
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return found;
    };

    const withTypes = defaultCompilerOptions();
    delete withTypes.types;
    expect(declOf(withTypes)).toContain('@types/amb');
    expect(declOf(defaultCompilerOptions())).toBe('unresolved');
  });
});

describe('…and it changes no extracted record either way', () => {
  const extract = (options) => ({
    references: extractReferences({
      fileNames: roots(), options, symbolIds: symbolIds(), repoRoot: repo,
    }),
    usages: extractUsages({
      fileNames: roots(), options, symbolIds: symbolIds(), repoRoot: repo,
    }),
  });

  it('produces identical references and usages with and without @types', () => {
    const withTypes = defaultCompilerOptions();
    delete withTypes.types;

    const a = extract(withTypes);
    const b = extract(defaultCompilerOptions());
    expect(b.references).toEqual(a.references);
    expect(b.usages).toEqual(a.usages);
  });

  it('produces identical references and usages with and without skipLibCheck', () => {
    const noSkip = { ...defaultCompilerOptions(), skipLibCheck: false };

    const a = extract(noSkip);
    const b = extract(defaultCompilerOptions());
    expect(b.references).toEqual(a.references);
    expect(b.usages).toEqual(a.usages);
  });

  it('the module-local `helper` is still referenced — the flags cost no real edge', () => {
    const { references } = extract(defaultCompilerOptions());
    expect(references).toContainEqual({
      fromPath: 'src/local.ts', symId: 'sym:src/helpers.ts#helper', sameFile: false,
    });
    // The ambient one never produced an edge, with or without the flag: its
    // declaration lives outside the repo, so it is not a Symbol node at all.
    expect(references.some((r) => r.fromPath === 'src/shadow.ts')).toBe(false);
  });
});
