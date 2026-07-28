# codegraph — standalone knowledge-graph package

**Status:** design approved, pending spec review
**Date:** 2026-07-26
**Author:** vzheltko

## 1. Goal

Extract the layered knowledge-graph pipeline currently built inside the
an internal JS/TS monorepo (branch `<kg-branch>`) into a single,
self-contained npm package named **codegraph** that any JavaScript/TypeScript
project can adopt out of the box with zero configuration:

```sh
npx codegraph regenerate      # build the whole graph
npx codegraph mcp             # query it from an agent over stdio MCP
```

The *building principle* — a snapshot-consistent, deterministic, layered graph
emitted as JSONL artifacts — is preserved verbatim. Everything tied to the vendor
infrastructure (the `arc` VCS, `.arcignore`, the project-specific domain taxonomy, the
project-prefixed naming) is removed or made pluggable.

## 2. Scope

**In scope (v1):**

- Any JS/TS repository as the target. The heavy layers rely on the TypeScript
  compiler API and are inherently JS/TS-bound; the inventory layer is
  language-agnostic and continues to catalog every file.
- Single npm package, single `bin` (`codegraph`), ESM `.mjs` runtime, no build
  step. `npx` runs `node` directly.
- Port the two Python components (inventory + explorer index builder) to Node so
  the package has one runtime.
- Git as the default VCS metadata source; `arc` kept as an optional adapter.
- Config-driven domain overlay with a zero-config default derived from folder
  structure.

**Out of scope (v1, tracked as follow-ups):**

- Non-JS/TS languages for the symbol/import/reference/usage layers.
- Full TypeScript source migration with a build step (kept as `.mjs` + JSDoc for
  now; a `.d.ts` for the public surface is provided).
- Publishing/registry mechanics (name is reserved; publish flow decided later).

## 3. Source system (what we are extracting)

Measured facts from the source branch (read from code, not docs):

- **Architecture:** a layered, snapshot-consistent pipeline. Every layer runs on
  one working-tree snapshot so the artifacts are mutually consistent. Output is
  JSONL under `.kg-cache/` (git/arc-ignored), byte-stable across repeated runs on
  the same revision, written atomically (temp file + rename).
- **Layers:**
  - **L1 inventory** — Python. Walks the repo, classifies files, SHA-256 hashes,
    emits `manifest.json`, `nodes.jsonl`, `edges.jsonl`, `files.jsonl`.
    Language-agnostic.
  - **L2a imports / L2b symbols / L2c references / L2d usages** — Node, built on
    the TypeScript compiler API (`typescript` dependency, tsconfig-driven).
    JS/TS only. `references` and `usages` type-check the whole repo and need a
    large Node heap (`--max-old-space-size`).
  - **L3 domains** — Node. A *semantic overlay*: assigns files to product/infra
    domains. Explicitly the "one interpretive knob," driven by a single config
    file; nothing hardcodes a domain elsewhere.
  - **Consumption:** `explorer/` (static HTML graph index built by a Python
    script), `mcp/server.mjs` (stdio MCP server exposing navigation tools),
    `neo4j/` (optional Cypher import).
- **Orchestration:** `regenerate.sh` runs all layers in dependency order on the
  current working tree.
- **Size:** Python 2201 LOC / 10 files; Node ~6000 LOC across the layers + MCP.

### Vendor/project couplings (the only things to remove)

The couplings are narrow and already isolated — the bulk of the system is
project-agnostic:

1. **VCS** — `kg_inventory/arc_adapter.py` collects branch/revision/dirty state
   via the `arc` CLI. One file, ~140 LOC, never raises (graceful degrade). Only
   metadata; the graph does not depend on it.
2. **Ignore rules** — `kg_inventory/ignore_rules.py` reads `.arcignore`
   specifically. The rest is a generic `gitwildmatch` PathSpec plus a hard-skip
   list (already generic: `node_modules`, `dist`, `.venv`, …) and security rules
   that skip private-key / credential / dotenv files.
3. **Domains** — `domains/domains.config.mjs` hardcodes the project domain taxonomy
   (project-specific product domains) and `AREA_BUCKETS` keyed on `src/...`
   path prefixes.
4. **Naming** — the project-prefixed package names, `_PROJECT_NAME =
   the source project name`, MCP server name the original MCP server name, README copy.

