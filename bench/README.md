# Token benchmark

loregraph's pitch is that an agent answering a question from the graph reads far
less than an agent answering it from the source files. That is a claim about
numbers, and a claim about numbers should be checkable by a stranger rather than
taken on trust. This directory is the check.

```bash
npm run bench           # against loregraph itself
node bench/run.mjs --repo-root /path/to/repo --questions ./my-questions.mjs
```

It prints a table, writes [`results.json`](./results.json), and needs no network,
no API key and no model.

## What it measures

For each question in [`questions.mjs`](./questions.mjs) there are two paths.

**Graph path — a real measurement.** The corresponding `loregraph` command runs
as a real subprocess against a freshly built graph, and its stdout is counted
with a real tokenizer. For the MCP question the real stdio server is started and
a real `tools/call` is sent; only the tool result text is counted, since the
JSON-RPC envelope is transport an agent never pays for.

**Baseline path — a model, not a measurement.** No agent runs. Instead
[`baseline.mjs`](./baseline.mjs) executes an explicit file-reading procedure and
counts the tokens of everything that procedure would put into a context window:
the tool output (grep hits, directory listings) plus the text of every file it
opens. Each procedure is spelled out below. **If you think one is unfair, that
is the thing to argue with** — each is a couple of dozen lines of ordinary
JavaScript, not a number handed down from somewhere.

Tokens are counted with **`gpt-tokenizer`, `o200k_base`** (the GPT-4o / GPT-5
family encoding) — a pure-JS BPE tokenizer, added as a **devDependency** so it
never ships with the package. No `bytes`, no `chars / 4`: on the files this
benchmark opens, `chars / 4` undercounts the real token count by 7–9%, which is
exactly the kind of slop a benchmark should not have.

## The build cost, stated separately

Building the graph on this repo takes **≈2 s of wall clock** — 1.92 s in the run
recorded in `results.json`, and 2.48 s / 2.76 s / 2.80 s across three standalone
`loregraph regenerate` runs measured with `time`. That is all six layers plus the
browser index.

The build costs **zero tokens**, because it is an ordinary process whose output
goes to a cache directory on disk and never enters a model's context. Zero tokens
is not the same as free: it is seconds of CPU, it has to be re-run when the code
changes, and on a large monorepo it is minutes rather than seconds. It is
reported on its own line and is deliberately **not** amortised into the
per-question numbers.

## The questions and their baseline procedures

