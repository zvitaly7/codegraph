import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
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
    expect(paths['@myorg/ui/*']).toEqual([
      join(root, 'packages/ui/src/*'),
      join(root, 'packages/ui/*'),
    ]);
  });

  it('is empty for a repo with no workspaces', () => {
    expect(workspaceTsPaths(discoverWorkspaces(root), root)).toEqual({});
  });

  it('maps published build targets and subpaths back to authored source candidates', () => {
    w('package.json', { name: 'root', workspaces: ['packages/*'] });
    w('packages/ui/package.json', {
      name: '@myorg/ui',
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './feature': { types: './dist/feature.d.ts', default: './dist/feature.js' },
      },
    });

    const paths = workspaceTsPaths(discoverWorkspaces(root), root);
    expect(paths['@myorg/ui']).toContain(join(root, 'packages/ui/src/index'));
    expect(paths['@myorg/ui/feature']).toContain(join(root, 'packages/ui/src/feature'));
    expect(paths['@myorg/ui/*']).toEqual([
      join(root, 'packages/ui/src/*'),
      join(root, 'packages/ui/*'),
    ]);
  });

  it('does not mistake a package directory named like build output for the output directory', () => {
    w('package.json', { name: 'root', workspaces: ['packages/*'] });
    w('packages/lib/package.json', {
      name: '@myorg/lib',
      exports: { '.': './dist/index.js' },
    });

    const paths = workspaceTsPaths(discoverWorkspaces(root), root);
    expect(paths['@myorg/lib']).toContain(join(root, 'packages/lib/src/index'));
    expect(paths['@myorg/lib']).not.toContain(join(root, 'packages/src/dist/index'));
  });
});

// A workspace package is a symlink in node_modules pointing back into the repo.
// The declaration that created it — a root package.json, a pnpm-workspace.yaml —
// is not always reachable: it may sit above --repo-root when a subdirectory of a
// larger monorepo is analyzed on its own, or the install may be per-application
// with no root manifest at all. The link on disk is the fact; discovery must not
// depend on finding the paperwork.
/**
 * A directory link. Windows refuses `dir` symlinks without elevation but allows
 * junctions, which is what npm itself creates for a workspace package — so the
 * link under test is the same kind the tool will meet in the wild.
 */
const linkDir = (target, path) =>
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

describe('discoverWorkspaces — node_modules links', () => {
  let root;

  function pkg(dirRel, name, main = 'src/index.ts') {
    mkdirSync(join(root, dirRel, 'src'), { recursive: true });
    writeFileSync(join(root, dirRel, 'package.json'), JSON.stringify({ name, main }));
    writeFileSync(join(root, dirRel, 'src', 'index.ts'), 'export const x = 1;');
  }

  function link(fromRel, toRel) {
    const from = join(root, fromRel);
    mkdirSync(join(from, '..'), { recursive: true });
    linkDir(join(root, toRel), from);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cg-ws-links-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds a linked package with no declaration anywhere', () => {
    pkg('packages/util', '@acme/util');
    link('apps/web/node_modules/@acme/util', 'packages/util');
    const d = discoverWorkspaces(root);
    expect(d.byName.get('@acme/util')).toMatchObject({ name: '@acme/util', dir: 'packages/util' });
    expect(d.sources).toContain('node_modules links');
  });

  it('finds an unscoped link too', () => {
    pkg('packages/ui', 'ui');
    link('apps/web/node_modules/ui', 'packages/ui');
    expect(discoverWorkspaces(root).byName.has('ui')).toBe(true);
  });

  it('ignores a link that points outside the repo', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cg-ws-outside-'));
    mkdirSync(join(outside, 'src'), { recursive: true });
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'stranger', main: 'src/index.ts' }));
    mkdirSync(join(root, 'apps', 'web', 'node_modules'), { recursive: true });
    linkDir(outside, join(root, 'apps', 'web', 'node_modules', 'stranger'));
    expect(discoverWorkspaces(root).byName.has('stranger')).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('ignores a real directory — only links are packages of ours', () => {
    mkdirSync(join(root, 'apps', 'web', 'node_modules', 'react'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'web', 'node_modules', 'react', 'package.json'),
      JSON.stringify({ name: 'react', main: 'index.js' }),
    );
    expect(discoverWorkspaces(root).byName.has('react')).toBe(false);
  });

  it('survives a broken link', () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    linkDir(join(root, 'packages', 'gone'), join(root, 'node_modules', 'gone'));
    expect(() => discoverWorkspaces(root)).not.toThrow();
  });

  it('a declared workspace wins over a link of the same name', () => {
    pkg('packages/util', '@acme/util');
    pkg('vendor/util', '@acme/util');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    link('apps/web/node_modules/@acme/util', 'vendor/util');
    expect(discoverWorkspaces(root).byName.get('@acme/util').dir).toBe('packages/util');
  });

  it('a repo with neither declarations nor links is untouched', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(discoverWorkspaces(root)).toEqual({ sources: [], packages: [], byName: new Map() });
  });
});
