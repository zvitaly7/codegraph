import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsconfigIndex } from './tsconfig_index.mjs';

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
    expect(c.pathsBase).toBe(root);
    expect(c.configPath).toBe(rootCfg);
  });

  it('nested file → nearest (nested) tsconfig, overriding the root', () => {
    const c = new TsconfigIndex({ repoRoot: root }).forFile(join(root, 'packages', 'ui', 'lib', 'button.ts'));
    expect(c.paths).toEqual({ '@ui/*': ['lib/*'] });
    expect(c.pathsBase).toBe(join(root, 'packages', 'ui'));
    expect(c.configPath).toBe(pkgCfg);
  });

  it('skips tsconfig under node_modules (falls back to root)', () => {
    const c = new TsconfigIndex({ repoRoot: root }).forFile(join(root, 'node_modules', 'dep', 'index.ts'));
    expect(c.configPath).toBe(rootCfg); // NOT the node_modules one
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
