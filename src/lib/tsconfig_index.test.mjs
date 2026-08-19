import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsconfigIndex } from './tsconfig_index.mjs';

/**
 * The TypeScript API reports paths with forward slashes on every platform, and
 * the resolver joins them with `path.resolve`, which accepts either. Compare the
 * two the same way rather than pinning a separator the tool never promised.
 */
const samePath = (a, b) => expect(a.split('\\').join('/')).toBe(b.split('\\').join('/'));

let root;
function w(rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

describe('TsconfigIndex — empty', () => {
  it('no tsconfig anywhere → default (empty) config, no crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-tsx-empty-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const x=1;');
    const idx = new TsconfigIndex({ repoRoot: dir });
    expect(idx.forFile(join(dir, 'src', 'a.ts'))).toEqual({
      paths: {}, pathsBase: undefined, baseUrl: undefined, configPath: null,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('TsconfigIndex — discovery & nearest-enclosing', () => {
  let rootCfg;
  let pkgCfg;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cg-tsx-mono-'));
    rootCfg = w('tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } },
    }));
    // A nested package with its own alias set (monorepo).
    pkgCfg = w('packages/ui/tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@ui/*': ['lib/*'] } },
    }));
    w('src/app/util.ts', 'export const u=1;');
    w('packages/ui/lib/button.ts', 'export const b=1;');
    // A tsconfig buried in node_modules must be ignored by discovery.
    w('node_modules/dep/tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@dep/*': ['x/*'] } },
    }));
    w('node_modules/dep/index.ts', 'export const d=1;');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('root file → root tsconfig', () => {
    const c = new TsconfigIndex({ repoRoot: root }).forFile(join(root, 'src', 'app', 'util.ts'));
    expect(c.paths).toEqual({ '@app/*': ['src/app/*'] });
    samePath(c.pathsBase, root);
    samePath(c.configPath, rootCfg);
  });

  it('nested file → nearest (nested) tsconfig, overriding the root', () => {
    const c = new TsconfigIndex({ repoRoot: root }).forFile(join(root, 'packages', 'ui', 'lib', 'button.ts'));
    expect(c.paths).toEqual({ '@ui/*': ['lib/*'] });
    samePath(c.pathsBase, join(root, 'packages', 'ui'));
    samePath(c.configPath, pkgCfg);
  });

  it('skips tsconfig under node_modules (falls back to root)', () => {
    const c = new TsconfigIndex({ repoRoot: root }).forFile(join(root, 'node_modules', 'dep', 'index.ts'));
    samePath(c.configPath, rootCfg); // NOT the node_modules one
    expect(c.paths).toEqual({ '@app/*': ['src/app/*'] });
  });
});

