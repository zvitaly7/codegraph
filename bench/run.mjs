#!/usr/bin/env node
// bench/run.mjs — how many tokens does a question cost with the graph vs without?
//
//   node bench/run.mjs [--repo-root PATH] [--questions FILE] [--out FILE]
//                      [--timestamp ISO] [--keep-cache] [--quiet]
//
// For each question in `./questions.mjs` it does two things:
//
//   graph path     run the loregraph command, count the tokens of its stdout.
//   baseline path  run the documented file-reading procedure from `./baseline.mjs`,
//                  count the tokens of everything it would put in a context window.
//
// The graph side is a real measurement: a real process, real stdout, a real
// tokenizer. The baseline side is a MODEL of agent behaviour — no model is run,
// nobody's context window is observed. Both are stated plainly in the output.
//
// The graph build cost is reported separately, in wall-clock seconds. It costs
// zero tokens because it happens outside any model's context, but it is not free
// and it is not folded into the per-question numbers.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import process from 'node:process';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { Corpus, SKIM_LINES, priceContext, runProcedure } from './baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const CLI = join(PKG_ROOT, 'bin', 'loregraph.mjs');

/** Named so results.json says what produced its numbers. */
export const TOKENIZER = 'gpt-tokenizer / o200k_base (GPT-4o, GPT-5 family)';

// ---- the two paths ------------------------------------------------------

/** Run a loregraph sub-command; return exactly what an agent would see on stdout. */
function runCli(argv, { repoRoot, cache }) {
  const args = [CLI, ...argv, '--repo-root', repoRoot, '--cache', cache];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`loregraph ${argv.join(' ')} exited ${res.status}: ${res.stderr?.trim()}`);
  }
  return { text: res.stdout, command: `loregraph ${argv.join(' ')}` };
}

/**
 * Call one MCP tool over the real stdio server and return the tool result text.
 *
 * Only `content[0].text` is counted — the JSON-RPC envelope is transport that no
 * agent pays for as content.
 */
function runMcp({ tool, arguments: args = {} }, { repoRoot, cache }) {
  const req = `${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args },
  })}\n`;
  const res = spawnSync(process.execPath, [CLI, 'mcp', '--repo-root', repoRoot, '--cache', cache], {
    input: req, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`loregraph mcp exited ${res.status}: ${res.stderr?.trim()}`);
  const line = res.stdout.split('\n').filter((l) => l.trim()).pop();
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(`mcp ${tool}: ${msg.error.message}`);
  return { text: msg.result.content[0].text, command: `mcp tools/call ${tool}` };
}

/**
 * Run a question's graph command, optionally with path-prefix compression on.
 *
 * Both variants are measured for EVERY question, including the ones with no
 * path lists to factor — a row where compression changes nothing, or makes
 * things worse, is exactly the row worth reporting.
 */
function runGraphPath(spec, ctx, { compress = false } = {}) {
  if (spec.kind === 'mcp') {
    const args = compress ? { ...(spec.arguments ?? {}), compressPaths: true } : (spec.arguments ?? {});
    return runMcp({ ...spec, arguments: args }, ctx);
  }
  return runCli(compress ? [...spec.argv, '--compress-paths'] : spec.argv, ctx);
}

// ---- target-repo facts --------------------------------------------------

function countJsonl(file, predicate) {
  if (!existsSync(file)) return 0;
  let n = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (!predicate) { n += 1; continue; }
    try {
      if (predicate(JSON.parse(line))) n += 1;
    } catch { /* skip unparseable line */ }
  }
  return n;
}

function repoStats(cache) {
  const isSymbol = (n) => Array.isArray(n.labels) && n.labels.includes('Symbol');
  return {
    indexedFiles: countJsonl(join(cache, 'inventory', 'files.jsonl')),
    symbols: countJsonl(join(cache, 'symbols', 'nodes.jsonl'), isSymbol),
    exportedSymbols: countJsonl(
      join(cache, 'symbols', 'nodes.jsonl'),
      (n) => isSymbol(n) && n.properties?.exported === true,
    ),
  };
}

