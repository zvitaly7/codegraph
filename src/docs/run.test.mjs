import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';
import { BEGIN_MARKER, END_MARKER, wrapGenerated } from './lib/merge.mjs';

function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

const file = (path) => ({
  id: `file:${path}`,
  labels: ['File'],
  properties: { path, name: path.split('/').pop(), language: 'TypeScript', kind: 'code' },
});
const edge = (type, from, to, properties = {}) => ({ id: `edge:${from}:${type}:${to}`, type, from, to, properties });

/** A cache whose manifest names `repoRoot`, with two files in two domains. */
function seedCache(repoRoot, { extraFiles = [] } = {}) {
  const cache = mkdtempSync(join(tmpdir(), 'cg-docs-cli-'));
  mkdirSync(join(cache, 'inventory'), { recursive: true });
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({
    projectId: 'project:demo', snapshotId: 'snapshot:demo:rev1', repoRoot,
    vcs: { type: 'git', revision: 'rev1' },
  }));
  writeLayer(cache, 'inventory', {
    nodes: [
      { id: 'project:demo', labels: ['Project'], properties: { name: 'demo', root: repoRoot } },
      file('src/core/index.ts'), file('src/ui/button.tsx'), ...extraFiles.map(file),
    ],
  });
  writeLayer(cache, 'imports', {
    nodes: [{ id: 'pkg:react', labels: ['Package'], properties: { name: 'react' } }],
    edges: [edge('IMPORTS', 'file:src/ui/button.tsx', 'file:src/core/index.ts', { kind: 'internal' })],
  });
  writeLayer(cache, 'symbols', {
    nodes: [{ id: 'sym:src/core/index.ts#setup', labels: ['Symbol'], properties: { name: 'setup', kind: 'function', exported: true, path: 'src/core/index.ts', line: 1 } }],
    edges: [edge('DECLARES', 'file:src/core/index.ts', 'sym:src/core/index.ts#setup')],
  });
  writeLayer(cache, 'references', {});
  writeLayer(cache, 'usages', {});
  writeLayer(cache, 'domains', {
    nodes: [
      { id: 'domain:core', labels: ['Domain'], properties: { name: 'core', kind: 'platform' } },
      { id: 'domain:ui', labels: ['Domain'], properties: { name: 'ui', kind: 'product' } },
    ],
    edges: [
      edge('BELONGS_TO', 'file:src/core/index.ts', 'domain:core'),
      edge('BELONGS_TO', 'file:src/ui/button.tsx', 'domain:ui'),
      edge('DEPENDS_ON', 'domain:ui', 'domain:core', { weight: 1 }),
    ],
  });
  return cache;
}

let repo;
let cache;
let out;
let err;
let warnings;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cg-docs-repo-'));
  cache = seedCache(repo);
  out = [];
  err = [];
  warnings = [];
  vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation((s) => err.push(String(s)));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { warnings.push(String(s)); return true; });
});
afterEach(() => vi.restoreAllMocks());

const stdout = () => out.join('\n');
const stderr = () => [...err, ...warnings].join('\n');
const read = (...p) => readFileSync(join(...p), 'utf8');
const docsDir = () => join(repo, 'docs', 'codegraph');

describe('docs CLI — preconditions', () => {
  it('exits 2 and points at regenerate when the cache dir does not exist', async () => {
    const code = await run(['--repo-root', repo, '--cache', join(repo, 'nope')]);
    expect(code).toBe(2);
    expect(stderr()).toContain('codegraph regenerate');
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(false);
  });

  it('exits 2 when the cache holds no graph artifacts', async () => {
    const emptyCache = mkdtempSync(join(tmpdir(), 'cg-docs-empty-'));
    const code = await run(['--repo-root', repo, '--cache', emptyCache]);
    expect(code).toBe(2);
    expect(stderr()).toContain('codegraph regenerate');
  });

  it('warns on stderr but still generates from a stale cache', async () => {
    // A revision that cannot match a real HEAD, and a repoRoot inside a git repo.
    const manifestPath = join(cache, 'inventory', 'manifest.json');
    const manifest = JSON.parse(read(manifestPath));
    manifest.repoRoot = process.cwd();          // a real git checkout
    manifest.vcs = { type: 'git', revision: '0000000000000000000000000000000000000000' };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const code = await run(['--repo-root', repo, '--cache', cache]);
    expect(code).toBe(0);
    expect(stderr().toLowerCase()).toContain('stale');
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
  });
});

