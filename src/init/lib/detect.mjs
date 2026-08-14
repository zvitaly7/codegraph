// Project detection for `loregraph init` — everything the command needs to know
// about someone else's repo BEFORE it asks a single question.
//
// Pure-ish by design: the only side effect is reading the filesystem, and every
// helper degrades to a harmless answer (empty list, `exists: false`) instead of
// throwing, because `init` must never blow up on a repo shaped unexpectedly.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULTS } from '../../config/defaults.mjs';

/** Directories that hold source in the overwhelming majority of JS/TS repos. */
export const PREFERRED_SRC_ROOTS = ['src', 'app', 'lib', 'packages'];

/** Top-level directories that are never a source root worth scanning. */
const NOISE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'output', 'coverage', 'vendor',
  'tmp', 'temp', 'public', 'static', 'assets', 'docs', 'doc', 'fixtures',
  'target', 'bower_components', 'venv',
]);

/** The name of the MCP entry we write into agent configs. */
export const MCP_SERVER_NAME = 'loregraph';

/**
 * A stdio entry that works with no global install: `npx -y loregraph mcp`.
 * The server reads the cache from the client's working directory, which every
 * MCP client sets to the project root.
 */
export const MCP_SERVER_ENTRY = { command: 'npx', args: ['-y', 'loregraph', 'mcp'] };

/**
 * The agent configs we know how to wire, and — crucially — the TOP-LEVEL KEY
 * each client actually reads. They are not the same:
 *   • Claude Code (`.mcp.json`)      → `mcpServers`
 *   • Cursor      (`.cursor/mcp.json`) → `mcpServers`
 *   • VS Code     (`.vscode/mcp.json`) → `servers` (alongside an optional `inputs`)
 * Writing `mcpServers` into a VS Code file silently does nothing, so the key
 * travels with the client descriptor rather than being hard-coded in the writer.
 */
export const MCP_CLIENTS = [
  { id: 'claude', label: 'Claude Code', file: '.mcp.json', key: 'mcpServers' },
  { id: 'cursor', label: 'Cursor', file: '.cursor/mcp.json', key: 'mcpServers' },
  { id: 'vscode', label: 'VS Code', file: '.vscode/mcp.json', key: 'servers' },
];

/** Config file names `resolveConfig` picks up, in the order it checks them. */
export const CONFIG_FILES = ['loregraph.config.mjs', 'loregraph.config.json'];

/** Immediate subdirectories that could plausibly hold source, sorted by name. */
export function listTopLevelDirs(repoRoot) {
  let entries;
  try {
    entries = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.') && !NOISE_DIRS.has(name))
    .sort();
}

/**
 * Choose `srcRoots` from the directories that actually exist.
 *
 * Preferred roots win, in canonical order. Otherwise we fall back to the
 * built-in default (`['src']`) and hand back the real directories as
 * `candidates` so an interactive run can offer them.
 */
export function pickSrcRoots(dirs) {
  const preferred = PREFERRED_SRC_ROOTS.filter((name) => dirs.includes(name));
  if (preferred.length > 0) return { srcRoots: preferred, candidates: preferred, usedFallback: false };
  return { srcRoots: [...DEFAULTS.srcRoots], candidates: [...dirs], usedFallback: true };
}

/** Read `package.json` without throwing: absence and bad JSON are both reported. */
export function readPackageJson(repoRoot) {
  const path = join(repoRoot, 'package.json');
  if (!existsSync(path)) return { path, exists: false };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { path, exists: true, error: err.message };
  }
  try {
    return { path, exists: true, raw, data: JSON.parse(raw) };
  } catch (err) {
    return { path, exists: true, raw, error: err.message };
  }
}

/** Every known agent config, each marked with whether it is already present. */
export function detectAgentConfigs(repoRoot) {
  return MCP_CLIENTS.map((client) => ({
    ...client,
    path: join(repoRoot, client.file),
    exists: existsSync(join(repoRoot, client.file)),
  }));
}

/** True when `path` exists and is a directory. */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Everything `init` reports before it asks anything: project name, source roots,
 * TypeScript, git, existing agent configs and any loregraph config already here.
 */
export function detectProject({ repoRoot }) {
  const pkg = readPackageJson(repoRoot);
  const dirs = listTopLevelDirs(repoRoot);
  const picked = pickSrcRoots(dirs);
  const tsconfigPath = join(repoRoot, 'tsconfig.json');
  const configFile = CONFIG_FILES.find((name) => existsSync(join(repoRoot, name)));

  return {
    repoRoot,
    projectName: (typeof pkg.data?.name === 'string' && pkg.data.name) || basename(repoRoot),
    hasPackageJson: pkg.exists,
    packageJsonError: pkg.error,
    packageScripts: pkg.data?.scripts,
    topLevelDirs: dirs,
    srcRoots: picked.srcRoots,
    srcRootCandidates: picked.candidates,
    usedFallbackSrcRoots: picked.usedFallback,
    hasTsconfig: existsSync(tsconfigPath),
    tsconfigPath,
    // A worktree/submodule keeps `.git` as a FILE; hooks then live elsewhere, so
    // only a real `.git` directory counts as somewhere we can install a hook.
    isGitRepo: existsSync(join(repoRoot, '.git')),
    gitHooksDir: isDir(join(repoRoot, '.git')) ? join(repoRoot, '.git', 'hooks') : null,
    agentConfigs: detectAgentConfigs(repoRoot),
    hasConfigFile: configFile !== undefined,
    configFile: configFile ?? CONFIG_FILES[0],
  };
}
