// The "no graph" side of the benchmark: an explicit, deterministic model of the
// files a file-reading agent would pull into its context to answer a question.
//
// IMPORTANT — what this is and is not:
//   This is a MODEL of agent behaviour, not a measurement of a real agent. No
//   model is run here. Each procedure below is a short, arguable recipe ("grep
//   for the symbol, then read every file that matched"), and the benchmark
//   prices the text that recipe would put in front of a model. If you think a
//   recipe is unfair, the recipe is the thing to argue with — it is all here in
//   plain code, and `bench/README.md` spells each one out in prose.
//
// Everything in this file is pure apart from reading the target repo from disk,
// and every list it produces is sorted, so two runs over the same tree produce
// byte-identical output.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import ignore from 'ignore';

/**
 * The extensions the benchmark treats as "source" — i.e. the haystack a
 * repo-wide grep would search. Deliberately the JS/TS family only: those are
 * the files loregraph itself parses, so both sides of the comparison see the
 * same universe.
 */
export const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
]);

/** Directories skipped at any depth, on top of the repo's ignore file. */
export const HARD_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.kg-cache', 'dist', 'build', 'coverage',
  '.next', '.venv', 'venv', '__pycache__', '.cache', '.turbo', '.vite',
]);

/** How many leading lines the optimistic "skim" pricing keeps per file. */
export const SKIM_LINES = 40;

const toPosix = (p) => p.split(sep).join('/');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripExt = (p) => p.replace(/\.(m|c)?[jt]sx?$/, '');

/**
 * Every source file in `root`, as sorted repo-relative POSIX paths.
 *
 * Honours the repo's `.gitignore` plus the hard-skip list above — the same
 * "what would ripgrep actually search" semantics, implemented in Node so the
 * benchmark needs no external binary.
 */
export function listSourceFiles(root, { ignoreFile = '.gitignore', exclude = [] } = {}) {
  const ig = ignore();
  try {
    ig.add(readFileSync(join(root, ignoreFile), 'utf8'));
  } catch {
    /* no ignore file → no rules */
  }
  const excluded = new Set(exclude.filter(Boolean).map((p) => toPosix(p).replace(/\/+$/, '')));

  const out = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const isDir = entry.isDirectory();
      if (isDir && HARD_SKIP_DIRS.has(entry.name)) continue;
      if (excluded.has(rel)) continue;
      if (ig.ignores(isDir ? `${rel}/` : rel)) continue;
      if (isDir) {
        walk(join(absDir, entry.name), rel);
      } else if (SOURCE_EXTS.has(extOf(entry.name))) {
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

/**
 * The searchable repo: the source-file list plus memoized file text, so a
 * procedure that greps three times still reads each file from disk once.
 */
export class Corpus {
  constructor(root, files) {
    this.root = root;
    this.files = files;
    this._text = new Map();
  }

  static from(root, opts) {
    return new Corpus(root, listSourceFiles(root, opts));
  }

  /** Full text of a repo-relative file (empty string when unreadable). */
  text(rel) {
    if (!this._text.has(rel)) {
      let t = '';
      try {
        t = readFileSync(join(this.root, ...rel.split('/')), 'utf8');
      } catch {
        t = '';
      }
      this._text.set(rel, t);
    }
    return this._text.get(rel);
  }

  /** The first `n` lines of a file — the optimistic "the agent skimmed it" view. */
  head(rel, n = SKIM_LINES) {
    return this.text(rel).split('\n').slice(0, n).join('\n');
  }

  has(rel) {
    return this.files.includes(rel);
  }
}

// ---- grep ---------------------------------------------------------------

/** Lines that look like they carry a module specifier (`import`/`require`/`from`). */
const IMPORTISH = /\b(?:import|require|from)\b/;

/**
 * Scan the corpus for `needle`.
 *
 * @param {Corpus} corpus
 * @param {object} opts
 * @param {string} opts.needle          matched as a whole word
 * @param {boolean} [opts.importOnly]   only lines that also look like an import
 * @returns {{hits: Array<{path: string, lineNo: number, text: string}>, files: string[]}}
 */
export function grep(corpus, { needle, importOnly = false }) {
  const re = new RegExp(`\\b${escapeRe(needle)}\\b`);
  const hits = [];
  const files = [];
  for (const rel of corpus.files) {
    let matched = false;
    const lines = corpus.text(rel).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!re.test(line)) continue;
      if (importOnly && !IMPORTISH.test(line)) continue;
      matched = true;
      hits.push({ path: rel, lineNo: i + 1, text: line.trim() });
    }
    if (matched) files.push(rel);
  }
  return { hits, files };
}