describe('docs CLI — the generated set', () => {
  it('writes AGENTS.md at the repo root and the pages under docs/codegraph', async () => {
    const code = await run(['--repo-root', repo, '--cache', cache]);
    expect(code).toBe(0);

    for (const rel of ['README.md', 'dependencies.md', 'health.md', 'domains/core.md', 'domains/ui.md']) {
      expect(existsSync(join(docsDir(), rel))).toBe(true);
    }
    const agents = read(repo, 'AGENTS.md');
    expect(agents).toContain('demo');
    expect(agents).toContain('codegraph brief');
    expect(agents).toContain(BEGIN_MARKER);
    expect(agents).toContain(END_MARKER);
    expect(stdout()).toContain('AGENTS.md');
  });

  it('honors --out-docs and --agents-out so nothing lands where it should not', async () => {
    const outDocs = mkdtempSync(join(tmpdir(), 'cg-docs-out-'));
    const agentsOut = join(outDocs, 'AGENTS.md');
    const code = await run(['--repo-root', repo, '--cache', cache, '--out-docs', outDocs, '--agents-out', agentsOut]);
    expect(code).toBe(0);
    expect(existsSync(agentsOut)).toBe(true);
    expect(existsSync(join(outDocs, 'health.md'))).toBe(true);
    // the repo itself was left alone
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(repo, 'docs'))).toBe(false);
    // AGENTS.md sits inside the docs dir here, so its links stay local
    expect(read(agentsOut)).toContain('](./health.md)');
    expect(read(outDocs, 'README.md')).toContain('](AGENTS.md)');
  });

  it('is idempotent — a second run changes no bytes', async () => {
    await run(['--repo-root', repo, '--cache', cache]);
    const first = ['AGENTS.md'].map((f) => read(repo, f))
      .concat(['README.md', 'dependencies.md', 'health.md', 'domains/core.md'].map((f) => read(docsDir(), f)));

    await run(['--repo-root', repo, '--cache', cache]);
    const second = ['AGENTS.md'].map((f) => read(repo, f))
      .concat(['README.md', 'dependencies.md', 'health.md', 'domains/core.md'].map((f) => read(docsDir(), f)));

    expect(second).toEqual(first);
    expect(stdout()).toMatch(/unchanged/i);
  });
});

