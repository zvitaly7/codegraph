import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_CLIENTS,
  MCP_SERVER_ENTRY,
  MCP_SERVER_NAME,
  detectAgentConfigs,
  detectProject,
  listTopLevelDirs,
  pickSrcRoots,
  readPackageJson,
} from './detect.mjs';

function fixture(prefix = 'lg-detect-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('listTopLevelDirs', () => {
  it('lists code-ish top-level directories, sorted, skipping dot-dirs and known noise', () => {
    const dir = fixture();
    for (const d of ['src', 'app', 'node_modules', 'dist', 'coverage', '.git', '.cache', 'server']) {
      mkdirSync(join(dir, d), { recursive: true });
    }
    writeFileSync(join(dir, 'package.json'), '{}');

    expect(listTopLevelDirs(dir)).toEqual(['app', 'server', 'src']);
  });

  it('returns an empty list for a directory that does not exist', () => {
    expect(listTopLevelDirs(join(tmpdir(), 'lg-does-not-exist-42'))).toEqual([]);
  });
});

describe('pickSrcRoots', () => {
  it('prefers the well-known roots, in the canonical order', () => {
    const picked = pickSrcRoots(['app', 'packages', 'src', 'zzz']);
    expect(picked.srcRoots).toEqual(['src', 'app', 'packages']);
    expect(picked.usedFallback).toBe(false);
  });

  it('falls back to the DEFAULTS root but surfaces the real dirs as candidates', () => {
    const picked = pickSrcRoots(['server', 'client']);
    expect(picked.srcRoots).toEqual(['src']);
    expect(picked.usedFallback).toBe(true);
    expect(picked.candidates).toEqual(['server', 'client']);
  });

  it('falls back for a repo with no top-level dirs at all', () => {
    const picked = pickSrcRoots([]);
    expect(picked.srcRoots).toEqual(['src']);
    expect(picked.usedFallback).toBe(true);
    expect(picked.candidates).toEqual([]);
  });
});

describe('readPackageJson', () => {
  it('reports absence without throwing', () => {
    const dir = fixture();
    const pkg = readPackageJson(dir);
    expect(pkg.exists).toBe(false);
    expect(pkg.data).toBeUndefined();
  });

  it('reads the name and keeps the raw text', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "demo"\n}\n');
    const pkg = readPackageJson(dir);
    expect(pkg.exists).toBe(true);
    expect(pkg.data.name).toBe('demo');
    expect(pkg.raw).toContain('"demo"');
  });

  it('surfaces a parse error instead of throwing', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'package.json'), '{ not json');
    const pkg = readPackageJson(dir);
    expect(pkg.exists).toBe(true);
    expect(pkg.error).toBeTruthy();
    expect(pkg.data).toBeUndefined();
  });
});

describe('MCP client table', () => {
  it('uses the schema key each client actually reads', () => {
    const byFile = Object.fromEntries(MCP_CLIENTS.map((c) => [c.file, c.key]));
    // Claude Code and Cursor read a top-level `mcpServers` object...
    expect(byFile['.mcp.json']).toBe('mcpServers');
    expect(byFile['.cursor/mcp.json']).toBe('mcpServers');
    // ...VS Code reads a top-level `servers` object instead.
    expect(byFile['.vscode/mcp.json']).toBe('servers');
  });

  it('describes a stdio entry that runs without a global install', () => {
    expect(MCP_SERVER_NAME).toBe('loregraph');
    expect(MCP_SERVER_ENTRY).toEqual({ command: 'npx', args: ['-y', 'loregraph', 'mcp'] });
  });
});

describe('detectAgentConfigs', () => {
  it('flags only the agent config files that already exist', () => {
    const dir = fixture();
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(join(dir, '.cursor', 'mcp.json'), '{}');

    const found = detectAgentConfigs(dir);
    expect(found.filter((c) => c.exists).map((c) => c.file)).toEqual(['.cursor/mcp.json']);
    expect(found).toHaveLength(MCP_CLIENTS.length);
  });
});

describe('detectProject', () => {
  it('summarises a typical project', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { test: 'vitest' } }));
    writeFileSync(join(dir, 'tsconfig.json'), '{}');

    const p = detectProject({ repoRoot: dir });
    expect(p.projectName).toBe('shop');
    expect(p.srcRoots).toEqual(['src']);
    expect(p.hasTsconfig).toBe(true);
    expect(p.hasPackageJson).toBe(true);
    expect(p.isGitRepo).toBe(true);
    expect(p.hasConfigFile).toBe(false);
  });

  it('falls back to the directory name when there is no package.json', () => {
    const dir = fixture('lg-detect-noname-');
    const p = detectProject({ repoRoot: dir });
    expect(p.hasPackageJson).toBe(false);
    expect(p.projectName).toBe(dir.split('/').pop());
    expect(p.isGitRepo).toBe(false);
    expect(p.hasTsconfig).toBe(false);
  });

  it('spots an existing loregraph config in either supported format', () => {
    const mjs = fixture();
    writeFileSync(join(mjs, 'loregraph.config.mjs'), 'export default {};\n');
    expect(detectProject({ repoRoot: mjs }).hasConfigFile).toBe(true);

    const json = fixture();
    writeFileSync(join(json, 'loregraph.config.json'), '{}');
    const p = detectProject({ repoRoot: json });
    expect(p.hasConfigFile).toBe(true);
    expect(p.configFile).toBe('loregraph.config.json');
  });
});
