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

  it('zero-config lookup falls back to codegraph.config.json when .mjs is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-load-json-zero-'));
    writeFileSync(join(dir, 'codegraph.config.json'), JSON.stringify({ srcRoots: ['lib'] }), 'utf8');

    const cfg = await resolveConfig({ cwd: dir, argv: ['--repo-root', dir] });

    expect(cfg.srcRoots).toEqual(['lib']); // auto-discovered codegraph.config.json
  });
});
