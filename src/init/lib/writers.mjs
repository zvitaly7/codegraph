// The idempotent file planners behind `loregraph init`.
//
// `init` writes into a project it does not own, so every function here is a
// PLANNER, not a writer: it takes the current contents of a file (or `null` when
// the file does not exist) and returns what the file should look like — never
// touching the disk. That keeps the merge rules pure and testable, and it makes
// `--dry-run` free: the caller simply does not write the planned content.
//
// The shared vocabulary of `status`:
//   create     the file is absent — write `content`
//   update     the file exists — write the merged `content`
//   unchanged  what we would add is already there — write NOTHING
//   conflict   something of ours exists with different content — LEAVE IT, report
//   invalid    the file cannot be parsed — leave it, report
//
// Running twice must be a no-op, so `unchanged` never carries content.

import { DEFAULTS } from '../../config/defaults.mjs';

/** The npm scripts `init` offers to add. */
export const INIT_SCRIPTS = {
  graph: 'loregraph regenerate',
  'graph:explore': 'loregraph explorer --serve',
};

/** Comment written above the cache entry in `.gitignore`. */
export const GITIGNORE_COMMENT = '# loregraph graph cache';

/** Sentinels that make our hook block identifiable (and re-runs a no-op). */
export const HOOK_BEGIN = '# >>> loregraph init >>>';
export const HOOK_END = '# <<< loregraph init <<<';

/** The one command the hook runs: cheap when the graph is already current. */
export const HOOK_COMMAND = 'npx loregraph regenerate --if-stale';

// --- .gitignore --------------------------------------------------------------

/**
 * Normalize a gitignore pattern enough to compare two spellings of one path:
 * `/.kg-cache/`, `.kg-cache`, `**\/.kg-cache` all mean the same thing here.
 */
function normalizeIgnorePattern(pattern) {
  let s = pattern.trim();
  if (s.startsWith('**/')) s = s.slice(3);
  if (s.startsWith('/')) s = s.slice(1);
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Is `entry` already ignored by this file? Comments and blank lines do not
 * count, and neither does a negation (`!.kg-cache/` un-ignores it).
 */
export function isIgnoreEntryCovered(text, entry) {
  const target = normalizeIgnorePattern(entry);
  return String(text ?? '').split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) return false;
    return normalizeIgnorePattern(line) === target;
  });
}

/** Append one commented entry to `.gitignore`, but only when it is missing. */
export function planGitignore(existing, { entry, comment = GITIGNORE_COMMENT }) {
  const block = `${comment}\n${entry}\n`;
  if (existing === null || existing === undefined) return { status: 'create', content: block };
  if (isIgnoreEntryCovered(existing, entry)) return { status: 'unchanged', content: existing };

  // Keep the appended block visually separate, and never join two entries onto
  // one line because the file happened to end without a newline.
  const trailing = existing.endsWith('\n') || existing === '' ? '' : '\n';
  const spacer = existing.trim() === '' ? '' : '\n';
  return { status: 'update', content: `${existing}${trailing}${spacer}${block}` };
}

// --- MCP / agent JSON --------------------------------------------------------

/** Key-order-insensitive structural comparison. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** A plain, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const stringify = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

/**
 * Add one stdio server entry to an agent config, preserving every other server
 * and every unrelated top-level key (`$schema`, VS Code's `inputs`, …).
 *
 * `key` is the client's top-level container — `mcpServers` for Claude Code and
 * Cursor, `servers` for VS Code — so one function serves all three.
 */
export function planJsonServerEntry(existing, { key, name, entry }) {
  if (existing === null || existing === undefined) {
    return { status: 'create', content: stringify({ [key]: { [name]: entry } }) };
  }

  let data;
  try {
    data = JSON.parse(existing);
  } catch (err) {
    return { status: 'invalid', reason: err.message };
  }
  if (!isPlainObject(data)) return { status: 'invalid', reason: 'top level is not a JSON object' };

  const servers = data[key];
  if (servers !== undefined && !isPlainObject(servers)) {
    return { status: 'invalid', reason: `"${key}" is not a JSON object` };
  }
  if (servers && Object.hasOwn(servers, name)) {
    return deepEqual(servers[name], entry)
      ? { status: 'unchanged' }
      : { status: 'conflict', existingEntry: servers[name] };
  }

  // Spreading keeps the original key order and appends `key` only when new.
  return { status: 'update', content: stringify({ ...data, [key]: { ...(servers ?? {}), [name]: entry } }) };
}

// --- package.json scripts ----------------------------------------------------

/**
 * Add the missing scripts to `package.json`. Scripts that already exist are
 * left exactly as they are and reported as conflicts; when nothing is missing
 * the file is not rewritten at all, so formatting survives a second run.
 */
