// Discover the packages of a workspace monorepo, so a sibling import like
// `@myorg/ui` can be resolved to a file in THIS repo instead of being written
// off as a third-party package.
//
// Two declaration sources, both read from the repo root and both optional:
//   * `package.json` `workspaces` — the array form `["packages/*"]` and the
//     object form `{ "packages": ["packages/*"] }` (npm / yarn / bun),
//   * `pnpm-workspace.yaml` — its `packages:` list, parsed by hand (block and
//     inline flow form) so the tool keeps its two-dependency footprint.
//
// Patterns are expanded against the filesystem: `*` matches one directory
// segment, `**` any depth, a glob-free path is taken literally, and a leading
// `!` excludes. `node_modules` / `.git` are never entered. Every matched
// directory that has a `package.json` with a `name` becomes a package; the rest
// are skipped silently (a workspace glob routinely matches more than it means).
//
// The result is plain data — repo-relative POSIX paths, packages sorted by name
// — so the import resolver stays a pure lexical function over the inventory.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { normPosix } from '../inventory/schema.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** How deep `**` is allowed to descend — a guard against pathological trees. */
const MAX_GLOB_DEPTH = 8;

/**
 * Condition keys of an `exports` entry, most source-like first. A monorepo that
 * points `types`/`source` at TypeScript and `import` at a build output resolves
 * to the source file, which is the one the inventory actually contains.
 */
const EXPORT_CONDITIONS = ['source', 'development', 'types', 'import', 'module', 'default', 'require', 'node'];

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // absent or malformed — a repo is not obliged to be well-formed
  }
}

/** `./src/index.ts` → `src/index.ts`; anything not a usable path → null. */
function cleanTarget(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const norm = normPosix(value).replace(/^\.\//, '');
  return norm === '' || norm === '.' ? null : norm;
}

/** Join a package-relative target onto the package dir, repo-relative. */
function underDir(dir, target) {
  return dir === '.' ? target : `${dir}/${target}`;
}

/**
 * Every string target reachable under an `exports` value, in condition order.
 * Handles the string form, a condition object, and nested condition objects.
 */
function conditionTargets(value, seen = []) {
  if (typeof value === 'string') {
    const t = cleanTarget(value);
    if (t && !seen.includes(t)) seen.push(t);
    return seen;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return seen;
  const keys = Object.keys(value);
  const ordered = [
    ...EXPORT_CONDITIONS.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !EXPORT_CONDITIONS.includes(k)).sort(),
  ];
  for (const key of ordered) conditionTargets(value[key], seen);
  return seen;
}

/**
 * Split an `exports` field into the `.` entry targets and the explicit subpath
 * targets (keyed without the leading `./`). A bare string or a condition-only
 * object is the `.` entry.
 */
function splitExports(exportsField) {
  const entries = [];
  const subpaths = {};
  if (typeof exportsField === 'string') {
    return { entries: conditionTargets(exportsField), subpaths };
  }
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    return { entries, subpaths };
  }
  const keys = Object.keys(exportsField);
  const isSubpathMap = keys.some((k) => k === '.' || k.startsWith('./'));
  if (!isSubpathMap) return { entries: conditionTargets(exportsField), subpaths };
  for (const key of keys) {
    const targets = conditionTargets(exportsField[key]);
    if (targets.length === 0) continue;
    if (key === '.') entries.push(...targets);
    else if (key.startsWith('./')) subpaths[key.slice(2)] = targets;
  }
  return { entries, subpaths };
}

