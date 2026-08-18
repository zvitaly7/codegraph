import { describe, it, expect } from 'vitest';
import { DEFAULTS } from '../../config/defaults.mjs';
import {
  HOOK_BEGIN,
  INIT_SCRIPTS,
  isIgnoreEntryCovered,
  planGitignore,
  planJsonServerEntry,
  planPackageScripts,
  planPostMergeHook,
  renderConfigFile,
} from './writers.mjs';

describe('isIgnoreEntryCovered', () => {
  it('matches the entry regardless of leading slash, trailing slash or **/ prefix', () => {
    for (const line of ['.kg-cache', '.kg-cache/', '/.kg-cache', '/.kg-cache/', '**/.kg-cache/']) {
      expect(isIgnoreEntryCovered(`node_modules/\n${line}\n`, '.kg-cache/')).toBe(true);
    }
  });

  it('ignores comments, blank lines and negations', () => {
    expect(isIgnoreEntryCovered('# .kg-cache/\n\n', '.kg-cache/')).toBe(false);
    expect(isIgnoreEntryCovered('!.kg-cache/\n', '.kg-cache/')).toBe(false);
  });

  it('does not treat a longer path as coverage', () => {
    expect(isIgnoreEntryCovered('.kg-cache-old/\nsrc/.kg-cache/\n', '.kg-cache/')).toBe(false);
  });
});

describe('planGitignore', () => {
  it('creates the file when absent', () => {
    const plan = planGitignore(null, { entry: '.kg-cache/', comment: '# loregraph cache' });
    expect(plan.status).toBe('create');
    expect(plan.content).toBe('# loregraph cache\n.kg-cache/\n');
  });

  it('appends one commented block, separated from what is already there', () => {
    const plan = planGitignore('node_modules/\n', { entry: '.kg-cache/', comment: '# loregraph cache' });
    expect(plan.status).toBe('update');
    expect(plan.content).toBe('node_modules/\n\n# loregraph cache\n.kg-cache/\n');
  });

  it('adds the missing newline before appending to a file that lacks one', () => {
    const plan = planGitignore('node_modules/', { entry: '.kg-cache/', comment: '# c' });
    expect(plan.content).toBe('node_modules/\n\n# c\n.kg-cache/\n');
  });

  it('is a no-op when the entry is already covered', () => {
    const existing = 'node_modules/\n.kg-cache\n';
    const plan = planGitignore(existing, { entry: '.kg-cache/', comment: '# c' });
    expect(plan.status).toBe('unchanged');
    expect(plan.content).toBe(existing);
  });
});

describe('planJsonServerEntry', () => {
  const entry = { command: 'npx', args: ['-y', 'loregraph', 'mcp'] };
  const opts = { key: 'mcpServers', name: 'loregraph', entry };

  it('creates a fresh file with the requested top-level key', () => {
    const plan = planJsonServerEntry(null, opts);
    expect(plan.status).toBe('create');
    expect(JSON.parse(plan.content)).toEqual({ mcpServers: { loregraph: entry } });
    expect(plan.content.endsWith('\n')).toBe(true);
  });

  it('honours the VS Code schema key', () => {
    const plan = planJsonServerEntry(null, { ...opts, key: 'servers' });
    expect(JSON.parse(plan.content)).toEqual({ servers: { loregraph: entry } });
  });

  it('merges next to other servers and preserves unrelated keys', () => {
    const existing = JSON.stringify({
      $schema: 'https://example.com/schema.json',
      mcpServers: { other: { command: 'node', args: ['other.js'] } },
      inputs: [{ id: 'token' }],
    }, null, 2);

    const plan = planJsonServerEntry(existing, opts);
    expect(plan.status).toBe('update');
    const parsed = JSON.parse(plan.content);
    expect(parsed.mcpServers.other).toEqual({ command: 'node', args: ['other.js'] });
    expect(parsed.mcpServers.loregraph).toEqual(entry);
    expect(parsed.$schema).toBe('https://example.com/schema.json');
    expect(parsed.inputs).toEqual([{ id: 'token' }]);
  });

  it('is a no-op when our entry is already there (key order aside)', () => {
    const existing = JSON.stringify({ mcpServers: { loregraph: { args: ['-y', 'loregraph', 'mcp'], command: 'npx' } } });
    const plan = planJsonServerEntry(existing, opts);
    expect(plan.status).toBe('unchanged');
  });

  it('leaves a differing entry alone and reports the conflict', () => {
    const existing = JSON.stringify({ mcpServers: { loregraph: { command: 'loregraph', args: ['mcp'] } } });
    const plan = planJsonServerEntry(existing, opts);
    expect(plan.status).toBe('conflict');
    expect(plan.content).toBeUndefined();
    expect(plan.existingEntry).toEqual({ command: 'loregraph', args: ['mcp'] });
  });

  it('refuses to touch a file it cannot parse', () => {
    expect(planJsonServerEntry('{ nope', opts).status).toBe('invalid');
    expect(planJsonServerEntry('[]', opts).status).toBe('invalid');
    expect(planJsonServerEntry('{"mcpServers": 3}', opts).status).toBe('invalid');
  });
});