describe('TsconfigIndex — paths without baseUrl', () => {
  it('pathsBase falls back to the tsconfig directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-tsx-nobase-'));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { paths: { '~/*': ['app/*'] } },
    }));
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'a.ts'), 'export const a=1;');
    const c = new TsconfigIndex({ repoRoot: dir }).forFile(join(dir, 'app', 'a.ts'));
    expect(c.baseUrl).toBeUndefined();
    expect(c.pathsBase).toBe(dir);
    expect(c.paths).toEqual({ '~/*': ['app/*'] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('TsconfigIndex — JSONC tolerance', () => {
  it('parses a tsconfig with comments and trailing commas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-tsx-jsonc-'));
    writeFileSync(join(dir, 'tsconfig.json'), [
      '{',
      '  // leading comment',
      '  "compilerOptions": {',
      '    "baseUrl": ".",',
      '    "paths": { "@x/*": ["src/*"], }, /* trailing comma + block */',
      '  },',
      '}',
    ].join('\n'));
    writeFileSync(join(dir, 'a.ts'), 'export const a=1;');
    const c = new TsconfigIndex({ repoRoot: dir }).forFile(join(dir, 'a.ts'));
    expect(c.paths).toEqual({ '@x/*': ['src/*'] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('TsconfigIndex — explicit override', () => {
  it('uses a single tsconfig for every file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-tsx-override-'));
    const override = join(dir, 'custom.tsconfig.json');
    writeFileSync(override, JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@root/*': ['source/*'] } },
    }));
    // A different tsconfig nearby that should be ignored because of the override.
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'tsconfig.json'), JSON.stringify({
      compilerOptions: { paths: { '@nested/*': ['x/*'] } },
    }));
    writeFileSync(join(dir, 'nested', 'a.ts'), 'export const a=1;');
    const idx = new TsconfigIndex({ repoRoot: dir, tsconfigOverride: override });
    const c = idx.forFile(join(dir, 'nested', 'a.ts'));
    expect(c.paths).toEqual({ '@root/*': ['source/*'] });
    expect(c.configPath).toBe(override);
    rmSync(dir, { recursive: true, force: true });
  });
});

// Not every repository carries a tsconfig. Monorepos whose build tooling lives
// outside the checkout have none at all, and without a declared alias table the
// cross-package imports they do have cannot be resolved to files. `configPaths`
// lets loregraph.config supply that table directly.
describe('TsconfigIndex — configPaths fallback', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cg-tsx-cfgpaths-'));
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'web', 'a.ts'), 'export const x=1;');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('supplies the alias table when no tsconfig exists', () => {
    const idx = new TsconfigIndex({
      repoRoot: dir,
      configPaths: { '@lib/*': ['packages/*/src'] },
    });
    const view = idx.forFile(join(dir, 'apps', 'web', 'a.ts'));
    expect(view.paths).toEqual({ '@lib/*': ['packages/*/src'] });
    expect(view.pathsBase).toBe(dir);
  });

  it('resolves configPathsBase against the repo root', () => {
    const idx = new TsconfigIndex({
      repoRoot: dir,
      configPaths: { '@lib/*': ['*/src'] },
      configPathsBase: 'packages',
    });
    expect(idx.forFile(join(dir, 'apps', 'web', 'a.ts')).pathsBase).toBe(join(dir, 'packages'));
  });

  it('fills only the patterns a tsconfig does not define itself', () => {
    const both = mkdtempSync(join(tmpdir(), 'cg-tsx-cfgpaths-merge-'));
    mkdirSync(join(both, 'src'), { recursive: true });
    writeFileSync(join(both, 'src', 'a.ts'), 'export const x=1;');
    writeFileSync(
      join(both, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['src/*'] } } }),
    );
    const idx = new TsconfigIndex({ repoRoot: both, configPaths: { '@lib/*': ['packages/*/src'] } });
    // The tsconfig keeps its own alias, and the cross-package one it never
    // mentioned is added rather than dropped.
    expect(idx.forFile(join(both, 'src', 'a.ts')).paths).toEqual({
      '~/*': ['src/*'],
      '@lib/*': ['packages/*/src'],
    });
    rmSync(both, { recursive: true, force: true });
  });

  it('leaves a tsconfig that declares its own paths in charge', () => {
    const withCfg = mkdtempSync(join(tmpdir(), 'cg-tsx-cfgpaths-win-'));
    mkdirSync(join(withCfg, 'src'), { recursive: true });
    writeFileSync(join(withCfg, 'src', 'a.ts'), 'export const x=1;');
    writeFileSync(
      join(withCfg, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['src/*'] } } }),
    );
    const idx = new TsconfigIndex({ repoRoot: withCfg, configPaths: { '~/*': ['nowhere/*'] } });
    expect(idx.forFile(join(withCfg, 'src', 'a.ts')).paths).toEqual({ '~/*': ['src/*'] });
    rmSync(withCfg, { recursive: true, force: true });
  });

  it('fills in for a tsconfig that declares no paths of its own', () => {
    const noPaths = mkdtempSync(join(tmpdir(), 'cg-tsx-cfgpaths-fill-'));
    mkdirSync(join(noPaths, 'src'), { recursive: true });
    writeFileSync(join(noPaths, 'src', 'a.ts'), 'export const x=1;');
    writeFileSync(join(noPaths, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    const idx = new TsconfigIndex({ repoRoot: noPaths, configPaths: { '@lib/*': ['packages/*'] } });
    expect(idx.forFile(join(noPaths, 'src', 'a.ts')).paths).toEqual({ '@lib/*': ['packages/*'] });
    rmSync(noPaths, { recursive: true, force: true });
  });

  it('no configPaths → behaviour is exactly what it was', () => {
    const idx = new TsconfigIndex({ repoRoot: dir });
    expect(idx.forFile(join(dir, 'apps', 'web', 'a.ts'))).toEqual({
      paths: {}, pathsBase: undefined, baseUrl: undefined, configPath: null,
    });
  });
});