/** Every `bin` target: the string form and the `{ name: path }` map. */
function binTargets(bin) {
  if (typeof bin === 'string') {
    const t = cleanTarget(bin);
    return t ? [t] : [];
  }
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return [];
  const out = [];
  for (const key of Object.keys(bin).sort()) {
    const t = cleanTarget(bin[key]);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Read one `package.json` into the shape the resolver and the entry-point
 * collector need. All paths are repo-relative POSIX.
 *
 * @param {string} repoRoot absolute repo root.
 * @param {string} dirRel   package directory, repo-relative ('.' for the root).
 * @returns {{name:string|null, dir:string, entries:string[], subpaths:Record<string,string[]>, bin:string[]}|null}
 */
export function readPackageManifest(repoRoot, dirRel) {
  const dir = normPosix(dirRel);
  const pkg = readJsonFile(join(repoRoot, dir === '.' ? 'package.json' : `${dir}/package.json`));
  if (!pkg || typeof pkg !== 'object') return null;

  const { entries: exportEntries, subpaths: exportSubpaths } = splitExports(pkg.exports);
  const entries = [...exportEntries];
  for (const field of [pkg.module, pkg.main]) {
    const t = cleanTarget(field);
    if (t && !entries.includes(t)) entries.push(t);
  }

  const subpaths = {};
  for (const [key, targets] of Object.entries(exportSubpaths)) {
    subpaths[key] = targets.map((t) => underDir(dir, t));
  }

  return {
    name: typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : null,
    dir,
    entries: entries.map((t) => underDir(dir, t)),
    subpaths,
    bin: binTargets(pkg.bin).map((t) => underDir(dir, t)),
  };
}

/** The `workspaces` patterns of a root package.json, both declared forms. */
function packageJsonPatterns(repoRoot) {
  const pkg = readJsonFile(join(repoRoot, 'package.json'));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((p) => typeof p === 'string');
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) {
    return ws.packages.filter((p) => typeof p === 'string');
  }
  return [];
}

/** Strip surrounding quotes and a trailing ` # comment` from a YAML scalar. */
function yamlScalar(raw) {
  const s = raw.trim();
  if (s.startsWith("'") || s.startsWith('"')) {
    const quote = s[0];
    const end = s.indexOf(quote, 1);
    return end === -1 ? s.slice(1) : s.slice(1, end);
  }
  return s.split('#')[0].trim();
}

/** Split an inline flow sequence `[a, 'b']` into its scalars. */
function yamlFlowSequence(body) {
  return body
    .split(',')
    .map((part) => yamlScalar(part))
    .filter((s) => s.length > 0);
}

/**
 * The `packages:` list of a pnpm-workspace.yaml — a deliberately minimal,
 * forgiving parse (no YAML dependency): the top-level `packages:` key, then
 * either an inline flow sequence or the `- item` block that follows it,
 * stopping at the first line that is neither a list item, blank nor a comment.
 */
function pnpmPatterns(repoRoot) {
  const path = join(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const line of lines) {
    if (!inList) {
      const head = /^packages\s*:(.*)$/.exec(line);
      if (!head) continue;
      const rest = head[1].trim();
      const flow = /^\[(.*)\]$/.exec(rest);
      if (flow) return yamlFlowSequence(flow[1]);
      if (rest.length > 0 && !rest.startsWith('#')) continue; // scalar, not a list
      inList = true;
      continue;
    }
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      const value = yamlScalar(item[1]);
      if (value.length > 0) out.push(value);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    break; // a sibling key ends the list
  }
  return out;
}

/** Directory names directly under `dirRel`, node_modules/.git excluded. */
function subdirs(repoRoot, dirRel) {
  const abs = dirRel === '.' ? repoRoot : join(repoRoot, dirRel);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
}

/** Expand one workspace pattern to the repo-relative directories it matches. */
function expandPattern(repoRoot, pattern) {
  const segments = normPosix(pattern).replace(/^\.\//, '').split('/').filter((s) => s !== '');
  if (segments.length === 0) return [];

  let current = ['.'];
  for (const segment of segments) {
    const next = [];
    if (segment === '**') {
      // `**` keeps the current dirs and adds every descendant, depth-capped.
      const seen = new Set(current);
      let frontier = current;
      for (let depth = 0; depth < MAX_GLOB_DEPTH && frontier.length > 0; depth += 1) {
        const deeper = [];
        for (const dir of frontier) {
          for (const name of subdirs(repoRoot, dir)) {
            const child = dir === '.' ? name : `${dir}/${name}`;
            if (seen.has(child)) continue;
            seen.add(child);
            deeper.push(child);
          }
        }
        frontier = deeper;
      }
      next.push(...seen);
    } else if (segment.includes('*')) {
      const re = new RegExp(`^${segment.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      for (const dir of current) {
        for (const name of subdirs(repoRoot, dir)) {
          if (re.test(name)) next.push(dir === '.' ? name : `${dir}/${name}`);
        }
      }
    } else {
      for (const dir of current) {
        const child = dir === '.' ? segment : `${dir}/${segment}`;
        if (existsSync(join(repoRoot, child))) next.push(child);
      }
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current.filter((d) => d !== '.');
}

/**
 * Discover the workspace packages of `repoRoot`.
 *
 * @param {string} repoRoot absolute repo root.
 * @returns {{sources:string[], packages:object[], byName:Map<string,object>}}
 *   `sources` names the declaration files that contributed (empty → not a
 *   workspace repo, and every caller must behave exactly as it did before).
 */
export function discoverWorkspaces(repoRoot) {
  const sources = [];
  const patterns = [];

  const fromPackageJson = packageJsonPatterns(repoRoot);
  if (fromPackageJson.length > 0) {
    sources.push('package.json');
    patterns.push(...fromPackageJson);
  }
  const fromPnpm = pnpmPatterns(repoRoot);
  if (fromPnpm.length > 0) {
    sources.push('pnpm-workspace.yaml');
    patterns.push(...fromPnpm);
  }

  if (patterns.length === 0) return { sources: [], packages: [], byName: new Map() };

  const included = new Set();
  const excluded = new Set();
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const target = negated ? excluded : included;
    for (const dir of expandPattern(repoRoot, negated ? pattern.slice(1) : pattern)) target.add(dir);
  }

  const packages = [];
  const byName = new Map();
  for (const dir of [...included].filter((d) => !excluded.has(d)).sort()) {
    const pkg = readPackageManifest(repoRoot, dir);
    if (!pkg || !pkg.name || byName.has(pkg.name)) continue;
    packages.push(pkg);
    byName.set(pkg.name, pkg);
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { sources, packages, byName };
}