### Duplication to fix during consolidation

Each Node layer currently ships as its own package with copied helpers:
`schema.mjs` appears 5×, `graph_builder.mjs` 5×. Merging into one package
deduplicates these into a shared `src/lib/`.

## 4. Target architecture

Single package, one `bin`, subcommand CLI.

```
codegraph/
  package.json                # bin: { codegraph }, deps: typescript, ignore
  bin/codegraph.mjs           # subcommand dispatcher
  src/
    inventory/                # PORTED from Python
      walker.mjs  hasher.mjs  classify.mjs  ignore.mjs  schema.mjs  write.mjs
      vcs/
        detect.mjs            # NEW: auto-detect git | arc | none
        git.mjs               # NEW: default adapter
        arc.mjs               # optional adapter (kept from source)
    imports/  symbols/  references/  usages/  domains/   # existing Node layers
    lib/                      # shared: schema, graph_builder, write_artifacts,
                              # tsconfig_index, inventory_reader
    explorer/                 # PORTED build_index + static index.html
    mcp/                      # server + tools (as-is)
    config/                   # config loader + defaults
  neo4j/                      # Cypher import scripts (as-is, optional)
  examples/
    example.domains.config.mjs    # the sample config, kept as a sample
  test/                       # vitest (ported pytest + existing node tests)
  docs/
```

### CLI surface (`bin: codegraph`)

| Command | Purpose |
|---|---|
| `codegraph regenerate` | Run the full pipeline in dependency order (replaces `regenerate.sh`). |
| `codegraph inventory` | L1 only. |
| `codegraph imports \| symbols \| references \| usages` | Individual L2 layers. |
| `codegraph domains` | L3 overlay. |
| `codegraph explorer [--serve]` | Build (and optionally serve) the browser index. |
| `codegraph mcp` | Start the stdio MCP server. |
| `codegraph init` | Scaffold `codegraph.config.mjs`, add `.kg-cache` to the ignore file. |

Global flags: `--config`, `--repo-root`, `--out` (default `.kg-cache`). Every
flag has a working default so `npx codegraph regenerate` runs with no config.

### Config file (`codegraph.config.mjs`, all optional)

```js
export default {
  srcRoots: ['src'],          // where product code lives (drives domain auto-derivation)
  ignoreFile: '.gitignore',   // ignore source; '.kgignore' also read if present
  tsconfig: 'tsconfig.json',  // auto-discovered if omitted
  vcs: 'auto',                // 'git' | 'arc' | 'none' | 'auto'
  outDir: '.kg-cache',
  domains: undefined,         // optional override; see §6
};
```

## 5. Decoupling from the vendor

- **VCS.** Replace the arc-only adapter with a `vcs/` module exposing
  `collectVcsMetadata(repoRoot) -> { type, available, root, branch, revision,
  hasLocalChanges }`. Ship a **git** adapter as default and keep the **arc**
  adapter as optional. `detect.mjs` picks by presence (`.git` → git, else try
  `arc`, else `none`). Metadata stays optional and degrades silently, exactly as
  today. The `--require-arc` / `--require-trunk` policy flags become
  `--require-vcs` / `--require-clean`, VCS-neutral.
- **Ignore.** Default ignore source is `.gitignore` (plus an optional `.kgignore`
  for tool-specific excludes). The hard-skip list and the security
  credential/dotenv skip rules are **kept unchanged** — they are generic and
  valuable. `pathspec` is replaced by the npm `ignore` package (gitignore
  semantics); parity is guarded by the ported tests.
- **Domains.** Remove the project domain taxonomy from the default. Default behavior:
  **auto-derive domains from folder structure** — the first path segment under
  each `srcRoots` entry becomes a domain id, with an `infra`/`unassigned`
  fallback. A project may supply a `domains` config (or a
  `codegraph.domains.config.mjs`) to override with an explicit
  `CANONICAL_DOMAINS` / `ALIASES` / `AREA_BUCKETS` set. The current eda config
  moves to `examples/example.domains.config.mjs` as a worked example.
- **Naming.** `codegraph` throughout; MCP server identifies as `codegraph`.

## 6. Python → Node port