// ---- reporting ----------------------------------------------------------

const pct = (graph, base) => (base === 0 ? 0 : Math.round(((base - graph) / base) * 1000) / 10);
const ratio = (graph, base) => (graph === 0 ? Infinity : Math.round((base / graph) * 10) / 10);

function markdownTable(rows) {
  const head = [
    '| question | graph tokens | baseline tokens | baseline, skim floor | files read | ratio | saved |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const body = rows.map((r) => (r.skipped
    ? `| \`${r.id}\` | — | — | — | — | — | skipped: ${r.skipped} |`
    : `| \`${r.id}\` | ${r.graphTokens} | ${r.baselineTokens} | ${r.baselineSkimTokens} `
      + `| ${r.filesRead} | ${r.ratio}x | ${r.savedPct}% |`));
  return [...head, ...body].join('\n');
}

/** The compression A/B: the same question answered plain and prefix-factored. */
function compressionMarkdownTable(rows) {
  const head = [
    '| question | plain | prefix-compressed | saved | verdict |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  const body = rows.filter((r) => !r.skipped).map((r) => `| \`${r.id}\` | ${r.graphTokens} `
    + `| ${r.compressed.tokens} | ${r.compressed.savedPct}% | ${r.compressed.verdict} |`);
  return [...head, ...body].join('\n');
}

function compressionTextTable(rows) {
  const cols = ['question', 'plain', 'compressed', 'saved', 'verdict'];
  const data = rows.filter((r) => !r.skipped).map((r) => [
    r.id, `${r.graphTokens}`, `${r.compressed.tokens}`, `${r.compressed.savedPct}%`, r.compressed.verdict,
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i].length)));
  const line = (cells) => cells
    .map((c, i) => (i === 0 || i === cols.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
    .join('  ');
  return [line(cols), widths.map((w) => '-'.repeat(w)).join('  '), ...data.map(line)].join('\n');
}

function textTable(rows) {
  const cols = ['question', 'graph', 'baseline', 'skim floor', 'files', 'ratio', 'saved'];
  const data = rows.map((r) => (r.skipped
    ? [r.id, '—', '—', '—', '—', '—', `skipped: ${r.skipped}`]
    : [r.id, `${r.graphTokens}`, `${r.baselineTokens}`, `${r.baselineSkimTokens}`,
      `${r.filesRead}`, `${r.ratio}x`, `${r.savedPct}%`]));
  const widths = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(cols), widths.map((w) => '-'.repeat(w)).join('  '), ...data.map(line)].join('\n');
}

