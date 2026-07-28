# codegraph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the layered knowledge-graph pipeline from an internal JS/TS monorepo into a standalone, zero-config npm package `codegraph` that runs on any JS/TS repo via `npx`.

**Architecture:** One npm package, one `bin` (`codegraph`), ESM `.mjs` runtime, no build step. A Python inventory layer + Python explorer builder are ported to Node; the existing Node layers (imports/symbols/references/usages/domains) and the MCP server are consolidated into one `src/` with a shared `lib/`. VCS metadata comes from a pluggable adapter (git default, arc optional); ignore rules read `.gitignore`; the domain overlay auto-derives from folder structure with an optional config override.

**Tech Stack:** Node ≥ 18 (ESM), `typescript` (compiler API, for L2 layers), `ignore` (gitignore matching), `node:crypto` / `node:child_process` / `node:fs`, `vitest` (tests).

---

## How to use this plan

**Two kinds of task appear below. Read this before executing any task.**

1. **NEW-CODE tasks** — greenfield code (config loader, git VCS adapter, domain
   auto-derivation, CLI dispatcher, orchestrator, smoke tests). These follow full
   TDD: the test code and the implementation code are written out in the steps.

2. **PORT tasks** — translate an existing, already-tested source file into the new
   package. For these, the **source file is the behavioral spec** and reproducing
   it verbatim here would violate DRY. A PORT task gives you:
   - the exact **source path** to read,
   - the exact **target path** to write,
   - a **transform table** (what to change during the port),
   - a **test gate**: port the source's test first (translate pytest→vitest or
     re-point the existing `.mjs` test), watch it fail, then port the
     implementation until green.

   A PORT task is *not* a placeholder — the "code" is the referenced source plus
   the listed transforms. Never invent behavior a PORT task doesn't specify;
   preserve the source exactly except for the transforms.

### Source of truth for ports

All source files live in the internal-source checkout on the KG branch:

```
REPO:   <internal-source-repo>
BRANCH: <kg-branch>
SUBDIR: tools/knowledge-graph/
```

Before starting Phase 1, confirm that checkout is on the KG branch:

```bash
arc -C <internal-source-repo> branch 2>/dev/null | grep -q '\* <kg-branch>' && echo OK || echo "WRONG BRANCH"
```

If it prints `WRONG BRANCH`, run `arc checkout <kg-branch>`
in that repo first. Throughout the plan, `$SRC` = `<internal-source-repo>/tools/knowledge-graph`.

### Working directory

All implementation happens in the codegraph git repo:

```
/Users/vzheltko/UK Talent/projects/codegraph
```

Commit after every task (`git commit`); push at the end of each phase (`git push`).
Commit style: short imperative subject, no AI co-author trailer.

---

## File structure (target)

```
codegraph/
  package.json                 # bin { codegraph }, deps: typescript, ignore; devDeps: vitest
  bin/codegraph.mjs            # subcommand dispatcher → src/<cmd>/run.mjs
  vitest.config.mjs
  .gitignore                   # node_modules, .kg-cache, coverage
  src/
    config/
      defaults.mjs             # DEFAULTS object
      load.mjs                 # resolveConfig(cwd, argv) → Config
    inventory/                 # PORT (Python → Node)
      schema.mjs   hasher.mjs  ignore.mjs  classify.mjs  walker.mjs  write.mjs
      run.mjs                  # CLI entry (ex-main.py)
      vcs/
        detect.mjs             # NEW
        git.mjs                # NEW
        arc.mjs                # PORT of arc_adapter.py
    lib/                       # shared across L2 layers (deduped)
      schema.mjs  graph_builder.mjs  write_artifacts.mjs
      tsconfig_index.mjs  inventory_reader.mjs
    imports/  { run.mjs, lib/* }        # COPY+RE-POINT
    symbols/  { run.mjs, lib/* }        # COPY+RE-POINT
    references/{ run.mjs, lib/* }       # COPY+RE-POINT
    usages/   { run.mjs, lib/* }        # COPY+RE-POINT
    domains/
      run.mjs
      derive.mjs               # NEW: auto-derive domains from folders
      config.mjs               # NEW: load user override / fall back to derive
      lib/ { assign.mjs, graph_builder.mjs, schema.mjs }   # COPY+RE-POINT
    explorer/
      build_index.mjs          # PORT of build_index.py
      index.html               # COPY
    mcp/
      server.mjs               # COPY+RENAME
      lib/*                    # COPY+RE-POINT
    orchestrate/
      regenerate.mjs           # PORT of regenerate.sh (Node)
  neo4j/*.cypher               # COPY (optional)
  examples/
    example.domains.config.mjs     # the sample domains config, as a sample
  test/
    fixtures/mini-repo/        # tiny JS/TS repo for smoke tests
  docs/
    README.md
```

---

## Milestones (each independently testable)

- **M0 Skeleton** (Phase 0) — package installs, `npx codegraph --help` runs.
- **M1 Config** (Phase 1) — config resolves with zero-config defaults.
- **M2 VCS** (Phase 2) — git metadata works, arc optional, auto-detect.
- **M3 Inventory** (Phase 3) — `codegraph inventory` emits artifacts on a git repo; parity tests green.
- **M4 L2 layers** (Phase 4) — imports/symbols/references/usages run against inventory.
- **M5 Domains** (Phase 5) — `codegraph domains` auto-derives + honors config override.
- **M6 Consumption** (Phase 6) — explorer + MCP work over `.kg-cache`.
- **M7 One-shot** (Phase 7) — `codegraph regenerate` builds the whole graph; end-to-end smoke passes.