The primary new work. Strategy: **faithful behavioral port**, not a rewrite —
the inventory layer encodes subtle invariants (byte-stable determinism, the
security skip rules) that must be preserved exactly.

| Python | Node | Notes |
|---|---|---|
| `walker.py` (344) | `inventory/walker.mjs` | Directory walk + skip integration. |
| `file_classifier.py` (413) | `inventory/classify.mjs` | language/kind/trust classification. |
| `ignore_rules.py` (277) | `inventory/ignore.mjs` | `pathspec` → `ignore`; keep hard-skip + security rules. |
| `schema.py` (344) | `inventory/schema.mjs` | node/edge/manifest shapes. |
| `write_artifacts.py` (117) | `inventory/write.mjs` | atomic temp+rename JSONL/JSON. |
| `hasher.py` (40) | `inventory/hasher.mjs` | `hashlib.sha256` → `node:crypto`. |
| `arc_adapter.py` (137) | `inventory/vcs/arc.mjs` | `subprocess` → `node:child_process`. |
| `main.py` (233) | folded into `bin/codegraph.mjs` + `inventory/` | CLI + policy. |
| `explorer/build_index.py` (295) | `explorer/build_index.mjs` | static index builder. |

Dependency mapping: `pathspec` → `ignore`; `hashlib` → `node:crypto`;
`subprocess` → `node:child_process`; `unicodedata` NFC → `String.prototype.normalize('NFC')`;
atomic write → `fs` temp file + `rename`. No other third-party Python deps.

The pytest suite (`tests/test_*.py`) is ported to vitest so behavioral parity is
verifiable, with special attention to: determinism (two runs byte-identical on
one revision), the credential/dotenv skip set, and classification edge cases
(assets under `tests/`, lockfiles, markdown as `trust=doc`).

## 7. Preserved invariants

These are treated as acceptance criteria for the port:

- **Determinism** — `nodes.jsonl`, `edges.jsonl`, `files.jsonl` are byte-stable
  across repeated runs on the same revision; no wall-clock value in any node or
  edge (only `manifest.json.generatedAt`).
- **No content stored** — artifacts hold metadata and graph edges only, never raw
  source content.
- **Security** — private-key / keystore / SSH-key / `.npmrc` / `.netrc` / dotenv
  files are never read or hashed. Public certs and `.env.sample` stay indexed.
- **No skipped paths leak** — `node_modules`, `.kg-cache`, `.venv`,
  `__pycache__`, `*.egg-info`, build/dist/coverage dirs produce zero rows.
- **Atomic writes** — every artifact is written to a temp file and renamed.

## 8. Consumption layers (kept as-is, de-named)

- **MCP server** — `mcp/server.mjs` + `mcp/lib/*`: stdio JSON-RPC loop, in-memory
  graph loader over `.kg-cache`, and the tool set (`find_node`, `node_info`,
  `who_uses`, `impact_of`, `path_between`, domain brief, dependencies, crossings,
  `dead_exports`, optional Layer-4 description hook). Only the server name and any
  eda references change.
- **Explorer** — ported index builder + the existing static `index.html`.
- **Neo4j** — Cypher constraints + import scripts move over unchanged; optional.

## 9. Testing strategy

- Port pytest → vitest for the inventory layer (parity-critical).
- Keep the existing Node layer tests (`*/test/`), re-pointed at the shared
  `src/lib/`.
- Add a smoke test: `codegraph regenerate` on a small fixture repo produces the
  expected artifact counts and passes the determinism + no-leak checks.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `references`/`usages` need a valid tsconfig + large heap; a target repo may lack tsconfig. | Auto-discover `tsconfig.json`; if absent, skip the heavy layers with a clear warning rather than failing. Document the heap flag. |
| `pathspec` ↔ `ignore` semantic drift. | Port the ignore tests; assert parity on the eda `.gitignore` corpus. |
| Determinism/security regressions in the port. | Ported tests are acceptance gates; byte-compare fixture output. |
| Domain auto-derivation produces noisy domains on unfamiliar repos. | Ship the auto-derive default plus documented config override; `examples/` shows a curated config. |

## 11. Follow-ups (not v1)

- Full TypeScript migration with a build step and first-class `.d.ts`.
- Additional language front-ends for the symbol/import layers.
- `codegraph publish` / registry story.
