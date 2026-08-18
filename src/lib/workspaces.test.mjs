import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverWorkspaces, readPackageManifest, workspaceTsPaths } from './workspaces.mjs';

let root;

function w(rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cg-ws-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('discoverWorkspaces — no workspaces', () => {
  it('a repo without package.json discovers nothing', () => {
    expect(discoverWorkspaces(root)).toEqual({ sources: [], packages: [], byName: new Map() });
  });

  it('a package.json without a workspaces key discovers nothing', () => {
    w('package.json', { name: 'solo', version: '1.0.0' });
    expect(discoverWorkspaces(root)).toEqual({ sources: [], packages: [], byName: new Map() });
  });

  it('an unparsable package.json is tolerated', () => {
    w('package.json', '{ this is not json');
    expect(discoverWorkspaces(root).packages).toEqual([]);
  });
});

describe('discoverWorkspaces — package.json workspaces', () => {
  it('expands the array form and reads each package name', () => {
    w('package.json', { name: 'root', workspaces: ['packages/*'] });
    w('packages/ui/package.json', { name: '@myorg/ui', main: 'src/index.ts' });
    w('packages/api/package.json', { name: '@myorg/api' });

    const found = discoverWorkspaces(root);
    expect(found.sources).toEqual(['package.json']);
    expect(found.packages.map((p) => [p.name, p.dir])).toEqual([
      ['@myorg/api', 'packages/api'],
      ['@myorg/ui', 'packages/ui'],
    ]);
    expect(found.byName.get('@myorg/ui').entries).toEqual(['packages/ui/src/index.ts']);
  });

  it('expands the object form { workspaces: { packages: [...] } }', () => {
    w('package.json', { name: 'root', workspaces: { packages: ['packages/*'] } });
    w('packages/ui/package.json', { name: '@myorg/ui' });

    const found = discoverWorkspaces(root);
    expect(found.sources).toEqual(['package.json']);
    expect(found.packages.map((p) => p.name)).toEqual(['@myorg/ui']);
  });

  it('accepts a plain (glob-free) path', () => {
    w('package.json', { name: 'root', workspaces: ['tools/cli'] });
    w('tools/cli/package.json', { name: '@myorg/cli' });
    expect(discoverWorkspaces(root).packages.map((p) => p.dir)).toEqual(['tools/cli']);
  });

  it('expands ** to any depth and skips node_modules', () => {
    w('package.json', { name: 'root', workspaces: ['packages/**'] });
    w('packages/ui/package.json', { name: '@myorg/ui' });
    w('packages/group/deep/package.json', { name: '@myorg/deep' });
    w('packages/ui/node_modules/evil/package.json', { name: 'evil' });
    expect(discoverWorkspaces(root).packages.map((p) => p.name)).toEqual(['@myorg/deep', '@myorg/ui']);
  });

  it('honours ! exclusion patterns', () => {
    w('package.json', { name: 'root', workspaces: ['packages/*', '!packages/private'] });
    w('packages/ui/package.json', { name: '@myorg/ui' });
    w('packages/private/package.json', { name: '@myorg/private' });
    expect(discoverWorkspaces(root).packages.map((p) => p.name)).toEqual(['@myorg/ui']);
  });

  it('skips a matched directory with no package.json or no name', () => {
    w('package.json', { name: 'root', workspaces: ['packages/*'] });
    w('packages/ui/package.json', { name: '@myorg/ui' });
    w('packages/nameless/package.json', { version: '1.0.0' });
    mkdirSync(join(root, 'packages', 'empty'), { recursive: true });
    expect(discoverWorkspaces(root).packages.map((p) => p.name)).toEqual(['@myorg/ui']);
  });
});

describe('discoverWorkspaces — pnpm-workspace.yaml', () => {
  it('reads the packages: list (block form, quotes and comments tolerated)', () => {
    w('package.json', { name: 'root' });
    w('pnpm-workspace.yaml', [
      '# the workspace',
      'packages:',
      "  - 'packages/*'",
      '  - "apps/*"   # the apps',
      '  - tools/cli',
      '',
      'onlyBuiltDependencies:',
      '  - esbuild',
      '',
    ].join('\n'));
    w('packages/ui/package.json', { name: '@myorg/ui' });
    w('apps/web/package.json', { name: '@myorg/web' });
    w('tools/cli/package.json', { name: '@myorg/cli' });
    w('esbuild/package.json', { name: 'not-a-workspace' });

    const found = discoverWorkspaces(root);
    expect(found.sources).toEqual(['pnpm-workspace.yaml']);
    expect(found.packages.map((p) => p.name)).toEqual(['@myorg/cli', '@myorg/ui', '@myorg/web']);
  });

  it('reads the inline flow form packages: [a, b]', () => {
    w('pnpm-workspace.yaml', "packages: ['packages/*', \"apps/*\"]\n");
    w('packages/ui/package.json', { name: '@myorg/ui' });
    w('apps/web/package.json', { name: '@myorg/web' });
    expect(discoverWorkspaces(root).packages.map((p) => p.name)).toEqual(['@myorg/ui', '@myorg/web']);
  });

  it('merges both sources when a repo declares each', () => {
    w('package.json', { name: 'root', workspaces: ['packages/*'] });
    w('pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
    w('packages/ui/package.json', { name: '@myorg/ui' });
    w('apps/web/package.json', { name: '@myorg/web' });
    const found = discoverWorkspaces(root);
    expect(found.sources).toEqual(['package.json', 'pnpm-workspace.yaml']);
    expect(found.packages.map((p) => p.name)).toEqual(['@myorg/ui', '@myorg/web']);
  });
});

describe('readPackageManifest — entry targets', () => {
  it('orders exports "." before module before main, all repo-relative', () => {
    w('packages/ui/package.json', {
      name: '@myorg/ui',
      main: 'dist/index.js',
      module: 'dist/index.mjs',
      exports: { '.': { types: './src/index.ts', import: './dist/index.js' }, './button': './src/button.ts' },
      bin: { ui: './bin/ui.mjs' },
    });
    const pkg = readPackageManifest(root, 'packages/ui');
    expect(pkg.name).toBe('@myorg/ui');
    expect(pkg.entries).toEqual([
      'packages/ui/src/index.ts',
      'packages/ui/dist/index.js',
      'packages/ui/dist/index.mjs',
    ]);
    expect(pkg.subpaths).toEqual({ button: ['packages/ui/src/button.ts'] });
    expect(pkg.bin).toEqual(['packages/ui/bin/ui.mjs']);
  });

  it('accepts the string exports form and a string bin', () => {
    w('package.json', { name: 'solo', exports: './src/main.ts', bin: './cli.mjs' });
    const pkg = readPackageManifest(root, '.');
    expect(pkg.entries).toEqual(['src/main.ts']);
    expect(pkg.bin).toEqual(['cli.mjs']);
    expect(pkg.dir).toBe('.');
  });

  it('returns null when there is no readable package.json', () => {
    expect(readPackageManifest(root, 'nope')).toBe(null);
  });
});

describe('workspaceTsPaths', () => {
  it('maps each package name and subpath to absolute candidates', () => {
    w('package.json', { name: 'root', workspaces: ['packages/*'] });
    w('packages/ui/package.json', { name: '@myorg/ui', main: 'src/index.ts' });
    const paths = workspaceTsPaths(discoverWorkspaces(root), root);
    expect(paths['@myorg/ui']).toEqual([join(root, 'packages/ui/src/index.ts'), join(root, 'packages/ui')]);
    expect(paths['@myorg/ui/*']).toEqual([join(root, 'packages/ui/*')]);
  });

  it('is empty for a repo with no workspaces', () => {
    expect(workspaceTsPaths(discoverWorkspaces(root), root)).toEqual({});
  });
});