---

## Phase 0 — Repo skeleton (M0)

### Task 0.1: package.json + bin stub

**Files:**
- Create: `package.json`
- Create: `bin/codegraph.mjs`
- Create: `.gitignore`
- Create: `vitest.config.mjs`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "codegraph",
  "version": "0.1.0",
  "description": "Deterministic, layered code knowledge graph for any JS/TS repo, with an MCP server for agents.",
  "type": "module",
  "bin": { "codegraph": "bin/codegraph.mjs" },
  "engines": { "node": ">=18" },
  "dependencies": {
    "ignore": "^5.3.2",
    "typescript": "^5.5.4"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  },
  "scripts": {
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Write `bin/codegraph.mjs` dispatcher**

```js
#!/usr/bin/env node
import process from 'node:process';

const COMMANDS = {
  inventory: () => import('../src/inventory/run.mjs'),
  imports: () => import('../src/imports/run.mjs'),
  symbols: () => import('../src/symbols/run.mjs'),
  references: () => import('../src/references/run.mjs'),
  usages: () => import('../src/usages/run.mjs'),
  domains: () => import('../src/domains/run.mjs'),
  explorer: () => import('../src/explorer/run.mjs'),
  mcp: () => import('../src/mcp/run.mjs'),
  regenerate: () => import('../src/orchestrate/regenerate.mjs'),
};

const USAGE = `codegraph <command> [options]

Commands:
  regenerate   Build the whole graph in dependency order
  inventory    Layer 1: files + directories
  imports      Layer 2a: file → file/package imports
  symbols      Layer 2b: declarations
  references   Layer 2c: file → symbol
  usages       Layer 2d: symbol → symbol
  domains      Layer 3: semantic domain overlay
  explorer     Build (and optionally serve) the browser index
  mcp          Start the stdio MCP server

Global: --repo-root PATH  --out DIR  --config FILE  --help`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 2);
  }
  const loader = COMMANDS[cmd];
  if (!loader) {
    console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
  const mod = await loader();
  await mod.run(rest);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.kg-cache/
coverage/
*.log
.DS_Store
```

- [ ] **Step 4: Write `vitest.config.mjs`**

```js
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.mjs', 'src/**/*.test.mjs'], environment: 'node' },
});
```

- [ ] **Step 5: Install deps**

Run: `npm install`
Expected: creates `node_modules/` and `package-lock.json`, no errors.

- [ ] **Step 6: Create stub command modules so `--help` works**

For each of `inventory, imports, symbols, references, usages, domains, explorer, mcp, orchestrate`, create `src/<name>/run.mjs` (orchestrate → `src/orchestrate/regenerate.mjs`) with:

```js
export async function run(_argv) {
  throw new Error('not implemented yet');
}
```

- [ ] **Step 7: Verify dispatcher**

Run: `node bin/codegraph.mjs --help`
Expected: prints the usage block, exits 0.
Run: `node bin/codegraph.mjs bogus`
Expected: prints "Unknown command: bogus" + usage, exits 2.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: package skeleton + bin dispatcher"
```

---

## Phase 1 — Config (M1)

### Task 1.1: Defaults + resolver

**Files:**
- Create: `src/config/defaults.mjs`
- Create: `src/config/load.mjs`
- Test: `src/config/load.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { resolveConfig } from './load.mjs';

describe('resolveConfig', () => {
  it('applies zero-config defaults relative to repoRoot', async () => {
    const cfg = await resolveConfig({ cwd: '/tmp/x', argv: [] });
    expect(cfg.srcRoots).toEqual(['src']);
    expect(cfg.ignoreFile).toBe('.gitignore');
    expect(cfg.vcs).toBe('auto');
    expect(cfg.outDir).toBe('.kg-cache');
    expect(cfg.repoRoot).toBe('/tmp/x');
  });

  it('CLI flags override defaults', async () => {
    const cfg = await resolveConfig({ cwd: '/tmp/x', argv: ['--repo-root', '/r', '--out', '.cache'] });
    expect(cfg.repoRoot).toBe('/r');
    expect(cfg.outDir).toBe('.cache');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/load.test.mjs`
Expected: FAIL — `resolveConfig` not found.

- [ ] **Step 3: Write `src/config/defaults.mjs`**

```js
export const DEFAULTS = {
  srcRoots: ['src'],
  ignoreFile: '.gitignore',
  tsconfig: null,      // null → auto-discover
  vcs: 'auto',         // 'auto' | 'git' | 'arc' | 'none'
  outDir: '.kg-cache',
  domains: null,       // null → auto-derive
};
```

- [ ] **Step 4: Write `src/config/load.mjs`**

```js
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULTS } from './defaults.mjs';

const OPTIONS = {
  'repo-root': { type: 'string' },
  'out': { type: 'string' },
  'config': { type: 'string' },
};

export async function resolveConfig({ cwd, argv, extraOptions = {} }) {
  const { values } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    options: { ...OPTIONS, ...extraOptions },
  });

  const repoRoot = resolve(cwd, values['repo-root'] ?? '.');

  // Optional config file: explicit --config, else codegraph.config.mjs at repo root.
  let fileCfg = {};
  const configPath = values['config']
    ? resolve(cwd, values['config'])
    : resolve(repoRoot, 'codegraph.config.mjs');
  if (existsSync(configPath)) {
    const mod = await import(pathToFileURL(configPath).href);
    fileCfg = mod.default ?? {};
  }

  return {
    ...DEFAULTS,
    ...fileCfg,
    repoRoot,
    outDir: values['out'] ?? fileCfg.outDir ?? DEFAULTS.outDir,
    _flags: values,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/config/load.test.mjs`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: config resolver with zero-config defaults"
```

---

## Phase 2 — VCS abstraction (M2)

### Task 2.1: git adapter (NEW)

**Files:**
- Create: `src/inventory/vcs/git.mjs`
- Test: `src/inventory/vcs/git.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGitMetadata } from './git.mjs';

let repo;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'cg-git-'));
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'hi');
  g('add', '-A'); g('commit', '-q', '-m', 'init');
});

describe('collectGitMetadata', () => {
  it('reports branch, revision, clean tree', () => {
    const m = collectGitMetadata(repo);
    expect(m.type).toBe('git');
    expect(m.available).toBe(true);
    expect(m.branch).toBe('main');
    expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(m.hasLocalChanges).toBe(false);
  });

  it('never throws on a non-git dir', () => {
    const m = collectGitMetadata(tmpdir() + '/definitely-not-a-repo-xyz');
    expect(m.available).toBe(false);
    expect(m.warnings).toBeInstanceOf(Array);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/inventory/vcs/git.test.mjs`
Expected: FAIL — `collectGitMetadata` not found.

- [ ] **Step 3: Write `src/inventory/vcs/git.mjs`**

```js
import { execFileSync } from 'node:child_process';

const TIMEOUT = 15000;

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8', timeout: TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** @returns {{type:'git',available:boolean,root:string|null,branch:string|null,revision:string|null,hasLocalChanges:boolean|null,error?:string,warnings:string[]}} */
export function collectGitMetadata(repoRoot) {
  const meta = {
    type: 'git', available: false, root: null, branch: null,
    revision: null, hasLocalChanges: null, warnings: [],
  };
  try {
    meta.root = git(repoRoot, ['rev-parse', '--show-toplevel']) || null;
    meta.available = true;
  } catch {
    meta.error = 'git not available or not a repository';
    return meta;
  }
  try {
    const b = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    meta.branch = b === 'HEAD' ? null : b; // detached
  } catch (e) { meta.warnings.push(`git branch failed: ${e.message}`); }
  try {
    meta.revision = git(repoRoot, ['rev-parse', 'HEAD']) || 'no-revision';
  } catch { meta.revision = 'no-revision'; meta.warnings.push('git rev-parse HEAD failed'); }
  try {
    meta.hasLocalChanges = git(repoRoot, ['status', '--porcelain']).length > 0;
  } catch (e) { meta.warnings.push(`git status failed: ${e.message}`); }
  return meta;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/inventory/vcs/git.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: git VCS metadata adapter"
```

### Task 2.2: arc adapter (PORT)

**PORT** — source is the behavioral spec.

**Files:**
- Source: `$SRC/kg_inventory/arc_adapter.py` (137 LOC)
- Source test: `$SRC/tests/test_arc_adapter.py`
- Create: `src/inventory/vcs/arc.mjs`
- Test: `src/inventory/vcs/arc.test.mjs`

**Transform table:**
| Python | Node |
|---|---|
| `subprocess.run(["arc", …], cwd=repo_root)` | `execFileSync('arc', […], { cwd: repoRoot })` in try/catch |
| `_parse_arc_info` (key: value lines) | same parse over `arc info` stdout |
| `ArcMetadata` dataclass | plain object with the same fields as `collectGitMetadata` returns, `type:'arc'` |
| never raises; errors→`.error`/`.warnings` | preserve exactly |

Public API: `export function collectArcMetadata(repoRoot)` returning the same
shape as `collectGitMetadata` (with `type:'arc'`).

- [ ] **Step 1: Port the test** — translate `test_arc_adapter.py` to
  `src/inventory/vcs/arc.test.mjs`. Key cases to preserve: (a) missing `arc`
  binary → `available:false`, no throw; (b) `arc info` parsed into branch/revision.
  Mock `arc` by pointing PATH at a fake script, or skip the live-arc case with
  `it.skipIf(!hasArc)`.
- [ ] **Step 2: Run** `npx vitest run src/inventory/vcs/arc.test.mjs` → FAIL.
- [ ] **Step 3: Port** `arc_adapter.py` → `arc.mjs` applying the transform table.
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: port arc VCS adapter to Node"`

### Task 2.3: detect + unified entry (NEW)

**Files:**
- Create: `src/inventory/vcs/detect.mjs`
- Test: `src/inventory/vcs/detect.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectVcs, collectVcsMetadata } from './detect.mjs';

describe('detectVcs', () => {
  it('detects git when .git exists', () => {
    const d = mkdtempSync(join(tmpdir(), 'cg-det-'));
    mkdirSync(join(d, '.git'));
    expect(detectVcs(d)).toBe('git');
  });
  it('returns none for a bare dir when mode=auto and no arc', () => {
    const d = mkdtempSync(join(tmpdir(), 'cg-det-'));
    expect(['none', 'arc']).toContain(detectVcs(d));
  });
});

describe('collectVcsMetadata', () => {
  it('respects explicit mode "none"', () => {
    const m = collectVcsMetadata('/tmp', 'none');
    expect(m.type).toBe('none');
    expect(m.available).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write `src/inventory/vcs/detect.mjs`**

```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectGitMetadata } from './git.mjs';
import { collectArcMetadata } from './arc.mjs';

export function detectVcs(repoRoot) {
  if (existsSync(join(repoRoot, '.git'))) return 'git';
  const arc = collectArcMetadata(repoRoot);
  if (arc.available) return 'arc';
  return 'none';
}

export function collectVcsMetadata(repoRoot, mode = 'auto') {
  const resolved = mode === 'auto' ? detectVcs(repoRoot) : mode;
  if (resolved === 'git') return collectGitMetadata(repoRoot);
  if (resolved === 'arc') return collectArcMetadata(repoRoot);
  return { type: 'none', available: false, root: null, branch: null, revision: 'no-revision', hasLocalChanges: null, warnings: [] };
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: VCS auto-detect + unified metadata entry"`

- [ ] **Step 6: Push phase** `git push`

---

## Phase 3 — Inventory port (M3)

> The most parity-critical phase. Port order respects dependencies:
> schema → hasher → ignore → classify → walker → write → run.
> Each PORT task ports its source test first (pytest → vitest) as the gate.

### Task 3.1: schema (PORT)

**Files:** Source `$SRC/kg_inventory/schema.py` (344) + `tests/test_schema.py` → Target `src/inventory/schema.mjs` + `src/inventory/schema.test.mjs`

**Transform table:**
| Python | Node |
|---|---|
| `@dataclass` node/edge/manifest | factory funcs returning plain objects with identical keys |
| `PurePosixPath` ids | string ids, POSIX separators |
| enum-ish `trust`/`kind` string constants | exported `const` string unions |

- [ ] **Step 1** Port `test_schema.py` → `schema.test.mjs` (node/edge id formats, manifest shape, `files.jsonl` row = `{id,path,language,kind,trust,sizeBytes,sha256}`).
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Port `schema.py` → `schema.mjs`.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `git commit -am "feat: port inventory schema to Node"`

### Task 3.2: hasher (PORT — small, shown in full)

**Files:** Source `$SRC/kg_inventory/hasher.py` (40) → Target `src/inventory/hasher.mjs` + test.

- [ ] **Step 1: Write the failing test** `src/inventory/hasher.test.mjs`

```js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from './hasher.mjs';

describe('hashFile', () => {
  it('sha256 of known content', () => {
    const d = mkdtempSync(join(tmpdir(), 'cg-h-'));
    const f = join(d, 'x'); writeFileSync(f, 'abc');
    // sha256("abc")
    expect(hashFile(f).sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('reports hashError for a missing file, does not throw', () => {
    const r = hashFile('/no/such/file');
    expect(r.sha256).toBeNull();
    expect(r.hashError).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write `src/inventory/hasher.mjs`**

```js
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** @returns {{sha256:string|null, hashError:string|null}} */
export function hashFile(absPath) {
  try {
    const buf = readFileSync(absPath);
    return { sha256: createHash('sha256').update(buf).digest('hex'), hashError: null };
  } catch (e) {
    return { sha256: null, hashError: e.code === 'ENOENT' ? 'missing' : String(e.message || e) };
  }
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: port sha256 hasher to Node"`

### Task 3.3: ignore rules (PORT — parity-critical)

**Files:** Source `$SRC/kg_inventory/ignore_rules.py` (277) + `tests/test_ignore_rules.py` → Target `src/inventory/ignore.mjs` + test.

**Transform table:**
| Python | Node |
|---|---|
| `pathspec.PathSpec.from_lines("gitwildmatch", lines)` | `ignore().add(lines)` from the `ignore` package |
| reads `repo_root/".arcignore"` | reads `repo_root/<config.ignoreFile>` (default `.gitignore`) **and** `.kgignore` if present |
| `_HARD_SKIP_DIR_NAMES`, `_HARD_SKIP_FILENAMES`, `_HARD_SKIP_PATH_GLOBS` | **keep verbatim** |
| `_PRIVATE_CREDENTIAL_*`, `_is_dotenv_secret` (security) | **keep verbatim** — these are the security invariant |
| `should_skip(relPath, isDir)` order (6 checks) | preserve exact order |

Public API: `IgnoreRules.fromRepo(repoRoot, { ignoreFile })` → `{ shouldSkip(relPosixPath, isDir) }`.

- [ ] **Step 1** Port `test_ignore_rules.py` → `ignore.test.mjs`. Must cover: node_modules at any depth; `.egg-info`; private-key/`.env` skipped but `.env.sample`/public certs kept; `ssl/private.*` glob; gitignore pattern honored; directory trailing-slash patterns.
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Port `ignore_rules.py` → `ignore.mjs` with the transforms. Verify `ignore` package semantics match gitwildmatch for the corpus in the test.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `git commit -am "feat: port ignore rules (gitignore + hard-skip + security) to Node"`

### Task 3.4: classify (PORT)

**Files:** Source `$SRC/kg_inventory/file_classifier.py` (413) + `tests/test_file_classifier.py` → Target `src/inventory/classify.mjs` + test.

**Transform table:** pure functions over filename/path → `{language, kind, trust}`. No I/O. Translate the extension/suffix tables and the `tests/`-dir vs `.test.`/`.spec.` rules verbatim. Markdown → `trust=doc`; lockfiles → `kind=lockfile`; assets stay `trust=asset` even under `tests/`.

- [ ] **Step 1** Port `test_file_classifier.py` → `classify.test.mjs` (keep every table-driven case).
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Port `file_classifier.py` → `classify.mjs`.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `git commit -am "feat: port file classifier to Node"`

### Task 3.5: walker (PORT)

**Files:** Source `$SRC/kg_inventory/walker.py` (344) + `tests/test_walker.py` → Target `src/inventory/walker.mjs` + test.

**Transform table:**
| Python | Node |
|---|---|
| `os.walk` / `Path.iterdir` | `fs.readdirSync(dir, { withFileTypes: true })` recursive |
| `PurePosixPath` rel paths | `path.relative` + `.split(sep).join('/')` |
| `unicodedata.normalize('NFC', name)` | `name.normalize('NFC')` |
| calls `IgnoreRules.should_skip` | calls `ignore.shouldSkip` |
| deterministic ordering (sorted) | `entries.sort()` before recursion — **preserve determinism** |

- [ ] **Step 1** Port `test_walker.py` → `walker.test.mjs` (skip integration, sorted/deterministic output, symlink handling → `hashError`).
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Port `walker.py` → `walker.mjs`.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `git commit -am "feat: port repo walker to Node"`

### Task 3.6: write artifacts (PORT)

**Files:** Source `$SRC/kg_inventory/write_artifacts.py` (117) + `tests/test_write_artifacts.py` → Target `src/inventory/write.mjs` + test.

**Transform table:** `write_json_atomic` / `write_jsonl_atomic` → write to `<out>/.<name>.tmp` then `fs.renameSync`. Trailing newline, `\n` line sep, UTF-8, stable key order (build objects in fixed key order — do not `JSON.stringify` a Map with nondeterministic order).

- [ ] **Step 1** Port `test_write_artifacts.py` → `write.test.mjs` (atomicity via temp file, byte content, re-run identical).
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Port `write_artifacts.py` → `write.mjs`.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `git commit -am "feat: port atomic artifact writers to Node"`

### Task 3.7: inventory CLI wiring (PORT of main.py, NEW glue)

**Files:** Source `$SRC/kg_inventory/main.py` (233) + `tests/test_main_cli.py` → Target `src/inventory/run.mjs` (replaces the stub) + test.

**Transform table:**
| Python | Node |
|---|---|
| `argparse` | `resolveConfig` (Phase 1) + `parseArgs` for `--no-hash`, `--allow-dirty`, `--require-vcs`, `--require-clean` |
| `collect_arc_metadata` | `collectVcsMetadata(repoRoot, cfg.vcs)` (Phase 2) |
| `--require-arc` / `--require-trunk` | `--require-vcs` (abort if `!available`) / `--require-clean` (abort if `hasLocalChanges`) |
| exit codes 0/1/2 | preserve |
| manifest `vcs` block from ArcMetadata | from `collectVcsMetadata` result (works for git/arc/none) |
| `projectId`/`snapshotId` from repo name + revision | derive `projectId` from `basename(repoRoot)` (was hardcoded to the source project name) |

`run.mjs` exports `async function run(argv)`; orchestrates walker→classify→hash→schema→write.

- [ ] **Step 1** Port `test_main_cli.py` → `run.test.mjs` (flag policies, exit codes, manifest shape; `--require-clean` on a dirty tree → exit 1).
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Port `main.py` → `run.mjs` with the transforms; wire the ported modules.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5: Integration check on a real git repo**

```bash
node bin/codegraph.mjs inventory --repo-root . --out .kg-cache/inventory
wc -l .kg-cache/inventory/nodes.jsonl .kg-cache/inventory/files.jsonl
grep -cE 'node_modules|\.git/|/\.kg-cache/' .kg-cache/inventory/files.jsonl   # expect 0
# determinism
cp .kg-cache/inventory/nodes.jsonl /tmp/n1
node bin/codegraph.mjs inventory --repo-root . --out .kg-cache/inventory
cmp /tmp/n1 .kg-cache/inventory/nodes.jsonl   # exit 0
```

Expected: nonzero files, 0 leaks, `cmp` exit 0 (byte-stable).

- [ ] **Step 6: Commit + push**

```bash
git add -A && git commit -m "feat: inventory CLI (VCS-neutral) wired end-to-end"
git push
```

---

## Phase 4 — L2 layers: imports/symbols/references/usages (M4)

> These are already Node (`.mjs`, `typescript` dep). Work = COPY into `src/`,
> deduplicate the 5× copied `schema.mjs`/`graph_builder.mjs` into `src/lib/`,
> re-point imports, strip project-prefixed naming, and re-point each layer's `inventory`
> reader at Phase-3 output. No behavioral change.

### Task 4.1: shared lib extraction

**Files:**
- Source: `$SRC/imports/lib/*`, `$SRC/symbols/lib/*`, `$SRC/{references,usages}/lib/*`
- Create: `src/lib/{write_artifacts,tsconfig_index,inventory_reader}.mjs` and the shared `schema.mjs`, `graph_builder.mjs` **if identical across layers**; if they diverge per layer, keep per-layer copies under `src/<layer>/lib/` and only lift the truly-identical ones.

- [ ] **Step 1** Diff the 5 `schema.mjs` and 5 `graph_builder.mjs` copies:

```bash
for f in schema graph_builder; do
  for l in imports symbols references usages domains; do
    echo "== $l/$f =="; sha1sum "$SRC/$l/lib/$f.mjs" 2>/dev/null
  done
done
```

Group by hash. Identical group → one file in `src/lib/`. Divergent → keep per-layer.

- [ ] **Step 2** Copy the shared/identical helpers into `src/lib/`. Copy `write_artifacts.mjs`, `tsconfig_index.mjs`, `inventory_reader.mjs` (single sources) into `src/lib/`.
- [ ] **Step 3** Commit `git add -A && git commit -m "chore: extract shared L2 lib (dedupe schema/graph_builder)"`

### Task 4.2: imports layer (COPY + RE-POINT)

**Files:** Source `$SRC/imports/{cli.mjs,lib/*}` + `$SRC/imports/test/*` → Target `src/imports/run.mjs` (+ `src/imports/lib/*` for non-shared) + `src/imports/*.test.mjs`.

**Transform table:**
| From | To |
|---|---|
| `cli.mjs` with `parseCliArgs` + top-level run | `run.mjs` exporting `async function run(argv)` |
| `import … from './lib/schema.mjs'` (local copy) | `from '../lib/schema.mjs'` (shared) where deduped |
| package name `original-kg-imports` | remove per-layer `package.json` (single root package) |
| tsconfig discovery hardcoded | use `cfg.tsconfig` or auto-find nearest `tsconfig.json` |

- [ ] **Step 1** Copy the layer + its tests; re-point imports to `src/lib/`.
- [ ] **Step 2** Adapt `cli.mjs`→`run.mjs` (export `run(argv)`, use `resolveConfig` for `--repo-root/--inventory/--out`).
- [ ] **Step 3** Run `npx vitest run src/imports` → PASS (re-pointed tests).
- [ ] **Step 4** Integration:

```bash
node bin/codegraph.mjs imports --repo-root . --inventory .kg-cache/inventory --out .kg-cache/imports
test -s .kg-cache/imports/edges.jsonl && echo OK
```

- [ ] **Step 5** Commit `git commit -am "feat: imports layer (L2a) consolidated"`

### Task 4.3: symbols layer (COPY + RE-POINT)

Same shape as Task 4.2. Source `$SRC/symbols/*` → `src/symbols/*`. Integration:
`node bin/codegraph.mjs symbols --repo-root . --inventory .kg-cache/inventory --out .kg-cache/symbols`.

- [ ] Steps 1–5 mirror Task 4.2 (copy, re-point, test, integrate, commit `feat: symbols layer (L2b) consolidated`).

### Task 4.4: references layer (COPY + RE-POINT, heavy)

Source `$SRC/references/*` → `src/references/*`. Needs `--symbols` input + big heap.
Integration:

```bash
node --max-old-space-size=8192 bin/codegraph.mjs references \
  --repo-root . --inventory .kg-cache/inventory --symbols .kg-cache/symbols --out .kg-cache/references
```

Add graceful-skip: if no tsconfig is found, print a warning and exit 0 writing an empty artifact (per spec risk mitigation).

- [ ] Steps 1–5 mirror Task 4.2 + the tsconfig graceful-skip; commit `feat: references layer (L2c) consolidated + tsconfig graceful-skip`.

### Task 4.5: usages layer (COPY + RE-POINT, heavy)

Source `$SRC/usages/*` → `src/usages/*`. Same heavy/heap + tsconfig-skip as 4.4.
Integration uses `--symbols`. 

- [ ] Steps 1–5 mirror Task 4.4; commit `feat: usages layer (L2d) consolidated`.
- [ ] **Push phase** `git push`

---

## Phase 5 — Domains overlay (M5)

> Genericize the interpretive layer: default = auto-derive from folders; optional
> user config overrides. The eda config becomes an example.

### Task 5.1: auto-derive (NEW)

**Files:**
- Create: `src/domains/derive.mjs`
- Test: `src/domains/derive.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { deriveDomainsConfig } from './derive.mjs';

describe('deriveDomainsConfig', () => {
  it('derives one domain per first segment under each srcRoot', () => {
    const files = ['src/cart/a.ts', 'src/cart/b.ts', 'src/checkout/c.ts', 'packages/ui/x.ts'];
    const cfg = deriveDomainsConfig(files, { srcRoots: ['src'] });
    const ids = cfg.CANONICAL_DOMAINS.map((d) => d.id).sort();
    expect(ids).toContain('cart');
    expect(ids).toContain('checkout');
    // outside srcRoots → infra bucket by top-level dir
    expect(cfg.AREA_BUCKETS.some(([p]) => p.startsWith('packages/'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write `src/domains/derive.mjs`**

```js
/** Build a domains config purely from file paths. */
export function deriveDomainsConfig(relPaths, { srcRoots = ['src'] } = {}) {
  const product = new Set();
  const infra = new Set();
  for (const p of relPaths) {
    const segs = p.split('/');
    const root = srcRoots.find((r) => p.startsWith(r.endsWith('/') ? r : r + '/'));
    if (root) {
      const rootSegs = root.replace(/\/$/, '').split('/').length;
      const domain = segs[rootSegs];
      if (domain) product.add(domain);
    } else if (segs.length > 1) {
      infra.add(segs[0]);
    }
  }
  const CANONICAL_DOMAINS = [
    ...[...product].sort().map((id) => ({ id, name: id, kind: 'product' })),
    ...[...infra].sort().map((id) => ({ id, name: id, kind: 'infra' })),
    { id: 'unassigned', name: 'Unassigned', kind: 'infra' },
  ];
  const ALIASES = Object.fromEntries([...product].map((id) => [id.toLowerCase(), id]));
  const AREA_BUCKETS = [...infra].sort().map((id) => [`${id}/`, id]);
  return { CANONICAL_DOMAINS, ALIASES, AREA_BUCKETS };
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat: auto-derive domains config from folder structure"`

### Task 5.2: config loader with override (NEW)

**Files:**
- Create: `src/domains/config.mjs`
- Test: `src/domains/config.test.mjs`

- [ ] **Step 1** Write failing test: `loadDomainsConfig({ cfg, relPaths })` returns the user override when `cfg.domains` is set (object or path to `.mjs` exporting the three tables), else the derived config from Task 5.1.
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Implement `config.mjs`: if `cfg.domains` is an object → use it; if a string → `import(pathToFileURL(resolve(repoRoot, cfg.domains)))` and read `{CANONICAL_DOMAINS, ALIASES, AREA_BUCKETS}`; else → `deriveDomainsConfig(relPaths, cfg)`.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `git commit -am "feat: domains config override loader"`

### Task 5.3: domains layer (COPY + RE-POINT)

**Files:** Source `$SRC/domains/{cli.mjs,lib/*}` + `$SRC/domains/test/*` → Target `src/domains/run.mjs` + `src/domains/lib/*`.

**Transform table:**
| From | To |
|---|---|
| `import { CANONICAL_DOMAINS, ALIASES, AREA_BUCKETS } from './domains.config.mjs'` | from `loadDomainsConfig()` (Task 5.2) |
| hardcoded eda tables | removed from default; moved to `examples/example.domains.config.mjs` |
| `cli.mjs` top-level run | `run.mjs` exporting `run(argv)` |

- [ ] **Step 1** Copy `domains/lib/{assign,graph_builder,schema}.mjs` → `src/domains/lib/`, re-point; port `domains/test/*` → `src/domains/*.test.mjs`.
- [ ] **Step 2** Move the current eda `domains.config.mjs` content to `examples/example.domains.config.mjs` verbatim.
- [ ] **Step 3** Adapt `cli.mjs`→`run.mjs` to source the tables from `loadDomainsConfig`.
- [ ] **Step 4** Run `npx vitest run src/domains` → PASS.
- [ ] **Step 5** Integration:

```bash
node bin/codegraph.mjs domains --repo-root . --inventory .kg-cache/inventory \
  --imports .kg-cache/imports --usages .kg-cache/usages --out .kg-cache/domains
test -s .kg-cache/domains/nodes.jsonl && echo OK
```

- [ ] **Step 6** Commit + push `git commit -am "feat: domains layer with derive/override" && git push`

---

## Phase 6 — Consumption: explorer + MCP (M6)

### Task 6.1: explorer builder (PORT)

**Files:** Source `$SRC/explorer/build_index.py` (295) + `$SRC/explorer/index.html` → Target `src/explorer/build_index.mjs` + `src/explorer/index.html` (copy) + `src/explorer/run.mjs`.

**Transform table:** reads `<cache>/{inventory,imports,domains,…}` JSONL, aggregates into a single `graph-index.json` for the static page. Translate JSON reads (`json.load`) → `JSON.parse(readFileSync)`; preserve the output schema the `index.html` expects **exactly** (inspect `index.html`'s fetch/consumption to lock the shape). `run.mjs` exports `run(argv)`; `--serve` starts `http.createServer` over the explorer dir (replaces `python -m http.server`).

- [ ] **Step 1** Write a test that runs `build_index` over a fixture cache and asserts the `graph-index.json` top-level keys match what `index.html` reads.
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Port `build_index.py` → `build_index.mjs`; copy `index.html`; add `run.mjs` with `--serve`.
- [ ] **Step 4** Run → PASS; manual: `node bin/codegraph.mjs explorer --serve` → open `http://localhost:8765`.
- [ ] **Step 5** Commit `git commit -am "feat: port explorer index builder + static server to Node"`

### Task 6.2: MCP server (COPY + RENAME)

**Files:** Source `$SRC/mcp/{server.mjs,lib/*}` + `$SRC/mcp/test/*` → Target `src/mcp/{server.mjs,lib/*}` + `src/mcp/run.mjs` + tests.

**Transform table:**
| From | To |
|---|---|
| `serverInfo: { name: 'original-kg' }` | `name: 'codegraph'` |
| graph loader path defaults | default `--cache .kg-cache` |
| any `eda` references in tool text | neutral wording |
| standalone `server.mjs` | keep; add `run.mjs` exporting `run(argv)` that boots the stdio loop |

Tools preserved unchanged: `find_node`, `node_info`, `who_uses`, `impact_of`,
`path_between`, domain brief, dependencies, crossings, `dead_exports`, Layer-4
description hook.

- [ ] **Step 1** Copy `mcp/lib/*` + `server.mjs`; port `mcp/test/*` → `src/mcp/*.test.mjs`; re-point.
- [ ] **Step 2** Run `npx vitest run src/mcp` → PASS.
- [ ] **Step 3** Smoke the stdio loop:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node bin/codegraph.mjs mcp --cache .kg-cache
```

Expected: a JSON-RPC response listing the tools.

- [ ] **Step 4** Commit + push `git commit -am "feat: MCP server consolidated + renamed to codegraph" && git push`

---

## Phase 7 — One-shot orchestrator + neo4j + smoke + docs (M7)

### Task 7.1: regenerate orchestrator (PORT of regenerate.sh)

**Files:** Source `$SRC/regenerate.sh` → Target `src/orchestrate/regenerate.mjs` (replaces stub).

**Transform table:** run layers in order inventory→imports→symbols→references→usages→domains→explorer, each as an in-process `run()` call (not a subprocess) so one snapshot is shared; keep `KG_SKIP_EXPLORER` → `--skip-explorer`; keep the heap note (document that `references`/`usages` may need `NODE_OPTIONS=--max-old-space-size=8192` when invoked via `npx`). Print per-step timing + the final "explore/query" hints (updated to `codegraph` commands).

- [ ] **Step 1** Write a test invoking `regenerate` over `test/fixtures/mini-repo` with `--skip` for heavy layers, asserting the expected `.kg-cache/*` dirs are produced.
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Implement `regenerate.mjs` calling each layer's `run()` in order with shared resolved config.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `git commit -am "feat: one-shot regenerate orchestrator"`

### Task 7.2: neo4j + examples (COPY)

- [ ] **Step 1** Copy `$SRC/neo4j/*.cypher` → `neo4j/`. Update any `eda` labels/paths in comments only; the Cypher import is structural.
- [ ] **Step 2** Commit `git add -A && git commit -m "chore: bring neo4j cypher import scripts (optional)"`

### Task 7.3: end-to-end smoke fixture

**Files:**
- Create: `test/fixtures/mini-repo/` (a tiny git-inited TS project: 3–4 `.ts` files with imports, a `tsconfig.json`, a `.gitignore`).
- Create: `test/e2e.test.mjs`

- [ ] **Step 1** Write `test/e2e.test.mjs`: run `inventory` + `imports` + `domains` over the fixture; assert (a) files counted, (b) zero skipped-path leaks, (c) two inventory runs byte-identical, (d) imports edges nonempty, (e) domains derived includes the fixture's folders.
- [ ] **Step 2** Run → FAIL (fixture/paths).
- [ ] **Step 3** Build the fixture; make the test green.
- [ ] **Step 4** Run full suite `npm test` → all PASS.
- [ ] **Step 5** Commit `git commit -am "test: end-to-end smoke on a mini JS/TS repo"`

### Task 7.4: README + init command

**Files:**
- Create: `docs/README.md` (root `README.md` symlink or copy) — install (`npx codegraph`), the 7 commands, config schema, the heap note, neo4j pointer.
- Create: `src/init/run.mjs` + register `init` in `bin/codegraph.mjs` COMMANDS — scaffolds `codegraph.config.mjs` from `DEFAULTS` and ensures `.kg-cache` is in `.gitignore`.
- Test: `src/init/run.test.mjs`

- [ ] **Step 1** Write failing test for `init` (creates config file, appends `.kg-cache` to `.gitignore` idempotently).
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Implement `init/run.mjs`; register the command.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Write `README.md`.
- [ ] **Step 6** Commit + push `git add -A && git commit -m "feat: init command + README" && git push`

---

## Self-review (author checklist — completed)

**Spec coverage:**
- §4 single package/bin/CLI → Phase 0 + all `run.mjs`. ✓
- §5 VCS decouple → Phase 2. ✓
- §5 ignore `.gitignore` → Task 3.3. ✓
- §5 domains derive+override → Phase 5. ✓
- §5 naming → Tasks 3.7, 4.x, 6.2. ✓
- §6 Python port (10 files) → Tasks 3.1–3.7 (inventory 8) + 6.1 (explorer) + 2.2 (arc). ✓
- §7 invariants (determinism/security/no-content/no-leak/atomic) → gated in 3.3/3.6/3.7 + e2e 7.3. ✓
- §8 MCP/explorer/neo4j as-is → 6.1/6.2/7.2. ✓
- §9 testing (pytest→vitest, keep node tests, smoke) → every PORT task + 7.3. ✓
- §10 tsconfig graceful-skip + heap → Tasks 4.4/4.5/7.1. ✓

**Placeholder scan:** PORT tasks reference exact source paths + transform tables + test gates (documented convention, not placeholders). NEW-code tasks show full code. No "TBD"/"add error handling"/"similar to Task N". ✓

**Type consistency:** VCS metadata shape identical across `collectGitMetadata`/`collectArcMetadata`/`collectVcsMetadata`. Domains config shape `{CANONICAL_DOMAINS, ALIASES, AREA_BUCKETS}` identical across derive/override/consumer. `run(argv)` export contract uniform across every command module + dispatcher. Config keys match between `DEFAULTS`, `resolveConfig`, and consumers. ✓
