// The benchmark's question set.
//
// Each entry pairs ONE real question with the two ways of answering it:
//   `graph`    — the loregraph command to run; its stdout is what the agent reads.
//   `baseline` — a procedure descriptor from `./baseline.mjs`, i.e. an explicit
//                model of the files a file-reading agent would open instead.
//
// `comparability` is the honest small print: where the two paths do NOT answer
// exactly the same thing, and in whose favour that leans. Read it before quoting
// any ratio from this benchmark.
//
// Targets below refer to loregraph's own source tree, which is the default
// target repo. Pointing `--repo-root` at another project needs a matching
// question file — pass it with `--questions ./my-questions.mjs`.

/** Lists are capped by `--limit`; 200 is "no truncation" on a repo this size. */
const LIMIT = ['--limit', '200'];

export const QUESTIONS = [
  {
    id: 'blast-radius',
    question: 'If I change src/lib/graph_load.mjs, what might break, and which tests should I run?',
    requires: ['src/lib/graph_load.mjs'],
    graph: {
      kind: 'cli',
      argv: ['impact', '--files', 'src/lib/graph_load.mjs', ...LIMIT],
    },
    baseline: {
      kind: 'importer-closure',
      target: 'src/lib/graph_load.mjs',
      summary:
        'Grep the repo for `graph_load` on import-looking lines, resolve the relative '
        + 'specifiers, open every real importer in full — then repeat for each file just '
        + 'found, until the frontier is empty.',
    },
    comparability:
      'Same question, same shape of answer. The graph also names the likely test files; '
      + 'the baseline gets those for free because test files are importers too.',
  },

  {
    id: 'symbol-usage',
    question: 'Where is the exported symbol `loadGraph` used, and by which functions?',
    requires: ['src/lib/graph_load.mjs'],
    graph: {
      kind: 'cli',
      argv: ['brief', 'loadGraph', ...LIMIT],
    },
    baseline: {
      kind: 'grep-then-read',
      symbol: 'loadGraph',
      summary:
        'grep -rl for the symbol across all source files, then read the full text of '
        + 'every file that matched.',
    },
    comparability:
      'The graph additionally names the *enclosing function* of each use (`run@src/brief/run.mjs`), '
      + 'which the baseline would have to work out from the file text it just read. '
      + 'Leans slightly in the graph’s favour.',
  },

  {
    id: 'file-orientation',
    question: 'What is src/mcp/lib/tools.mjs, what does it declare, and what is wired to it?',
    requires: ['src/mcp/lib/tools.mjs'],
    graph: {
      kind: 'cli',
      argv: ['brief', 'src/mcp/lib/tools.mjs', ...LIMIT],
    },
    baseline: {
      kind: 'file-orientation',
      target: 'src/mcp/lib/tools.mjs',
      summary:
        'Read the file in full, grep for its basename on import-looking lines, then read '
        + 'each direct importer in full. One level out — no transitive walk.',
    },
    comparability:
      'NOT the same answer. The graph brief also carries the transitive blast radius and a '
      + 'per-symbol reference count; the baseline stops at direct importers. The baseline is '
      + 'therefore an under-estimate of what the file-reading path would really cost here.',
  },

  {
    id: 'domain-deps',
    question: 'What does the `mcp` module depend on, and who depends on it?',
    requires: ['src/mcp'],
    graph: {
      kind: 'cli',
      argv: ['brief', 'mcp', ...LIMIT],
    },
    baseline: {
      kind: 'read-dir',
      dir: 'src/mcp',
      summary:
        'List every source file under src/mcp/ and read all of them, since a file’s '
        + 'dependencies are only visible in its text.',
    },
    comparability:
      'NOT the same answer. Reading src/mcp/ shows what the module imports but not who imports '
      + 'it — the graph’s "depended on by" line would need a second, repo-wide pass the '
      + 'baseline is not charged for. Under-estimate, again in the baseline’s favour.',
  },

  {
    id: 'file-declarations',
    question: 'What does src/mcp/lib/tools.mjs declare?',
    requires: ['src/mcp/lib/tools.mjs'],
    graph: {
      kind: 'cli',
      argv: ['outline', 'src/mcp/lib/tools.mjs', ...LIMIT],
    },
    baseline: {
      kind: 'read-file',
      target: 'src/mcp/lib/tools.mjs',
      summary:
        'The path is already known, so there is nothing to search for: open the file and read '
        + 'it. One file, no grep — the cheapest baseline in this set.',
    },
    comparability:
      'NOT the same answer, and here the BASELINE is the bigger one: the file text contains '
      + 'everything the outline contains plus every function body. The outline answers "what '
      + 'does this file declare" exactly — kind, name, export status, line range, signature — '
      + 'and does NOT answer "what does this code do". That is what `show` is for.',
  },

  {
    id: 'symbol-source',
    question: 'Show me the implementation of `loadGraph`.',
    requires: ['src/lib/graph_load.mjs'],
    graph: {
      kind: 'cli',
      argv: ['show', 'loadGraph'],
    },
    baseline: {
      kind: 'find-symbol-source',
      symbol: 'loadGraph',
      declaredIn: 'src/lib/graph_load.mjs',
      summary:
        'grep -rn for the symbol as a whole word — the hit lines enter the context — then read '
        + 'in full the one file that declares it. Charitable: a real agent does not know which '
        + 'hit is the declaration and would often open more than one file.',
    },
    comparability:
      'Same answer for what was asked: `show` prints the declaration verbatim, JSDoc included, '
      + 'so the implementation itself is byte-identical text. The baseline additionally carries '
      + 'the rest of the declaring file — not asked for, but an agent may well use it next. '
      + 'Both sides pay for locating the symbol: the graph in its own output, the baseline in '
      + 'grep hits.',
  },

  {
    id: 'dead-exports',
    question: 'Which exported symbols are never referenced from outside their own file?',
    requires: [],
    graph: {
      kind: 'mcp',
      tool: 'dead_exports',
      arguments: { limit: 200 },
    },
    baseline: {
      kind: 'read-all',
      summary:
        'A repo-wide question needs a repo-wide read: list every source file, then read all '
        + 'of them — you cannot know what a file exports, or whether anything uses it, without '
        + 'its text.',
    },
    comparability:
      'This is the weakest baseline in the set, and it flatters the graph. A capable agent may '
      + 'skip reading altogether and write a script (the manual A/B in the README records exactly '
      + 'that happening). Treat this row as an upper bound on the naive path, not as a claim about '
      + 'good agents. The two paths also use different definitions of "dead" — see the README.',
  },
];

export default QUESTIONS;