export function planPackageScripts(existing, scripts = INIT_SCRIPTS) {
  let data;
  try {
    data = JSON.parse(existing);
  } catch (err) {
    return { status: 'invalid', reason: err.message, added: [], conflicts: [] };
  }
  if (!isPlainObject(data)) return { status: 'invalid', reason: 'top level is not a JSON object', added: [], conflicts: [] };
  if (data.scripts !== undefined && !isPlainObject(data.scripts)) {
    return { status: 'invalid', reason: '"scripts" is not a JSON object', added: [], conflicts: [] };
  }

  const added = [];
  const conflicts = [];
  const nextScripts = { ...(data.scripts ?? {}) };
  for (const [name, command] of Object.entries(scripts)) {
    if (!Object.hasOwn(nextScripts, name)) {
      nextScripts[name] = command;
      added.push(name);
    } else if (nextScripts[name] !== command) {
      conflicts.push({ name, existing: nextScripts[name] });
    }
  }

  if (added.length === 0) return { status: 'unchanged', added, conflicts };
  return { status: 'update', content: stringify({ ...data, scripts: nextScripts }), added, conflicts };
}

// --- git post-merge hook -----------------------------------------------------

/** Our hook block, sentinel-wrapped so it is recognisable and re-run safe. */
export function hookSnippet() {
  return `${HOOK_BEGIN}\n`
    + '# Refresh the loregraph graph after a pull — a no-op when it is current.\n'
    + `${HOOK_COMMAND}\n`
    + `${HOOK_END}\n`;
}

/**
 * Install a `post-merge` hook — but only when there is no hook at all. An
 * existing hook is somebody's working script; we never edit it, we hand back
 * the snippet for them to paste.
 */
export function planPostMergeHook(existing) {
  const snippet = hookSnippet();
  if (existing === null || existing === undefined) {
    return { status: 'create', content: `#!/bin/sh\n${snippet}`, snippet };
  }
  if (existing.includes(HOOK_BEGIN)) return { status: 'unchanged', snippet };
  return { status: 'conflict', snippet };
}

// --- loregraph.config.mjs ----------------------------------------------------

/** One short line per knob, so the generated file explains itself. */
const KNOB_COMMENTS = {
  srcRoots: 'Directories scanned for source files.',
  ignoreFile: 'Ignore rules applied to the scan.',
  tsconfig: 'tsconfig for the type-checking layers (null → auto-discover).',
  vcs: 'Revision source used for staleness checks.',
  outDir: 'Where the graph artifacts are written.',
  domains: 'Domain overlay (null → auto-derive from the directory tree).',
  incremental: 'Rebuild mode for the heavy type-checking layers.',
  compressPaths: 'Factor shared directory prefixes out of the path lists brief/impact print '
    + '(lossless; worth ~26-57% on a deep monorepo, ~2-10% on a shallow tree).',
};

/**
 * Defaults for `loregraph describe`, shown as a commented worked example.
 *
 * The command form comes first on purpose: it is the one path that bills no API
 * tokens, and it is the least discoverable without an example.
 */
const DESCRIBE_BLOCK = [
  '  // `loregraph describe` — cached, MODEL-WRITTEN descriptions. The only',
  '  // command that can cost money; it always estimates and asks first.',
  '  // describe: {',
  '  //   // Recommended: a CLI you already pay for. The prompt arrives on its',
  '  //   // stdin; the description is read from its stdout.',
  '  //   command: \'your-llm-cli --quiet\',',
  '  //   // Otherwise ANTHROPIC_API_KEY or OPENAI_API_KEY is used, in that order.',
  '  //   model: undefined,          // provider default when unset',
  '  //   scope: \'domains\',           // domains | files | symbols | all',
  '  //   top: undefined,            // cap per kind, by importance',
  '  //   timeoutMs: 60000,          // per item',
  '  //   // Your own rates, so the estimate can quote a real figure instead of',
  '  //   // "unknown" (USD per million tokens).',
  '  //   pricing: { input: 0, output: 0 },',
  '  // },',
  '',
];

/** A JS literal for a config value (only the shapes `DEFAULTS` actually uses). */
function literal(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(value);
}

/**
 * Render `loregraph.config.mjs`: the detected values live, every other knob
 * commented out at its REAL default (read straight from `DEFAULTS`, so this file
 * cannot drift from the code), each with a one-line explanation.
 */
export function renderConfigFile({ projectName, srcRoots, outDir }) {
  const detected = outDir === undefined ? { srcRoots } : { srcRoots, outDir };
  const lines = [
    `// loregraph configuration for "${projectName}" — generated by \`loregraph init\`.`,
    '//',
    '// Anything set here overrides a built-in default. The commented-out entries',
    '// show the defaults, so the knobs are discoverable without leaving the file.',
    '',
    'export default {',
  ];

  for (const [key, value] of Object.entries(DEFAULTS)) {
    lines.push(`  // ${KNOB_COMMENTS[key] ?? key}`);
    lines.push(Object.hasOwn(detected, key)
      ? `  ${key}: ${literal(detected[key])},`
      : `  // ${key}: ${literal(value)},`);
    lines.push('');
  }

  // `describe` is a nested object rather than a scalar default, so it gets a
  // worked example instead of a `// describe: {}` line that teaches nothing.
  // `command` leads because it is the path that costs no API tokens.
  lines.push(...DESCRIBE_BLOCK);

  lines[lines.length - 1] = '};';
  return `${lines.join('\n')}\n`;
}
