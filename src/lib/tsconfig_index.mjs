// Discover and index tsconfig.json files so the resolver can look up the
// nearest-enclosing `baseUrl` / `paths` for any source file.
//
// Primary parse path: ts.readConfigFile (JSONC-aware) + parseJsonConfigFileContent
// (resolves `extends`, makes baseUrl absolute). If TS fails to read the file we
// fall back to a tolerant JSON parse that only recovers compilerOptions
// baseUrl / paths. When no tsconfig applies we return a bundler-ish default
// (no aliases) so relative and bare resolution still work.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import ts from 'typescript';

const SKIP_DIRS = new Set(['node_modules', '.git']);

const DEFAULT_CONFIG = Object.freeze({
  paths: {}, pathsBase: undefined, baseUrl: undefined, configPath: null,
});

// A parse host that never enumerates directories — we only care about
// compilerOptions, not the include/files globs (which would be slow).
const PARSE_HOST = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: () => [],
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
};

/** Strip // and /* *\/ comments and trailing commas, then JSON.parse. */
function tolerantJsonParse(text) {
  try {
    const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLine = noBlock.replace(/(^|[^:])\/\/.*$/gm, '$1');
    const noTrailingCommas = noLine.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(noTrailingCommas);
  } catch {
    return {};
  }
}

/** Parse one tsconfig into { configPath, configDir, baseUrl, paths, pathsBase }. */
function parseTsconfig(configPath) {
  const configDir = dirname(configPath);
  let baseUrl;
  let paths;

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (!read.error && read.config) {
    const parsed = ts.parseJsonConfigFileContent(read.config, PARSE_HOST, configDir);
    baseUrl = parsed.options.baseUrl; // already absolute (or undefined)
    paths = parsed.options.paths;
  } else {
    const raw = tolerantJsonParse(readFileSync(configPath, 'utf8'));
    const co = raw.compilerOptions ?? {};
    baseUrl = co.baseUrl ? resolve(configDir, co.baseUrl) : undefined;
    paths = co.paths;
  }

  return {
    configPath,
    configDir,
    baseUrl,
    paths: paths ?? {},
    pathsBase: baseUrl ?? configDir,
  };
}

/** Recursively collect tsconfig.json paths, skipping node_modules/.git. */
function discover(rootDir) {
  const found = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile() && entry.name === 'tsconfig.json') {
        found.push(join(dir, entry.name));
      }
    }
  }
  return found;
}

/** True when `dir` is at or inside `base`. */
function contains(base, dir) {
  const rel = relative(base, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class TsconfigIndex {
  /**
   * @param {object} opts
   * @param {string} opts.repoRoot
   * @param {string|null} [opts.tsconfigOverride]
   * @param {object|null} [opts.configPaths] alias table from loregraph.config,
   *   same shape as tsconfig `paths`. Used for the files whose nearest tsconfig
   *   declares no paths of its own — including repositories that have no
   *   tsconfig at all, where it is the only way to state the mapping.
   * @param {string|null} [opts.configPathsBase] base for `configPaths`,
   *   resolved against the repo root; defaults to the repo root itself.
   */
  constructor({
    repoRoot, tsconfigOverride = null, configPaths = null, configPathsBase = null,
  } = {}) {
    this._configPaths = configPaths && Object.keys(configPaths).length > 0 ? configPaths : null;
    this._configPathsBase = this._configPaths
      ? resolve(repoRoot, configPathsBase ?? '.')
      : null;
    if (tsconfigOverride) {
      this._override = parseTsconfig(resolve(repoRoot, tsconfigOverride));
      this._entries = [];
    } else {
      this._override = null;
      // Longest configDir first → first containing match is the nearest.
      this._entries = discover(repoRoot)
        .map(parseTsconfig)
        .sort((a, b) => b.configDir.length - a.configDir.length);
    }
  }

  /** Nearest-enclosing { paths, pathsBase, baseUrl, configPath } for a file. */
  forFile(absFile) {
    if (this._override) return this._view(this._override);
    const fileDir = dirname(absFile);
    for (const entry of this._entries) {
      if (contains(entry.configDir, fileDir)) return this._view(entry);
    }
    return this._withConfigPaths(DEFAULT_CONFIG);
  }

  _view(entry) {
    return this._withConfigPaths({
      paths: entry.paths,
      pathsBase: entry.pathsBase,
      baseUrl: entry.baseUrl,
      configPath: entry.configPath,
    });
  }

  /**
   * Precedence is per alias pattern, not all-or-nothing: a tsconfig keeps every
   * pattern it declares, and the config table supplies the ones it never
   * mentioned. A per-package tsconfig typically maps that package's own
   * internal aliases and says nothing about its siblings, so an all-or-nothing
   * rule would silence the config table exactly where it is needed.
   *
   * Both tables share one `pathsBase`, so the config entries are pre-rebased
   * onto the tsconfig's base when the two differ.
   */
  _withConfigPaths(view) {
    if (!this._configPaths) return view;
    const own = view.paths ?? {};
    const base = view.pathsBase ?? this._configPathsBase;
    const merged = { ...own };
    for (const [pattern, targets] of Object.entries(this._configPaths)) {
      if (pattern in own) continue; // the tsconfig said it first
      merged[pattern] = base === this._configPathsBase
        ? targets
        : targets.map((t) => relative(base, resolve(this._configPathsBase, t)) || '.');
    }
    return { ...view, paths: merged, pathsBase: base };
  }
}
