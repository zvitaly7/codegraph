// THE HARD INVARIANT: `incremental` mode must produce byte-identical
// references/usages artifacts to a full (`off`) rebuild of the SAME working tree.
//
// Each case builds a full graph, mutates the tree, rebuilds it incrementally,
// then builds a fresh full graph of the mutated tree in a separate cache — and
// asserts the incremental nodes.jsonl + edges.jsonl equal the fresh-full ones,
// byte for byte, for both references and usages. Cases cover: modifying a
// declaration used cross-file, adding a file, and deleting a file.

import {
  describe, it, expect, beforeAll, afterAll, vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as inventoryRun } from '../inventory/run.mjs';
import { run as importsRun } from '../imports/run.mjs';
import { run as symbolsRun } from '../symbols/run.mjs';
import { run as referencesRun } from '../references/run.mjs';
import { run as usagesRun } from '../usages/run.mjs';

/** Run the full layer sequence into `out`; heavy layers honor `incremental`. */
async function buildGraph(repo, out, { incremental } = {}) {
  const base = ['--repo-root', repo, '--out', out];
  expect(await inventoryRun([...base])).toBe(0);
  expect(await importsRun([...base])).toBe(0);
  expect(await symbolsRun([...base])).toBe(0);
  const heavy = incremental ? [...base, '--incremental', incremental] : base;
  expect(await referencesRun([...heavy])).toBe(0);
  expect(await usagesRun([...heavy])).toBe(0);
}

function gitInit(repo) {
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  return g;
}

/** Write files (map of relPath → contents) under repo, creating dirs. */
function writeFiles(repo, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents);
  }
}

const read = (dir, layer, file) => readFileSync(join(dir, layer, file), 'utf8');

/** Assert references+usages nodes.jsonl and edges.jsonl are byte-identical. */
function expectHeavyIdentical(incDir, fullDir) {
  for (const layer of ['references', 'usages']) {
    expect(read(incDir, layer, 'nodes.jsonl')).toBe(read(fullDir, layer, 'nodes.jsonl'));
    expect(read(incDir, layer, 'edges.jsonl')).toBe(read(fullDir, layer, 'edges.jsonl'));
  }
}

// Capture stderr notes so each case can PROVE it took the incremental path
// (a silent fallback to full would pass the identity check vacuously).
let errLines = [];
function expectTookIncrementalPath() {
  const err = errLines.join('\n');
  expect(err).toMatch(/references: incremental —/);
  expect(err).toMatch(/usages: incremental —/);
  expect(err).not.toMatch(/fallback to full/);
}

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...a) => { errLines.push(a.join(' ')); });
});
afterAll(() => vi.restoreAllMocks());

describe('incremental == full (byte-identical heavy artifacts)', () => {
  const dirs = [];
  const mkrepo = (tag) => {
    const d = mkdtempSync(join(tmpdir(), `cg-eq-${tag}-`));
    dirs.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('modifying a declaration used cross-file', async () => {
    const repo = mkrepo('mod');
    writeFiles(repo, {
      'src/util.ts': 'export function add(a: number, b: number) { return a + b; }\nexport const K = 1;\n',
      'src/main.ts': "import { add, K } from './util';\nexport function total() { return add(K, 2); }\n",
      'src/other.ts': "import { total } from './main';\nexport const t = total();\n",
    });
    const g = gitInit(repo);
    g('add', '-A');
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });

    const inc = join(repo, '.kg-inc');
    await buildGraph(repo, inc, { incremental: 'off' }); // seed the cache (full)

    // Rename the cross-file declaration `add` → `addup` (only util.ts changes).
    writeFiles(repo, {
      'src/util.ts': 'export function addup(a: number, b: number) { return a + b; }\nexport const K = 1;\n',
    });

    errLines = [];
    await buildGraph(repo, inc, { incremental: 'incremental' }); // incremental rebuild
    expectTookIncrementalPath();

    const full = mkdtempSync(join(tmpdir(), 'cg-eq-mod-full-'));
    dirs.push(full);
    await buildGraph(repo, full, { incremental: 'off' }); // fresh full of the mutated tree

    expectHeavyIdentical(inc, full);
  });

  it('adding a file that an existing file imports', async () => {
    const repo = mkrepo('add');
    writeFiles(repo, {
      'src/util.ts': 'export function add(a: number, b: number) { return a + b; }\n',
      'src/main.ts': "import { add } from './util';\nexport function total() { return add(1, 2); }\n",
      'src/other.ts': "import { total } from './main';\nexport const t = total();\n",
    });
    const g = gitInit(repo);
    g('add', '-A');
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });

    const inc = join(repo, '.kg-inc');
    await buildGraph(repo, inc, { incremental: 'off' });

    // Add a new file and wire main.ts to import + use it.
    writeFiles(repo, {
      'src/extra.ts': 'export const E = 5;\n',
      'src/main.ts':
        "import { add } from './util';\nimport { E } from './extra';\nexport function total() { return add(1, 2) + E; }\n",
    });

    errLines = [];
    await buildGraph(repo, inc, { incremental: 'incremental' });
    expectTookIncrementalPath();

    const full = mkdtempSync(join(tmpdir(), 'cg-eq-add-full-'));
    dirs.push(full);
    await buildGraph(repo, full, { incremental: 'off' });

    expectHeavyIdentical(inc, full);
  });

  it('deleting a file that another file imports', async () => {
    const repo = mkrepo('del');
    writeFiles(repo, {
      'src/util.ts': 'export function add(a: number, b: number) { return a + b; }\n',
      'src/other.ts': 'export const O = 9;\n',
      'src/main.ts':
        "import { add } from './util';\nimport { O } from './other';\nexport const m = add(O, 1);\n",
    });
    const g = gitInit(repo);
    g('add', '-A');
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });

    const inc = join(repo, '.kg-inc');
    await buildGraph(repo, inc, { incremental: 'off' });

    // Delete other.ts (main.ts still imports O — now unresolved).
    rmSync(join(repo, 'src', 'other.ts'));

    errLines = [];
    await buildGraph(repo, inc, { incremental: 'incremental' });
    expectTookIncrementalPath();

    const full = mkdtempSync(join(tmpdir(), 'cg-eq-del-full-'));
    dirs.push(full);
    await buildGraph(repo, full, { incremental: 'off' });

    expectHeavyIdentical(inc, full);
  });

  it('no changes at all: incremental re-run equals the fresh full', async () => {
    const repo = mkrepo('noop');
    writeFiles(repo, {
      'src/util.ts': 'export function add(a: number, b: number) { return a + b; }\n',
      'src/main.ts': "import { add } from './util';\nexport const m = add(1, 2);\n",
    });
    const g = gitInit(repo);
    g('add', '-A');
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' });

    const inc = join(repo, '.kg-inc');
    await buildGraph(repo, inc, { incremental: 'off' });
    errLines = [];
    await buildGraph(repo, inc, { incremental: 'incremental' }); // zero changes
    expectTookIncrementalPath();

    const full = mkdtempSync(join(tmpdir(), 'cg-eq-noop-full-'));
    dirs.push(full);
    await buildGraph(repo, full, { incremental: 'off' });

    expectHeavyIdentical(inc, full);
  });
});
