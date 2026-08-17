// `loregraph outline <file>` — print a file's skeleton without its bodies.
//
// No graph, no cache: it parses the one file it was asked about, so it works on
// a repo that has never been indexed and is never wrong about a stale symbol.
// `<file>` is resolved the same forgiving way `brief` resolves a file target —
// an exact repo-relative path, or a trailing path suffix like `Cart.tsx` — and
// an ambiguous suffix prints its candidates instead of guessing.
//
// Exit codes: 0 answered (INCLUDING an ambiguous or unmatched target — the
// candidate list is the useful answer) · 1 the file could not be read · 2 usage
// error, or a file the TypeScript parser does not handle.

import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { ANSWER_OPTIONS, resolveMaxTokens } from '../lib/answer_render.mjs';
import { fitOutline, DEFAULT_LIMIT } from './lib/outline.mjs';
import { outlineTarget } from './lib/lookup.mjs';

export async function run(argv) {
  const cwd = process.cwd();

  let cfg;
  try {
    cfg = await resolveConfig({
      cwd,
      argv,
      extraOptions: {
        json: { type: 'boolean' },
        limit: { type: 'string' },
        ...ANSWER_OPTIONS,
      },
    });
  } catch (err) {
    console.error(`outline: usage error: ${err.message}`);
    return 2;
  }

  const flags = cfg._flags;
  const target = cfg._positionals[0];
  if (!target) {
    console.error('outline: missing <file> — a repo-relative path or a path suffix (Cart.tsx)');
    return 2;
  }

  let limit = DEFAULT_LIMIT;
  if (flags.limit !== undefined) {
    limit = Number(flags.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`outline: --limit must be a positive integer, got ${flags.limit}`);
      return 2;
    }
  }

  const budget = resolveMaxTokens(flags);
  if (budget.error) {
    console.error(`outline: ${budget.error}`);
    return 2;
  }

  const result = outlineTarget({
    repoRoot: cfg.repoRoot, target, limit, ignoreFile: cfg.ignoreFile,
  });

  if (result.kind === 'unsupported') {
    console.error(`outline: ${result.path} is not a JS/TS source file — outline parses `
      + '.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs');
    return 2;
  }
  if (result.kind === 'unreadable') {
    console.error(`outline: could not read ${result.path}`);
    return 1;
  }

  const fit = fitOutline(result, {
    mode: flags.json ? 'json' : 'text',
    jsonSpace: 2,
    maxTokens: budget.value,
  });
  console.log(fit.text);
  return 0;
}
