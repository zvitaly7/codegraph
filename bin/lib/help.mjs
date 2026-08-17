// Help text for the `loregraph` CLI dispatcher — one registry backing BOTH
// `loregraph --help` (the command list) and `loregraph <cmd> --help` (a single
// command's flags), so the two can never drift apart from each other.
//
// Deliberately pure and cheap to import: every value pulled in here (DEFAULTS,
// the brief/impact list caps, the docs language table, init's own usage text)
// is a plain-data module with no filesystem/network access at import time — NOT
// a `run.mjs` command module. The bin dispatcher imports this file eagerly, on
// every invocation, to decide whether `--help`/`-h` was requested BEFORE it ever
// imports the (potentially heavy, I/O-performing) command module itself.
//
// Flags below are transcribed from each command's real `extraOptions` passed to
// `resolveConfig()` in its own `src/<cmd>/run.mjs` — keep the two in sync by
// hand when a command's options change (`init` avoids this entirely by sharing
// its usage text directly; see `src/init/lib/usage.mjs`).

import { DEFAULTS } from '../../src/config/defaults.mjs';
import { DEFAULT_LIMIT as BRIEF_LIMIT } from '../../src/brief/lib/brief.mjs';
import { DEFAULT_LIMIT as OUTLINE_LIMIT } from '../../src/outline/lib/outline.mjs';
import { DEFAULT_CONTEXT as SHOW_CONTEXT } from '../../src/show/lib/show.mjs';
import { DEFAULT_LIMIT as IMPACT_LIMIT } from '../../src/impact/lib/impact.mjs';
import { STRINGS as DOCS_STRINGS, DEFAULT_LANG as DOCS_DEFAULT_LANG } from '../../src/docs/lib/render.mjs';
import { USAGE as INIT_USAGE } from '../../src/init/lib/usage.mjs';

// The three global flags every `resolveConfig`-based command accepts, keyed for
// reuse in each command's `globals` list below. `init` does not use these (it
// never loads `loregraph.config.mjs`) and ships its own usage text instead.
const GLOBAL_FLAGS = {
  'repo-root': ['--repo-root PATH', 'the project to analyze (default: current directory)'],
  out: ['--out DIR', `graph cache directory (default: <repo-root>/${DEFAULTS.outDir})`],
  config: ['--config FILE', 'explicit config file (default: loregraph.config.mjs|json at --repo-root)'],
};

const DOCS_LANGS = Object.keys(DOCS_STRINGS).join('|');

// Display order for `loregraph --help`'s Commands: list — a curated workflow
// order (set up, build, then each layer, then consumers), NOT the alphabetical
// or dependency order used elsewhere.
export const COMMAND_ORDER = [
  'init', 'regenerate', 'inventory', 'imports', 'symbols', 'references',
  'usages', 'domains', 'brief', 'outline', 'show', 'impact', 'explorer', 'docs', 'mcp',
];

/**
 * One entry per sub-command. Either:
 *   - `{ text }` — a fully pre-rendered, already-accurate help block (used only
 *     by `init`, which owns its own usage text so nothing here duplicates it), or
 *   - `{ summary, usage, options, globals }` — structured data rendered by
 *     `formatCommandHelp()` below. `options` are command-specific flags (from
 *     that command's `extraOptions`); `globals` are keys into `GLOBAL_FLAGS`.
 */
