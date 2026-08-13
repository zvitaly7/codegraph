import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';

function writeInventory(dir, rows, manifest = { snapshotId: 'snapshot:demo:rev1' }) {
  const inv = join(dir, '.kg-cache', 'inventory');
  mkdirSync(inv, { recursive: true });
  writeFileSync(join(inv, 'files.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(inv, 'manifest.json'), JSON.stringify(manifest));
  return inv;
}

function writeSymbols(dir, nodes, manifest = { basedOnSnapshot: 'snapshot:demo:rev1' }) {
  const sym = join(dir, '.kg-cache', 'symbols');
  mkdirSync(sym, { recursive: true });
  writeFileSync(join(sym, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(sym, 'manifest.json'), JSON.stringify(manifest));
  return sym;
}

function symbolNode(path, name, exported) {
  return {
    id: `sym:${path}#${name}`, labels: ['Symbol'],
    properties: { name, kind: 'function', exported, path, line: 1 },
  };
}

function readLines(p) {
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let repo;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'cg-ref-run-')); });

function src(rel, text) {
  const p = join(repo, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

const outArg = () => ['--repo-root', repo, '--out', join(repo, '.kg-cache')];

describe('run() happy path', () => {
  it('writes manifest/nodes/edges and computes reference counts + deadExports', async () => {
    src('src/a.ts', 'export function foo() {}\n');
    src('src/b.ts', "import { foo } from './a';\nexport const useFoo = () => foo();\n");
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    writeSymbols(repo, [
      { id: 'file:src/a.ts', labels: ['File'], properties: { path: 'src/a.ts' } },
      symbolNode('src/a.ts', 'foo', true),
      symbolNode('src/b.ts', 'useFoo', true),
    ]);

    const code = await run(outArg());
    expect(code).toBe(0);

    const out = join(repo, '.kg-cache', 'references');
    for (const f of ['manifest.json', 'nodes.jsonl', 'edges.jsonl']) {
      expect(existsSync(join(out, f))).toBe(true);
    }

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.basedOnSnapshot).toBe('snapshot:demo:rev1');
    expect(typeof manifest.generatedAt).toBe('string');
    // b references a#foo (cross-file). foo is referenced; useFoo is a dead export.
    expect(manifest.counts).toEqual({ files: 1, symbolsReferenced: 1, edges: 1, deadExports: 1 });

    const edges = readLines(join(out, 'edges.jsonl'));
    expect(edges).toContainEqual({
      id: 'edge:file:src/b.ts:REFERENCES:sym:src/a.ts#foo',
      type: 'REFERENCES', from: 'file:src/b.ts', to: 'sym:src/a.ts#foo',
      properties: { sameFile: false },
    });

    // The referenced Symbol node is reused verbatim from the symbols layer.
    const nodes = readLines(join(out, 'nodes.jsonl'));
    expect(nodes).toContainEqual(symbolNode('src/a.ts', 'foo', true));
    expect(nodes).toContainEqual({ id: 'file:src/b.ts', labels: ['File'], properties: { path: 'src/b.ts' } });
  });

  it('is deterministic across runs (byte-identical nodes/edges)', async () => {
    src('src/a.ts', 'export function foo() {}\n');
    src('src/b.ts', "import { foo } from './a';\nexport const useFoo = () => foo();\n");
    writeInventory(repo, [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' },
    ]);
    writeSymbols(repo, [symbolNode('src/a.ts', 'foo', true), symbolNode('src/b.ts', 'useFoo', true)]);

    const out = join(repo, '.kg-cache', 'references');
    await run(outArg());
    const first = readFileSync(join(out, 'edges.jsonl'), 'utf8');
    await run(outArg());
    const second = readFileSync(join(out, 'edges.jsonl'), 'utf8');
    expect(second).toBe(first);
  });
});

describe('run() exit codes & flags', () => {
  it('missing inventory manifest → 2', async () => {
    const code = await run(outArg());
    expect(code).toBe(2);
  });

  it('missing symbols manifest → 2', async () => {
    writeInventory(repo, [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }]);
    src('src/a.ts', 'export const a = 1;\n');
    const code = await run(outArg());
    expect(code).toBe(2);
  });

  it('bad --max-files value → 2', async () => {
    writeInventory(repo, [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' }]);
    writeSymbols(repo, [symbolNode('src/a.ts', 'a', true)]);
    src('src/a.ts', 'export const a = 1;\n');
    const code = await run([...outArg(), '--max-files', 'abc']);
    expect(code).toBe(2);
  });

  it('honors --symbols / --inventory pointing at custom dirs', async () => {
    const inv = join(repo, 'inv');
    const symdir = join(repo, 'sym');
    mkdirSync(inv, { recursive: true });
    mkdirSync(symdir, { recursive: true });
    writeFileSync(join(inv, 'files.jsonl'),
      [{ id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
        { id: 'file:src/b.ts', path: 'src/b.ts', language: 'TypeScript', kind: 'code' }]
        .map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(inv, 'manifest.json'), JSON.stringify({ snapshotId: 'snapshot:x:y' }));
    writeFileSync(join(symdir, 'nodes.jsonl'),
      [symbolNode('src/a.ts', 'foo', true)].map((n) => JSON.stringify(n)).join('\n'));
    writeFileSync(join(symdir, 'manifest.json'), JSON.stringify({ basedOnSnapshot: 'snapshot:x:y' }));
    src('src/a.ts', 'export function foo() {}\n');
    src('src/b.ts', "import { foo } from './a';\nexport const g = () => foo();\n");

    const code = await run([...outArg(), '--inventory', inv, '--symbols', symdir]);
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(repo, '.kg-cache', 'references', 'manifest.json'), 'utf8'));
    expect(manifest.basedOnSnapshot).toBe('snapshot:x:y');
    expect(manifest.counts.edges).toBe(1);
  });
});
