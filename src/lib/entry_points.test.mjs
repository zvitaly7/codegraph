import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectEntryPoints } from './entry_points.mjs';
import { discoverWorkspaces } from './workspaces.mjs';

let root;

function w(rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cg-ep-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('collectEntryPoints — nothing to find', () => {
  it('no config and no package.json → no entry points', () => {
    expect(collectEntryPoints({ repoRoot: root, filePaths: ['src/a.ts'] }))
      .toEqual({ paths: [], reasons: {} });
  });

  it('a package.json with no entry fields → no entry points', () => {
    w('package.json', { name: 'solo', version: '1.0.0' });
    expect(collectEntryPoints({ repoRoot: root, filePaths: ['src/a.ts'] }).paths).toEqual([]);
  });
});

describe('collectEntryPoints — the entryPoints config knob', () => {
  const filePaths = ['src/a.ts', 'src/mf/remote.ts', 'src/mf/deep/other.ts', 'bin/cli.mjs'];

  it('matches an exact path', () => {
    const found = collectEntryPoints({ repoRoot: root, patterns: ['src/mf/remote.ts'], filePaths });
    expect(found.paths).toEqual(['src/mf/remote.ts']);
    expect(found.reasons).toEqual({ 'src/mf/remote.ts': 'config' });
  });

  it('matches a * glob within one directory level', () => {
    const found = collectEntryPoints({ repoRoot: root, patterns: ['src/mf/*.ts'], filePaths });
    expect(found.paths).toEqual(['src/mf/remote.ts']);
  });

  it('matches a ** glob at any depth', () => {
    const found = collectEntryPoints({ repoRoot: root, patterns: ['src/mf/**'], filePaths });
    expect(found.paths).toEqual(['src/mf/deep/other.ts', 'src/mf/remote.ts']);
  });

  it('matches a bare basename pattern at any depth', () => {
    const found = collectEntryPoints({ repoRoot: root, patterns: ['remote.ts'], filePaths });
    expect(found.paths).toEqual(['src/mf/remote.ts']);
  });

  it('ignores a pattern that matches nothing, and a non-array config', () => {
    expect(collectEntryPoints({ repoRoot: root, patterns: ['nope/**'], filePaths }).paths).toEqual([]);
    expect(collectEntryPoints({ repoRoot: root, patterns: 'src/a.ts', filePaths }).paths).toEqual([]);
  });
});

describe('collectEntryPoints — auto-detected package entry points', () => {
  it('picks up main, module, exports and every bin target', () => {
    w('package.json', {
      name: 'app',
      main: 'src/main.ts',
      module: './src/esm.ts',
      exports: { '.': './src/index.ts', './extra': './src/extra.ts' },
      bin: { app: './bin/cli.mjs', other: 'bin/other.mjs' },
    });
    const filePaths = [
      'bin/cli.mjs', 'bin/other.mjs', 'src/main.ts', 'src/esm.ts',
      'src/index.ts', 'src/extra.ts', 'src/private.ts',
    ];
    const found = collectEntryPoints({ repoRoot: root, filePaths });
    expect(found.paths).toEqual([
      'bin/cli.mjs', 'bin/other.mjs', 'src/esm.ts', 'src/extra.ts', 'src/index.ts', 'src/main.ts',
    ]);
    expect(found.reasons['bin/cli.mjs']).toBe('package.json');
  });

  it('resolves a target through the source extension candidates', () => {
    w('package.json', { name: 'app', main: './src' });
    const found = collectEntryPoints({ repoRoot: root, filePaths: ['src/index.ts', 'src/other.ts'] });
    expect(found.paths).toEqual(['src/index.ts']);
  });

  it('drops a target that is not a known source file', () => {
    w('package.json', { name: 'app', main: 'dist/index.js', bin: './bin/cli.mjs' });
    const found = collectEntryPoints({ repoRoot: root, filePaths: ['bin/cli.mjs', 'src/a.ts'] });
    expect(found.paths).toEqual(['bin/cli.mjs']);
  });

  it('covers workspace packages when the discovery result is passed in', () => {
    w('package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    w('packages/ui/package.json', { name: '@myorg/ui', main: 'src/index.ts' });
    w('packages/cli/package.json', { name: '@myorg/cli', bin: './bin/run.mjs' });
    const filePaths = [
      'packages/cli/bin/run.mjs', 'packages/cli/src/hidden.ts',
      'packages/ui/src/index.ts', 'packages/ui/src/button.ts',
    ];
    const found = collectEntryPoints({
      repoRoot: root, filePaths, workspaces: discoverWorkspaces(root),
    });
    expect(found.paths).toEqual(['packages/cli/bin/run.mjs', 'packages/ui/src/index.ts']);
    expect(found.reasons['packages/ui/src/index.ts']).toBe('packages/ui/package.json');
  });

  it('config wins the reason when both sources name the same file', () => {
    w('package.json', { name: 'app', main: 'src/index.ts' });
    const found = collectEntryPoints({
      repoRoot: root, patterns: ['src/index.ts'], filePaths: ['src/index.ts'],
    });
    expect(found.paths).toEqual(['src/index.ts']);
    expect(found.reasons).toEqual({ 'src/index.ts': 'config' });
  });
});