export const COMMAND_HELP = {
  init: {
    summary: 'Set a project up: config, ignore rule, MCP entry, npm scripts',
    text: INIT_USAGE,
  },
  regenerate: {
    summary: 'Build the whole graph in dependency order',
    usage: 'loregraph regenerate [options]',
    options: [
      ['--skip-explorer', 'omit the browser-index step'],
      ['--skip-heavy', 'omit references/usages (light graph only: inventory+imports+symbols+domains)'],
      ['--if-stale', 'only rebuild when the cache is stale or its staleness is unknown'],
      ['--force', 'always rebuild, even together with --if-stale'],
      ['--incremental off|incremental', `rebuild mode for references/usages (default: ${DEFAULTS.incremental})`],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  inventory: {
    summary: 'Layer 1: files + directories',
    usage: 'loregraph inventory [options]',
    options: [
      ['--no-hash', 'skip content hashing (faster; disables hash-based change detection)'],
      ['--require-vcs', 'fail (exit 1) if no VCS metadata is available'],
      ['--require-clean', 'fail (exit 1) if the working tree has local changes'],
      ['--project-name NAME', 'override the inferred project name (default: repo directory name)'],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  imports: {
    summary: 'Layer 2a: file → file/package imports',
    usage: 'loregraph imports [options]',
    options: [
      ['--inventory DIR', 'inventory artifacts to read (default: <out>/inventory)'],
      ['--require-resolution-rate N', 'fail (exit 1) if the import resolution rate is below N (0-1)'],
      ['--max-files N', 'analyze only the first N sources (deterministic order)'],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  symbols: {
    summary: 'Layer 2b: declarations',
    usage: 'loregraph symbols [options]',
    options: [
      ['--inventory DIR', 'inventory artifacts to read (default: <out>/inventory)'],
      ['--max-files N', 'analyze only the first N sources (deterministic order)'],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  references: {
    summary: 'Layer 2c: file → symbol',
    usage: 'loregraph references [options]',
    options: [
      ['--inventory DIR', 'inventory artifacts to read (default: <out>/inventory)'],
      ['--symbols DIR', 'symbols artifacts to read (default: <out>/symbols)'],
      ['--max-files N', 'analyze only the first N sources (deterministic order)'],
      ['--incremental off|incremental', `rebuild mode (default: ${DEFAULTS.incremental})`],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  usages: {
    summary: 'Layer 2d: symbol → symbol',
    usage: 'loregraph usages [options]',
    options: [
      ['--inventory DIR', 'inventory artifacts to read (default: <out>/inventory)'],
      ['--symbols DIR', 'symbols artifacts to read (default: <out>/symbols)'],
      ['--max-files N', 'analyze only the first N sources (deterministic order)'],
      ['--incremental off|incremental', `rebuild mode (default: ${DEFAULTS.incremental})`],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  domains: {
    summary: 'Layer 3: semantic domain overlay',
    usage: 'loregraph domains [options]',
    options: [
      ['--inventory DIR', 'inventory artifacts to read (default: <out>/inventory)'],
      ['--imports DIR', 'imports artifacts to read (default: <out>/imports; optional — omit for BELONGS_TO only, no DEPENDS_ON)'],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  brief: {
    summary: 'Context pack for a file / domain / symbol',
    usage: 'loregraph brief <target> [options]',
    options: [
      ['--cache DIR', 'graph cache to read (default: resolved --out)'],
      ['--json', 'print the raw structured object instead of formatted text'],
      ['--limit N', `cap list lengths (default: ${BRIEF_LIMIT})`],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  outline: {
    summary: 'A file\'s declarations, without the bodies',
    usage: 'loregraph outline <file> [options]',
    options: [
      ['--json', 'print the raw structured object instead of formatted text'],
      ['--limit N', `cap the declaration / member lists (default: ${OUTLINE_LIMIT})`],
    ],
    globals: ['repo-root', 'config'],
  },
  show: {
    summary: 'The source of exactly one symbol',
    usage: 'loregraph show <symbol> [options]',
    options: [
      ['--cache DIR', 'graph cache used to locate the symbol (default: resolved --out)'],
      ['--json', 'print the raw structured object instead of formatted text'],
      ['--context N', `lines of surrounding context (default: ${SHOW_CONTEXT})`],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  impact: {
    summary: 'Blast radius + likely tests for a diff',
    usage: 'loregraph impact [options]',
    options: [
      ['--cache DIR', 'graph cache to read (default: resolved --out)'],
      ['--json', 'print the raw structured object instead of formatted text'],
      ['--limit N', `cap list lengths (default: ${IMPACT_LIMIT})`],
      ['--diff REF', 'changed files = working tree vs REF (default: HEAD)'],
      ['--files a,b,c', 'explicit changed-file list instead of a VCS diff (repeatable)'],
      ['--max-depth N', 'cap the blast-radius traversal depth (default: unlimited)'],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  explorer: {
    summary: 'Build (and optionally serve) the browser index',
    usage: 'loregraph explorer [options]',
    options: [
      ['--cache DIR', 'graph cache to read/write (default: resolved --out)'],
      ['--serve', 'serve <cache>/explorer/ over HTTP until Ctrl+C'],
      // Keep in sync with DEFAULT_PORT in src/explorer/run.mjs.
      ['--port N', 'HTTP port for --serve (default: 8765)'],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  docs: {
    summary: 'Generate AGENTS.md + Markdown docs from the graph',
    usage: 'loregraph docs [options]',
    options: [
      ['--cache DIR', 'graph cache to read (default: resolved --out)'],
      ['--out-docs DIR', 'docs output directory (default: <repo-root>/docs/loregraph)'],
      ['--agents-out FILE', 'AGENTS.md path (default: <repo-root>/AGENTS.md)'],
      [`--lang ${DOCS_LANGS}`, `output language (default: ${DOCS_DEFAULT_LANG})`],
      ['--force', 'overwrite target files even without loregraph markers'],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
  mcp: {
    summary: 'Start the stdio MCP server',
    usage: 'loregraph mcp [options]',
    options: [
      ['--cache DIR', 'graph cache to read (default: resolved --out)'],
    ],
    globals: ['repo-root', 'out', 'config'],
  },
};

/** Render `[flag, description]` pairs as an aligned, indented block. */
function renderRows(rows) {
  const width = Math.max(...rows.map(([flag]) => flag.length)) + 2;
  return rows.map(([flag, desc]) => `  ${flag.padEnd(width)}${desc}`).join('\n');
}

/** `true` when `args` contains `--help` or `-h` anywhere (not just first). */
export function wantsHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

/** Concise help for one sub-command, or `null` for an unknown name. */
export function formatCommandHelp(name) {
  const entry = COMMAND_HELP[name];
  if (!entry) return null;
  if (entry.text) return entry.text; // init: pre-rendered, single source of truth.

  const parts = [`loregraph ${name} — ${entry.summary}`, '', `Usage: ${entry.usage}`];
  if (entry.options?.length) parts.push('', 'Options:', renderRows(entry.options));
  if (entry.globals?.length) parts.push('', 'Global:', renderRows(entry.globals.map((k) => GLOBAL_FLAGS[k])));
  return parts.join('\n');
}

/** The top-level `loregraph --help` / `loregraph` (no args) usage block. */
export function formatMainUsage() {
  const width = Math.max(...COMMAND_ORDER.map((name) => name.length)) + 3;
  const lines = COMMAND_ORDER.map((name) => `  ${name.padEnd(width)}${COMMAND_HELP[name].summary}`);
  return `loregraph <command> [options]\n\nCommands:\n${lines.join('\n')}\n\n`
    + 'Global: --repo-root PATH  --out DIR  --config FILE  --help';
}