describe('planPackageScripts', () => {
  it('adds both scripts when they are absent, keeping key order and 2-space JSON', () => {
    const existing = `${JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'vitest' } }, null, 2)}\n`;
    const plan = planPackageScripts(existing, INIT_SCRIPTS);

    expect(plan.status).toBe('update');
    expect(plan.added).toEqual(['graph', 'graph:explore']);
    expect(Object.keys(JSON.parse(plan.content))).toEqual(['name', 'version', 'scripts']);
    expect(Object.keys(JSON.parse(plan.content).scripts)).toEqual(['test', 'graph', 'graph:explore']);
    expect(plan.content.endsWith('\n')).toBe(true);
    expect(plan.content).toContain('\n  "name": "demo"');
  });

  it('creates the scripts object when the package has none', () => {
    const plan = planPackageScripts(JSON.stringify({ name: 'demo' }), INIT_SCRIPTS);
    expect(JSON.parse(plan.content).scripts).toEqual(INIT_SCRIPTS);
  });

  it('leaves an existing script alone and reports it as a conflict', () => {
    const existing = JSON.stringify({ scripts: { graph: 'my-own-thing' } });
    const plan = planPackageScripts(existing, INIT_SCRIPTS);

    expect(plan.status).toBe('update');
    expect(plan.added).toEqual(['graph:explore']);
    expect(plan.conflicts).toEqual([{ name: 'graph', existing: 'my-own-thing' }]);
    expect(JSON.parse(plan.content).scripts.graph).toBe('my-own-thing');
  });

  it('is a no-op when both scripts are already exactly ours', () => {
    const existing = JSON.stringify({ scripts: { ...INIT_SCRIPTS } });
    const plan = planPackageScripts(existing, INIT_SCRIPTS);
    expect(plan.status).toBe('unchanged');
    expect(plan.content).toBeUndefined();
  });

  it('refuses to touch an unparseable package.json', () => {
    expect(planPackageScripts('{ nope', INIT_SCRIPTS).status).toBe('invalid');
  });
});

describe('planPostMergeHook', () => {
  it('creates a sentinel-marked hook when there is none', () => {
    const plan = planPostMergeHook(null);
    expect(plan.status).toBe('create');
    expect(plan.content.startsWith('#!/bin/sh\n')).toBe(true);
    expect(plan.content).toContain(HOOK_BEGIN);
    expect(plan.content).toContain('npx loregraph regenerate --if-stale');
  });

  it('never modifies a hook written by someone else, and hands back a snippet', () => {
    const plan = planPostMergeHook('#!/bin/sh\necho hi\n');
    expect(plan.status).toBe('conflict');
    expect(plan.content).toBeUndefined();
    expect(plan.snippet).toContain('npx loregraph regenerate --if-stale');
  });

  it('recognises its own block so a second run adds nothing', () => {
    const first = planPostMergeHook(null);
    expect(planPostMergeHook(first.content).status).toBe('unchanged');
  });
});

describe('renderConfigFile', () => {
  const rendered = renderConfigFile({ projectName: 'demo', srcRoots: ['app', 'packages'] });

  it('exports the detected values and mentions the project', () => {
    expect(rendered).toContain('export default {');
    expect(rendered).toContain("srcRoots: ['app', 'packages'],");
    expect(rendered).toContain('demo');
    expect(rendered.endsWith('\n')).toBe(true);
  });

  it('documents every remaining knob commented out at its real default', () => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (key === 'srcRoots') continue;
      const lit = (v) => {
        if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
        return typeof v === 'string' ? `'${v}'` : String(v);
      };
      expect(rendered).toContain(`// ${key}: ${lit(value)},`);
    }
  });

  it('is valid JavaScript that evaluates to the detected config', async () => {
    const mod = await import(`data:text/javascript,${encodeURIComponent(rendered)}`);
    expect(mod.default).toEqual({ srcRoots: ['app', 'packages'] });
  });

  it('records a non-default cache dir instead of leaving it commented out', async () => {
    const custom = renderConfigFile({ projectName: 'demo', srcRoots: ['src'], outDir: '.cache/graph' });
    expect(custom).toContain("outDir: '.cache/graph',");
    expect(custom).not.toContain("// outDir: '.kg-cache',");
    const mod = await import(`data:text/javascript,${encodeURIComponent(custom)}`);
    expect(mod.default).toEqual({ srcRoots: ['src'], outDir: '.cache/graph' });
  });

  it('documents the check knob so the CI gate is discoverable without the README', () => {
    expect(rendered).toContain('// check: {');
    for (const rule of ['noCycles', 'maxDeadExports', 'minResolutionRate', 'domainRules']) {
      expect(rendered).toContain(rule);
    }
    // Commented out, so a fresh project is never gated on rules nobody chose.
    for (const line of rendered.split('\n')) {
      if (line.includes('check') || line.includes('noCycles') || line.includes('domainRules')) {
        expect(line.trimStart().startsWith('//')).toBe(true);
      }
    }
  });

  it('documents the describe knob, leading with the no-API-tokens path', () => {
    expect(rendered).toContain('// describe: {');
    expect(rendered).toContain('command:');
    expect(rendered).toContain('stdin');
    expect(rendered).toContain('ANTHROPIC_API_KEY');
    expect(rendered).toContain('pricing:');
    // Commented out, so it never silently turns on a paid provider.
    expect(rendered).toContain('MODEL-WRITTEN');
    for (const line of rendered.split('\n')) {
      if (line.includes('describe') || line.includes('command:') || line.includes('pricing:')) {
        expect(line.trimStart().startsWith('//')).toBe(true);
      }
    }
  });
});