describe('docs CLI — hand-written content survives regeneration', () => {
  it('keeps a human paragraph outside the markers and still updates the generated block', async () => {
    await run(['--repo-root', repo, '--cache', cache]);

    const note = 'Hand-written: the `ui` domain is being folded into `core`, ask #arch before adding files.';
    const before = read(repo, 'AGENTS.md');
    writeFileSync(join(repo, 'AGENTS.md'), `${before}\n## Team notes\n\n${note}\n`);
    // ...and a note ABOVE the block on a domain page
    const domainPage = join(docsDir(), 'domains', 'core.md');
    writeFileSync(domainPage, `Hand-written intro line.\n\n${read(domainPage)}`);

    // The graph grows: a new file appears, so the generated numbers must change.
    const grown = seedCache(repo, { extraFiles: ['src/core/extra.ts', 'src/core/more.ts'] });
    const code = await run(['--repo-root', repo, '--cache', grown]);
    expect(code).toBe(0);

    const agents = read(repo, 'AGENTS.md');
    expect(agents).toContain(note);              // survived verbatim
    expect(agents).toContain('## Team notes');
    expect(agents).toContain('4 files');         // generated part updated (2 → 4)
    expect(agents.split(BEGIN_MARKER)).toHaveLength(2); // still exactly one block

    const core = read(domainPage);
    expect(core).toContain('Hand-written intro line.');
    expect(core.indexOf('Hand-written intro line.')).toBeLessThan(core.indexOf(BEGIN_MARKER));
  });

  it('skips a marker-less human file with a warning and leaves it byte-identical', async () => {
    const human = '# AGENTS\n\nWritten by a person, no markers anywhere.\n';
    writeFileSync(join(repo, 'AGENTS.md'), human);

    const code = await run(['--repo-root', repo, '--cache', cache]);
    expect(code).toBe(0);
    expect(read(repo, 'AGENTS.md')).toBe(human);
    expect(stderr()).toMatch(/skip/i);
    expect(stderr()).toContain('--force');
    // the other pages were still generated
    expect(existsSync(join(docsDir(), 'health.md'))).toBe(true);
  });

  it('--force overwrites the marker-less file', async () => {
    writeFileSync(join(repo, 'AGENTS.md'), '# AGENTS\n\nWritten by a person.\n');
    const code = await run(['--repo-root', repo, '--cache', cache, '--force']);
    expect(code).toBe(0);
    const agents = read(repo, 'AGENTS.md');
    expect(agents).not.toContain('Written by a person');
    expect(agents).toContain(BEGIN_MARKER);
  });

  it('--force does not discard hand-written text around an existing block', async () => {
    await run(['--repo-root', repo, '--cache', cache]);
    writeFileSync(join(repo, 'AGENTS.md'), `Keep me.\n\n${read(repo, 'AGENTS.md')}`);
    await run(['--repo-root', repo, '--cache', cache, '--force']);
    expect(read(repo, 'AGENTS.md')).toContain('Keep me.');
  });
});

describe('docs CLI — i18n', () => {
  it('--lang ru localizes headings but not identifiers or paths', async () => {
    await run(['--repo-root', repo, '--cache', cache, '--lang', 'ru']);
    const agents = read(repo, 'AGENTS.md');
    expect(agents).toMatch(/[А-Яа-я]/);
    expect(agents).toContain('demo');
    expect(agents).toContain('codegraph brief');
    expect(agents).toContain('src/');
    expect(existsSync(join(docsDir(), 'domains', 'core.md'))).toBe(true); // file names unchanged
  });

  it('rejects an unsupported language with a usage error', async () => {
    const code = await run(['--repo-root', repo, '--cache', cache, '--lang', 'kl']);
    expect(code).toBe(2);
    expect(stderr()).toContain('--lang');
  });

  it('reads the language from the project config when no flag is given', async () => {
    writeFileSync(join(repo, 'codegraph.config.json'), JSON.stringify({ lang: 'ru' }));
    await run(['--repo-root', repo, '--cache', cache]);
    expect(read(repo, 'AGENTS.md')).toMatch(/[А-Яа-я]/);
    rmSync(join(repo, 'codegraph.config.json'));
  });
});

describe('docs CLI — report', () => {
  it('summarizes what it wrote', async () => {
    await run(['--repo-root', repo, '--cache', cache]);
    expect(stdout()).toMatch(/created/i);
    expect(stdout()).toContain(docsDir());
  });

  it('a fresh page is written as one wrapped block', async () => {
    await run(['--repo-root', repo, '--cache', cache]);
    const health = read(docsDir(), 'health.md');
    expect(health.startsWith(BEGIN_MARKER)).toBe(true);
    expect(health.trimEnd().endsWith(END_MARKER)).toBe(true);
    expect(health).toBe(wrapGenerated(health.slice(BEGIN_MARKER.length + 1, health.lastIndexOf(END_MARKER))));
  });
});
