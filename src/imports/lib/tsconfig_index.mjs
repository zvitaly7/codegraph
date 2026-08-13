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
  /** @param {{repoRoot:string, tsconfigOverride?:string|null}} opts */
  constructor({ repoRoot, tsconfigOverride = null } = {}) {
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
    return DEFAULT_CONFIG;
  }

  _view(entry) {
    return {
      paths: entry.paths,
      pathsBase: entry.pathsBase,
      baseUrl: entry.baseUrl,
      configPath: entry.configPath,
    };
  }
}