The **file universe** for every grep and listing below is: walk the repo, honour
`.gitignore`, hard-skip `node_modules` / `.git` / build output, keep files with a
JS/TS extension (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`). That is what ripgrep
would search; it is implemented in Node so the benchmark runs anywhere.

### 1. `blast-radius` — "if I change `src/lib/graph_load.mjs`, what might break?"

- **Graph:** `loregraph impact --files src/lib/graph_load.mjs --limit 200`
- **Baseline:** grep the repo for `graph_load` restricted to lines that look like
  imports (containing `import`, `require` or `from`); the hit lines enter the
  context. Resolve the relative specifier on each hit against the importing
  file's directory, and open in full every file whose specifier really points at
  the target. Then repeat for each file just discovered, until nothing new turns
  up. A grep that has already been run is not charged a second time — its output
  is already in the context.

### 2. `symbol-usage` — "where is the exported `loadGraph` used?"

- **Graph:** `loregraph brief loadGraph --limit 200`
- **Baseline:** `grep -rl` for the symbol as a whole word; the matching file list
  enters the context, then the full text of every file that matched.

### 3. `file-orientation` — "what is `src/mcp/lib/tools.mjs` wired to?"

- **Graph:** `loregraph brief src/mcp/lib/tools.mjs --limit 200`
- **Baseline:** read the file in full, grep for its basename on import-looking
  lines, and read each direct importer in full. One level out only.

### 4. `domain-deps` — "what does the `mcp` module depend on?"

- **Graph:** `loregraph brief mcp --limit 200`
- **Baseline:** list every source file under `src/mcp/` and read all of them — a
  file's dependencies are only visible in its text.

### 5. `file-declarations` — "what does `src/mcp/lib/tools.mjs` declare?"

- **Graph:** `loregraph outline src/mcp/lib/tools.mjs --limit 200`
- **Baseline:** the path is already known, so there is nothing to search for:
  open the file and read it. One file, no grep — the cheapest baseline in the set.

### 6. `symbol-source` — "show me the implementation of `loadGraph`"

- **Graph:** `loregraph show loadGraph`
- **Baseline:** `grep -rn` for the symbol as a whole word; the hit lines enter the
  context, then the full text of the ONE file that declares it. Charitable: a real
  agent cannot tell which hit is the declaration and would often open more files.

### 7. `dead-exports` — "which exports are never used outside their own file?"

- **Graph:** MCP `tools/call dead_exports` with `limit: 200`
- **Baseline:** list every source file and read all of them. You cannot know what
  a file exports, nor whether anything uses it, without its text.

## Caveats

Read these before quoting any number from this page.

- **The baseline is a model of agent behaviour, not a measurement of an agent.**
  Nobody's context window was observed. The procedures above are plausible and
  deterministic, not authoritative.
- **`--limit 200` is used on the graph side**, which on a repo this size means "do
  not truncate". The default `--limit 10` would make the graph output smaller and
  the comparison dishonest.
- **Two rows compare different answers, and both under-charge the baseline.**
  `file-orientation`: the graph brief also carries the transitive blast radius and
  per-symbol reference counts, which one level of grep does not produce.
  `domain-deps`: reading `src/mcp/` shows what the module imports but not who
  imports it, which the graph's "depended on by" line does. In both cases the
  file-reading path would really cost more than the table says.
- **`file-declarations` is the one row where the BASELINE answers more.** The file
  text contains everything `outline` reports plus every function body. `outline`
  answers "what does this file declare" exactly — kind, name, export status, line
  range, signature, first doc line, class members — and does not answer "what does
  this code do". Reach for `show` (or the file) when the body is the point. Its
  6.9x is therefore a claim about navigation, not about understanding.
- **`symbol-source` is the strictest row in the set, and the narrowest.** Both
  sides end up with the same text for the thing asked: `show` prints the
  declaration verbatim, JSDoc included. The baseline additionally carries the rest
  of the declaring file — not asked for, but often useful next. 2.1x is what
  honest looks like when the two answers really are comparable.
- **`dead-exports` is the weakest row and it flatters the graph.** "Read all 126
  files" is what a naive agent does; a capable one writes a script instead and
  pays almost nothing (that is exactly what happened in the manual A/B below).
  Treat it as an upper bound on the naive path, not as a claim about good agents.
  The two paths also disagree on what "dead" means — loregraph counts an export
  with no cross-file `REFERENCES` edge, which misses dynamic and string-keyed
  access and any non-TS entry point.
- **The graph is not a superset of the baseline's answer.** On `blast-radius` the
  procedure opens more files than `impact` names, and the extra ones —
  `bin/loregraph.test.mjs` and `src/mcp/run.test.mjs` — are genuine dependents
  that launch the CLI as a subprocess. loregraph models `import`, not `spawn`, so
  it does not see them. That is a real limitation, not a rounding error.
- **The "skim floor" column is not a realistic way to answer anything.** It
  charges only the first 40 lines of each opened file. It is there as a hard
  lower bound: even if an agent could answer these questions from file headers
  alone, the graph would still be ~19x cheaper on this repo.
- **This repo is comment-dense.** loregraph's own source carries long explanatory
  headers, so a file costs more tokens here than in a leaner codebase. A repo with
  terser source would show smaller ratios.
- **The benchmark excludes its own `bench/` sources from the baseline's file
  universe**, so it cannot inflate itself (this very file's question set mentions
  `loadGraph`, and a naive grep would "find" it). `regenerate` still indexes
  `bench/`, so the graph's own `dead_exports` answer pays for the benchmark's
  exports. Both adjustments push against the graph.
- **Everything except the wall clock is deterministic.** Two runs on the same
  tree produce byte-identical token counts. The timestamp in `results.json` is an
  explicit input — pass `--timestamp` to reproduce a run exactly.

## Results on this repo

`node bench/run.mjs`, loregraph at 145 indexed files / 682 symbols / 202 exported
symbols; 126 JS/TS files in the grep universe. Tokenizer: `gpt-tokenizer`,
`o200k_base`. Graph build: **2.88 s wall clock, 0 tokens**, reported separately.

| question | graph tokens | baseline tokens | baseline, skim floor | files read | ratio | saved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `blast-radius` | 448 | 52747 | 14162 | 24 | 117.7x | 99.2% |
| `symbol-usage` | 308 | 25413 | 6806 | 13 | 82.5x | 98.8% |
| `file-orientation` | 450 | 11836 | 1678 | 3 | 26.3x | 96.2% |
| `domain-deps` | 183 | 15579 | 3271 | 6 | 85.1x | 98.8% |
| `file-declarations` | 900 | 6191 | 445 | 1 | 6.9x | 85.5% |
| `symbol-source` | 1131 | 2399 | 1433 | 1 | 2.1x | 52.9% |
| `dead-exports` | 1004 | 188959 | 55362 | 126 | 188.2x | 99.5% |
| **total** | **4424** | **303124** | **83157** | — | **68.5x** | **98.5%** |

Against the skim floor the total is **18.8x** (94.7% saved).

The graph won every question. The narrowest margin is `symbol-source` at 2.1x,
and that is the row to trust most: it is the only one where both sides produce
the same text for what was asked, and its baseline opens a single file.

---

## Appendix: a one-off manual A/B with real agents

**This section was not produced by `run.mjs`.** It is a separate, manual
experiment, recorded here because a live A/B answers a question the script
cannot: whether a real agent actually spends fewer tokens, rather than whether a
modelled one would.

Two AI agents were given the same three questions about a 217-file demo project,
one with the graph available and one without. Both answered the blast-radius and
symbol-usage questions identically and correctly.

**Token cost: 51,802 with the graph vs 97,464 without (−47%).**

Caveats, which matter as much as the number:

- n = 1. One run, one project, one pair of agents.
- The no-graph agent was unusually efficient — it wrote a TypeScript-compiler
  script instead of grepping — so a typical agent would likely cost more, and the
  gap would likely be wider.
- On the dead-exports question the two answers used different definitions of
  "dead" (18 vs 44 symbols), and **the no-graph answer was the more nuanced one**.

The gap between −47% here and the 98.5% in the table above is the honest measure
of how much a modelled baseline flatters the graph. A real agent is far more
frugal than "read every file that matched" — which is exactly why the two
smallest rows, `file-declarations` and `symbol-source`, are worth more than the
big ones: their baselines open one file, so there is nothing left to flatter.