/** `grep -rn` output: one `path:line:text` per hit. */
export function renderHits(hits) {
  return hits.map((h) => `${h.path}:${h.lineNo}:${h.text}`).join('\n');
}

/** `grep -rl` / `find` output: one path per line. */
export function renderList(paths) {
  return paths.join('\n');
}

// ---- import resolution --------------------------------------------------

/** Every quoted string on a line — the candidate module specifiers. */
function quotedStrings(line) {
  return [...line.matchAll(/['"`]([^'"`\n]+)['"`]/g)].map((m) => m[1]);
}

/**
 * Resolve a *relative* specifier seen in `fromRel` to an extension-less
 * repo-relative key, or `null` for a package/bare specifier.
 *
 * This is the one place the baseline is allowed to be clever, and it costs the
 * baseline nothing: it only decides which of the grep hits are worth opening.
 * A human reading `from '../lib/graph_load.mjs'` does exactly this in their head.
 */
export function resolveRelativeSpecifier(fromRel, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
  const segs = fromRel.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  return stripExt(segs.join('/'));
}

/** Files whose import lines resolve to `targetRel`, given a set of grep hits. */
export function importersFromHits(hits, targetRel) {
  const targetKey = stripExt(targetRel);
  const found = new Set();
  for (const hit of hits) {
    if (hit.path === targetRel) continue;
    for (const spec of quotedStrings(hit.text)) {
      const key = resolveRelativeSpecifier(hit.path, spec);
      // `./pkg` is a directory specifier — it lands on `./pkg/index.*`.
      if (key === targetKey || `${key}/index` === targetKey) found.add(hit.path);
    }
  }
  return [...found].sort();
}

// ---- procedures ---------------------------------------------------------
//
// Every procedure returns the same shape:
//   { steps: string[]      — human-readable trace of what was "run"
//     toolOutput: string   — the tool output that lands in the context window
//     readFiles: string[]  — files opened in full, deduped, in read order }

const basenameOf = (rel) => rel.split('/').pop();

/**
 * "What breaks if I change X?" — walk the importer graph outwards by hand.
 *
 * Round 1: grep the repo for X's basename on import-looking lines, resolve the
 * hits, open every real importer in full. Round 2: do the same for each file
 * just discovered. Repeat until nothing new turns up.
 */
export function importerClosure(corpus, { target, maxRounds = 12 }) {
  const steps = [];
  const chunks = [];
  const read = [];
  const seen = new Set([target]);
  // Many files share a basename (`run.mjs` a dozen times over), so the same
  // grep comes up again and again. An agent runs it once and keeps the output
  // in context — charge it once too, which biases the baseline downwards.
  const grepped = new Map();
  let frontier = [target];

  for (let round = 0; round < maxRounds && frontier.length > 0; round += 1) {
    const next = [];
    for (const file of frontier) {
      const needle = stripExt(basenameOf(file));
      let hits = grepped.get(needle);
      if (hits === undefined) {
        hits = grep(corpus, { needle, importOnly: true }).hits;
        grepped.set(needle, hits);
        steps.push(`grep -rn '\\b${needle}\\b' (import lines) → ${hits.length} hit(s)`);
        chunks.push(renderHits(hits));
      } else {
        steps.push(`grep -rn '\\b${needle}\\b' — already in context, not charged again`);
      }
      for (const importer of importersFromHits(hits, file)) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        read.push(importer);
        next.push(importer);
      }
    }
    frontier = next;
  }

  return { steps, toolOutput: chunks.filter(Boolean).join('\n'), readFiles: read };
}

/**
 * "Who uses symbol S?" — the procedure the task description names verbatim:
 * `grep -rl S`, then the full text of every file that matched.
 */
export function grepThenRead(corpus, { symbol }) {
  const { files } = grep(corpus, { needle: symbol });
  return {
    steps: [`grep -rl '\\b${symbol}\\b' → ${files.length} file(s)`],
    toolOutput: renderList(files),
    readFiles: files,
  };
}

/**
 * "What is file X and what is it wired to?" — read X, then grep for its
 * basename and read its direct importers. One level only.
 */
export function fileOrientation(corpus, { target }) {
  const needle = stripExt(basenameOf(target));
  const { hits } = grep(corpus, { needle, importOnly: true });
  const importers = importersFromHits(hits, target);
  return {
    steps: [
      `read ${target}`,
      `grep -rn '\\b${needle}\\b' (import lines) → ${hits.length} hit(s), ${importers.length} real importer(s)`,
    ],
    toolOutput: renderHits(hits),
    readFiles: [target, ...importers],
  };
}

/** "What does module M depend on?" — list M's directory, read everything in it. */
export function readDir(corpus, { dir }) {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  const files = corpus.files.filter((f) => f.startsWith(prefix));
  return {
    steps: [`find ${prefix} → ${files.length} file(s)`, `read all ${files.length}`],
    toolOutput: renderList(files),
    readFiles: files,
  };
}

/** "Repo-wide question" — list every source file, read every source file. */
export function readAll(corpus) {
  return {
    steps: [`find . → ${corpus.files.length} source file(s)`, `read all ${corpus.files.length}`],
    toolOutput: renderList(corpus.files),
    readFiles: [...corpus.files],
  };
}

/**
 * "What does this file declare?" — the agent already has the path, so there is
 * no search step: it opens the file. This is the smallest, most charitable
 * baseline in the set — one file, no grep, nothing extra charged.
 */
export function readFile(corpus, { target }) {
  return {
    steps: [`read ${target}`],
    toolOutput: '',
    readFiles: [target],
  };
}

/**
 * "Show me the implementation of X" — grep the repo for the name, then open the
 * ONE file that really declares it.
 *
 * Deliberately charitable: a real agent does not know in advance which of the
 * grep hits is the declaration, and would often open several files. Charging
 * only the declaring file makes the baseline cheaper than reality.
 */
export function findSymbolSource(corpus, { symbol, declaredIn }) {
  const { hits } = grep(corpus, { needle: symbol });
  return {
    steps: [
      `grep -rn '\\b${symbol}\\b' → ${hits.length} hit(s)`,
      `read ${declaredIn} (the one file that declares it)`,
    ],
    toolOutput: renderHits(hits),
    readFiles: [declaredIn],
  };
}

export const PROCEDURES = {
  'importer-closure': importerClosure,
  'grep-then-read': grepThenRead,
  'file-orientation': fileOrientation,
  'read-dir': readDir,
  'read-all': readAll,
  'read-file': readFile,
  'find-symbol-source': findSymbolSource,
};

/** Run a baseline descriptor from `questions.mjs` against a corpus. */
export function runProcedure(corpus, descriptor) {
  const fn = PROCEDURES[descriptor.kind];
  if (!fn) throw new Error(`unknown baseline procedure: ${descriptor.kind}`);
  return fn(corpus, descriptor);
}

/**
 * Price a procedure's context in tokens.
 *
 * `full` charges every opened file in its entirety — what an agent using a
 * whole-file Read tool actually pays. `skim` charges only each file's first
 * `SKIM_LINES` lines: not a realistic way to answer these questions, but a hard
 * floor under the file-reading path, so nobody has to take the headline number
 * on faith.
 */
export function priceContext(corpus, result, countTokens, { skimLines = SKIM_LINES } = {}) {
  const toolTokens = countTokens(result.toolOutput);
  let fileTokens = 0;
  let skimTokens = 0;
  let bytes = 0;
  for (const rel of result.readFiles) {
    fileTokens += countTokens(corpus.text(rel));
    skimTokens += countTokens(corpus.head(rel, skimLines));
    bytes += Buffer.byteLength(corpus.text(rel), 'utf8');
  }
  return {
    toolTokens,
    fileTokens,
    full: toolTokens + fileTokens,
    skim: toolTokens + skimTokens,
    filesRead: result.readFiles.length,
    bytesRead: bytes,
  };
}