// ---- main ---------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'repo-root': { type: 'string' },
      questions: { type: 'string' },
      out: { type: 'string' },
      timestamp: { type: 'string' },
      'keep-cache': { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(
      'node bench/run.mjs [options]\n\n'
      + '  --repo-root PATH   repo to benchmark (default: loregraph itself)\n'
      + '  --questions FILE   question set (default: ./questions.mjs)\n'
      + '  --out FILE         results JSON (default: bench/results.json)\n'
      + '  --timestamp ISO    stamp written into the results (default: now)\n'
      + '  --keep-cache       keep the temporary graph cache and print its path\n'
      + '  --quiet            hide the graph build log\n',
    );
    return 0;
  }

  const repoRoot = resolve(process.cwd(), values['repo-root'] ?? PKG_ROOT);
  const questionsPath = resolve(process.cwd(), values.questions ?? join(HERE, 'questions.mjs'));
  const outPath = resolve(process.cwd(), values.out ?? join(HERE, 'results.json'));
  // The one nondeterministic value in results.json, and it is an explicit input:
  // pass --timestamp to make a run byte-reproducible.
  const timestamp = values.timestamp ?? new Date().toISOString();

  const { QUESTIONS } = await import(pathToFileURL(questionsPath).href);
  const cache = mkdtempSync(join(tmpdir(), 'loregraph-bench-'));

  try {
    // --- 1. build the graph, timed -------------------------------------
    const t0 = Date.now();
    const build = spawnSync(process.execPath, [CLI, 'regenerate', '--repo-root', repoRoot, '--out', cache], {
      encoding: 'utf8', stdio: values.quiet ? 'ignore' : 'inherit', maxBuffer: 64 * 1024 * 1024,
    });
    const buildMs = Date.now() - t0;
    if (build.status !== 0) throw new Error(`loregraph regenerate exited ${build.status}`);

    const stats = repoStats(cache);
    // The benchmark never counts its own source. When bench/ sits inside the
    // repo being measured (as it does by default), leaving it in would let the
    // benchmark inflate itself — this very file mentions `loadGraph`, so a grep
    // for that symbol would "find" it. Note the asymmetry is deliberate and one
    // -sided: `regenerate` still indexes bench/, so the graph's own answers pay
    // for it. Both adjustments push against the graph, not for it.
    const selfDir = relative(repoRoot, HERE);
    const exclude = selfDir && !selfDir.startsWith('..') ? [selfDir] : [];
    const corpus = Corpus.from(repoRoot, { exclude });

    // --- 2. price every question ---------------------------------------
    const rows = [];
    for (const q of QUESTIONS) {
      const missing = (q.requires ?? []).filter((p) => !existsSync(join(repoRoot, p)));
      if (missing.length > 0) {
        rows.push({ id: q.id, question: q.question, skipped: `missing ${missing.join(', ')}` });
        continue;
      }

      const graph = runGraphPath(q.graph, { repoRoot, cache });
      const graphTokens = countTokens(graph.text);

      // The same question again, with path-prefix compression on. Measured for
      // every question so the decision to default it on or leave it opt-in
      // rests on numbers rather than on the fact that it was built.
      const packed = runGraphPath(q.graph, { repoRoot, cache }, { compress: true });
      const packedTokens = countTokens(packed.text);
      const compressed = {
        tokens: packedTokens,
        chars: packed.text.length,
        savedPct: pct(packedTokens, graphTokens),
        identical: packed.text === graph.text,
        verdict: packed.text === graph.text ? 'no path list to factor'
          : packedTokens < graphTokens ? 'smaller'
            : packedTokens > graphTokens ? 'WORSE' : 'no change',
      };

      const procedure = runProcedure(corpus, q.baseline);
      const priced = priceContext(corpus, procedure, countTokens);

      rows.push({
        id: q.id,
        question: q.question,
        comparability: q.comparability,
        graph: { command: graph.command, tokens: graphTokens, chars: graph.text.length },
        baseline: {
          procedure: q.baseline.kind,
          summary: q.baseline.summary,
          steps: procedure.steps,
          filesRead: priced.filesRead,
          bytesRead: priced.bytesRead,
          toolOutputTokens: priced.toolTokens,
          fileTokens: priced.fileTokens,
          tokens: priced.full,
          skimTokens: priced.skim,
        },
        compressed,
        graphTokens,
        baselineTokens: priced.full,
        baselineSkimTokens: priced.skim,
        filesRead: priced.filesRead,
        ratio: ratio(graphTokens, priced.full),
        savedPct: pct(graphTokens, priced.full),
        graphWins: priced.full > graphTokens,
      });
    }

    // --- 3. report ------------------------------------------------------
    const scored = rows.filter((r) => !r.skipped);
    const totals = {
      graphTokens: scored.reduce((a, r) => a + r.graphTokens, 0),
      baselineTokens: scored.reduce((a, r) => a + r.baselineTokens, 0),
      baselineSkimTokens: scored.reduce((a, r) => a + r.baselineSkimTokens, 0),
    };
    totals.ratio = ratio(totals.graphTokens, totals.baselineTokens);
    totals.savedPct = pct(totals.graphTokens, totals.baselineTokens);
    totals.skimRatio = ratio(totals.graphTokens, totals.baselineSkimTokens);
    totals.skimSavedPct = pct(totals.graphTokens, totals.baselineSkimTokens);
    totals.compressedGraphTokens = scored.reduce((a, r) => a + r.compressed.tokens, 0);
    totals.compressedSavedPct = pct(totals.compressedGraphTokens, totals.graphTokens);
    totals.compressedRatio = ratio(totals.compressedGraphTokens, totals.baselineTokens);

    const results = {
      tokenizer: TOKENIZER,
      timestamp,
      timestampSource: values.timestamp ? 'flag' : 'clock',
      repo: {
        root: repoRoot,
        indexedFiles: stats.indexedFiles,
        symbols: stats.symbols,
        exportedSymbols: stats.exportedSymbols,
        benchSourceFiles: corpus.files.length,
      },
      build: {
        command: 'loregraph regenerate',
        wallClockMs: buildMs,
        contextTokens: 0,
        note: 'The build runs as a normal process, outside any model context, so it costs '
          + 'zero tokens — but it is not free. Amortised across every question afterwards.',
      },
      pathCompression: {
        flag: '--compress-paths (CLI) / compressPaths: true (MCP)',
        note: 'Lossless prefix factoring: a text line reads `under <prefix>: <suffix>, …` '
          + 'and --json carries pathGroups: [{ pathPrefix, paths }], so every full path is '
          + 'pathPrefix + paths[i]. Measured on every question; rows with no path list to '
          + 'factor come back byte-identical.',
        totalPlainTokens: totals.graphTokens,
        totalCompressedTokens: totals.compressedGraphTokens,
        totalSavedPct: totals.compressedSavedPct,
      },
      baselineModel: {
        kind: 'model of agent behaviour, not a measured agent',
        skimLines: SKIM_LINES,
        note: 'Each baseline is an explicit file-reading procedure (see bench/README.md). '
          + '"tokens" charges every opened file in full; "skimTokens" charges only the first '
          + `${SKIM_LINES} lines of each — a floor, not a realistic way to answer.`,
      },
      totals,
      questions: rows,
    };

    writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);

    console.log('');
    console.log(`repo        ${repoRoot}`);
    console.log(`indexed     ${stats.indexedFiles} files · ${stats.symbols} symbols `
      + `· ${stats.exportedSymbols} exported · ${corpus.files.length} JS/TS files in the grep universe`);
    console.log(`build       ${(buildMs / 1000).toFixed(2)}s wall clock, 0 tokens (runs outside the model context)`);
    console.log(`tokenizer   ${TOKENIZER}`);
    console.log('');
    console.log(textTable(rows));
    console.log('');
    console.log('Path-prefix compression (--compress-paths), same questions:');
    console.log('');
    console.log(compressionTextTable(rows));
    console.log('');
    console.log(`            total ${totals.graphTokens} plain vs ${totals.compressedGraphTokens} `
      + `compressed → ${totals.compressedSavedPct}% saved`);
    console.log('');
    console.log(`TOTAL       graph ${totals.graphTokens} vs baseline ${totals.baselineTokens} `
      + `→ ${totals.ratio}x, ${totals.savedPct}% saved`);
    console.log(`            against the skim floor: ${totals.baselineSkimTokens} `
      + `→ ${totals.skimRatio}x, ${totals.skimSavedPct}% saved`);
    console.log('');
    console.log('The baseline is a MODEL of what a file-reading agent would read, not a');
    console.log('measurement of one. The procedures are in bench/baseline.mjs and are');
    console.log('described in bench/README.md — argue with them there.');
    const lost = scored.filter((r) => !r.graphWins);
    if (lost.length > 0) console.log(`\nGraph did NOT win on: ${lost.map((r) => r.id).join(', ')}`);
    console.log('');
    console.log(`wrote ${outPath}`);
    if (values['keep-cache']) console.log(`kept graph cache at ${cache}`);

    console.log('\nMarkdown:\n');
    console.log(markdownTable(rows));
    console.log('');
    console.log(compressionMarkdownTable(rows));
    return 0;
  } finally {
    if (!values['keep-cache']) rmSync(cache, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code ?? 0), (err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
