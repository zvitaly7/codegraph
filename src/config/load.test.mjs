import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from './load.mjs';

describe('resolveConfig', () => {
  it('applies zero-config defaults relative to repoRoot', async () => {
    const cfg = await resolveConfig({ cwd: '/tmp/x', argv: [] });
    expect(cfg.srcRoots).toEqual(['src']);
    expect(cfg.ignoreFile).toBe('.gitignore');
    expect(cfg.vcs).toBe('auto');
    // outDir is always absolute, resolved against cwd.
    expect(cfg.outDir).toBe('/tmp/x/.kg-cache');
    expect(cfg.repoRoot).toBe('/tmp/x');
  });

  it('CLI flags override defaults', async () => {
    const cfg = await resolveConfig({ cwd: '/tmp/x', argv: ['--repo-root', '/r', '--out', '.cache'] });
    expect(cfg.repoRoot).toBe('/r');
    // --out is resolved against cwd, not repoRoot.
    expect(cfg.outDir).toBe('/tmp/x/.cache');
  });

  it('loads a .json config file (no ERR_IMPORT_ATTRIBUTE_MISSING) and CLI still overrides it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-load-json-'));
    const jsonPath = join(dir, 'foo.json');
    writeFileSync(jsonPath, JSON.stringify({ srcRoots: ['app'], outDir: '.cache' }), 'utf8');

    const cfg = await resolveConfig({
      cwd: dir,
      argv: ['--repo-root', dir, '--config', jsonPath, '--out', '.cli-cache'],
    });

    expect(cfg.srcRoots).toEqual(['app']); // merged from the JSON file
    expect(cfg.outDir).toBe(join(dir, '.cli-cache')); // CLI --out still wins over the file
  });

  it('zero-config lookup falls back to loregraph.config.json when .mjs is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-load-json-zero-'));
    writeFileSync(join(dir, 'loregraph.config.json'), JSON.stringify({ srcRoots: ['lib'] }), 'utf8');

    const cfg = await resolveConfig({ cwd: dir, argv: ['--repo-root', dir] });

    expect(cfg.srcRoots).toEqual(['lib']); // auto-discovered loregraph.config.json
  });

  it('defaults incremental to off', async () => {
    const cfg = await resolveConfig({ cwd: '/tmp/x', argv: [] });
    expect(cfg.incremental).toBe('off');
  });

  it('resolves incremental from the --incremental flag (declared as an extraOption)', async () => {
    const cfg = await resolveConfig({
      cwd: '/tmp/x',
      argv: ['--incremental', 'incremental'],
      extraOptions: { incremental: { type: 'string' } },
    });
    expect(cfg.incremental).toBe('incremental');
  });

  it('incremental flag overrides the config file, which overrides the default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-load-inc-'));
    writeFileSync(join(dir, 'loregraph.config.json'), JSON.stringify({ incremental: 'incremental' }), 'utf8');

    // Config file wins over the default when no flag is given.
    const fromFile = await resolveConfig({ cwd: dir, argv: ['--repo-root', dir] });
    expect(fromFile.incremental).toBe('incremental');

    // The flag wins over the config file.
    const fromFlag = await resolveConfig({
      cwd: dir,
      argv: ['--repo-root', dir, '--incremental', 'off'],
      extraOptions: { incremental: { type: 'string' } },
    });
    expect(fromFlag.incremental).toBe('off');
  });

  // A key nobody reads is a setting that silently does nothing. The run must
  // stop and name it rather than proceed at a default the user did not choose.
  it('refuses a config file with an unknown key, naming it and the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-cfg-unknown-'));
    writeFileSync(join(dir, 'loregraph.config.json'), JSON.stringify({ srcRoot: ['lib'] }), 'utf8');

    await expect(resolveConfig({ cwd: dir, argv: ['--repo-root', dir] }))
      .rejects.toThrow(/srcRoot.*srcRoots/s);
  });

  it('names the offending config file in the error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-cfg-unknown-path-'));
    writeFileSync(join(dir, 'loregraph.config.json'), JSON.stringify({ nope: 1 }), 'utf8');

    await expect(resolveConfig({ cwd: dir, argv: ['--repo-root', dir] }))
      .rejects.toThrow(/loregraph\.config\.json/);
  });

  it('accepts a config file that only uses known keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-cfg-known-'));
    writeFileSync(
      join(dir, 'loregraph.config.json'),
      JSON.stringify({ srcRoots: ['lib'], describe: { top: 5 } }),
      'utf8',
    );
    const cfg = await resolveConfig({ cwd: dir, argv: ['--repo-root', dir] });
    expect(cfg.srcRoots).toEqual(['lib']);
  });

  it('exposes bare arguments as _positionals, in order and free of flags', async () => {
    const cfg = await resolveConfig({
      cwd: '/tmp/x',
      argv: ['Cart.tsx', '--cache', '/tmp/c', 'second'],
      extraOptions: { cache: { type: 'string' } },
    });
    expect(cfg._positionals).toEqual(['Cart.tsx', 'second']);
    expect(cfg._flags.cache).toBe('/tmp/c');
  });
});
