// The references and usages layers may share ONE TypeScript program — but only
// when they would have built the same one. These tests pin both halves of that:
// the sharing actually happens, and the artifacts are byte-identical to what the
// layers produce with a program each.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as inventoryRun } from '../inventory/run.mjs';
import { run as importsRun } from '../imports/run.mjs';
import { run as symbolsRun } from '../symbols/run.mjs';
import { run as referencesRun } from '../references/run.mjs';
import { run as usagesRun } from '../usages/run.mjs';
import { createProgramCache } from './program_cache.mjs';

/** A repo whose files reference each other, so both layers emit real edges. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'cg-progshare-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport function twice(n: number) { return n * 2; }\n');
  writeFileSync(join(repo, 'src', 'b.ts'), "import { a, twice } from './a';\nexport function useIt() { return twice(a); }\n");
  writeFileSync(join(repo, 'src', 'c.ts'), "import { useIt } from './b';\nexport function top() { return useIt(); }\n");
  return repo;
}

/** Run the cheap layers, then references + usages with an optional shared cache. */
async function build(repo, out, { programCache, referencesArgv = [], usagesArgv = [] } = {}) {
  const base = ['--repo-root', repo, '--out', out];
  expect(await inventoryRun([...base])).toBe(0);
  expect(await importsRun([...base])).toBe(0);
  expect(await symbolsRun([...base])).toBe(0);
  const ctx = programCache ? { programCache } : {};
  expect(await referencesRun([...base, ...referencesArgv], ctx)).toBe(0);
  expect(await usagesRun([...base, ...usagesArgv], ctx)).toBe(0);
}

const read = (dir, layer, file) => readFileSync(join(dir, layer, file), 'utf8');

function expectHeavyIdentical(a, b) {
  for (const layer of ['references', 'usages']) {
    for (const file of ['nodes.jsonl', 'edges.jsonl']) {
      expect(read(a, layer, file)).toBe(read(b, layer, file));
    }
  }
}

let repo;
const trash = [];

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  repo = makeRepo();
  trash.push(repo);
});
afterAll(() => {
  vi.restoreAllMocks();
  for (const dir of trash) rmSync(dir, { recursive: true, force: true });
});

describe('sharing one TypeScript program between references and usages', () => {
  it('builds ONE program for the two layers and emits identical artifacts', async () => {
    const shared = join(repo, '.kg-shared');
    const separate = join(repo, '.kg-separate');
    const cache = createProgramCache();

    await build(repo, shared, { programCache: cache });
    await build(repo, separate); // no cache → a program each, as when run standalone

    expect(cache.stats()).toEqual({ builds: 1, hits: 1 });
    expectHeavyIdentical(shared, separate);
  });

  it('does NOT share when the two layers analyse different file sets', async () => {
    const out = join(repo, '.kg-maxfiles');
    const cache = createProgramCache();

    // references sees every file; usages is capped at two. Sharing here would
    // analyse the wrong set, so the cache must build a second program instead.
    await build(repo, out, { programCache: cache, usagesArgv: ['--max-files', '2'] });

    expect(cache.stats()).toEqual({ builds: 2, hits: 0 });
  });

  it('capping BOTH layers the same way shares again', async () => {
    const out = join(repo, '.kg-maxfiles-both');
    const cache = createProgramCache();

    await build(repo, out, {
      programCache: cache,
      referencesArgv: ['--max-files', '2'],
      usagesArgv: ['--max-files', '2'],
    });

    expect(cache.stats()).toEqual({ builds: 1, hits: 1 });
  });

  it('a layer run with no cache at all still works (standalone behaviour)', async () => {
    const out = join(repo, '.kg-standalone');
    const base = ['--repo-root', repo, '--out', out];
    expect(await inventoryRun([...base])).toBe(0);
    expect(await importsRun([...base])).toBe(0);
    expect(await symbolsRun([...base])).toBe(0);
    // Called with ONE argument, exactly as `bin/loregraph.mjs` calls it.
    expect(await referencesRun([...base])).toBe(0);
    expect(await usagesRun([...base])).toBe(0);
    expect(read(out, 'references', 'edges.jsonl').length).toBeGreaterThan(0);
    expect(read(out, 'usages', 'edges.jsonl').length).toBeGreaterThan(0);
  });
});
