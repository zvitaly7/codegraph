// `loregraph init` — set up loregraph in someone else's project.
//
// This is the one command that writes OUTSIDE our own cache directory, so it is
// built to be boring and safe:
//
//   • it never overwrites or truncates an existing file — JSON is merged,
//     text is appended to, and anything already there is left exactly as it is;
//   • running it twice changes nothing the second time (no duplicate ignore
//     line, no duplicate script, no duplicate MCP entry, no duplicated hook);
//   • when something exists with content we did not write, we leave it and say
//     so rather than "fixing" it;
//   • `--dry-run` prints the exact plan and writes nothing at all.
//
// Interactive by default (one question per step, Enter accepts the default).
// `--yes`, or a non-TTY stdin (CI), takes every default and asks nothing.
//
// Deliberately NOT loading the project's `loregraph.config.mjs`: `init` runs on
// projects that are not configured yet, and a broken config in the target repo
// must not stop the command whose job is to set that config up.
//
// Exit codes: 0 done · 1 a write or the optional build failed · 2 usage error.

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import process from 'node:process';
import { DEFAULTS } from '../config/defaults.mjs';
import { writeTextAtomic } from '../inventory/write.mjs';
import { MCP_CLIENTS, MCP_SERVER_ENTRY, MCP_SERVER_NAME, detectProject } from './lib/detect.mjs';
import {
  GITIGNORE_COMMENT,
  INIT_SCRIPTS,
  planGitignore,
  planJsonServerEntry,
  planPackageScripts,
  planPostMergeHook,
  renderConfigFile,
} from './lib/writers.mjs';

const USAGE = `loregraph init [options]

Sets a project up: config file, ignored cache dir, an MCP entry for your AI
agent, npm scripts, and optionally a git hook that refreshes the graph on pull.

Options:
  -y, --yes          take every default and ask nothing (automatic when stdin is not a TTY)
      --dry-run      print the planned actions and write nothing
      --repo-root P  the project to set up (default: the current directory)
      --out DIR      graph cache directory (default: <repo>/${DEFAULTS.outDir})
      --hook         install the git post-merge hook without asking
      --build        build the graph when done (non-interactive runs skip it otherwise)
      --no-build     never build the graph`;

const OPTIONS = {
  'repo-root': { type: 'string' },
  out: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  hook: { type: 'boolean' },
  build: { type: 'boolean' },
  'no-build': { type: 'boolean' },
};

/** Verbs used in the action list; `--dry-run` says "would …" for the two that write. */
const DRY_VERB = { created: 'would create', updated: 'would update' };

const say = (line = '') => console.log(line);
const posix = (p) => p.split(sep).join('/');

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Current contents of a file, or `null` when it does not exist. */
function readOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Questions, or silence. In non-interactive mode nothing is read from stdin and
 * every answer is the default, so CI never hangs. The readline interface is
 * created lazily — a `--yes` run never opens stdin at all.
 */
function createPrompter(interactive, { input, output }) {
  let rl = null;
  const ask = async (question) => {
    if (!rl) {
      const { createInterface } = await import('node:readline/promises');
      rl = createInterface({ input, output });
    }
    return rl.question(question);
  };

  return {
    interactive,
    /** yes/no, Enter accepts `fallback`. */
    async confirm(question, fallback) {
      if (!interactive) return fallback;
      try {
        const answer = (await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
        if (answer === '') return fallback;
        return answer === 'y' || answer === 'yes';
      } catch {
        return fallback; // stdin closed mid-question — behave like Enter
      }
    },
    /** free text, Enter accepts `fallback`. */
    async text(question, fallback) {
      if (!interactive) return fallback;
      try {
        const answer = (await ask(`${question} [${fallback}] `)).trim();
        return answer === '' ? fallback : answer;
      } catch {
        return fallback;
      }
    },
    close() {
      rl?.close();
    },
  };
}

/**
 * @param {string[]} argv
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [io]
 *   Prompt streams — injectable so the interactive flow is testable without a TTY.
 */
export async function run(argv, io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: false, options: OPTIONS });
  } catch (err) {
    console.error(`init: usage error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  const flags = parsed.values;
  if (parsed.positionals.length > 0) {
    console.error(`init: unexpected argument "${parsed.positionals[0]}"\n\n${USAGE}`);
    return 2;
  }

  const cwd = process.cwd();
  const repoRoot = resolve(cwd, flags['repo-root'] ?? '.');
  if (!isDirectory(repoRoot)) {
    console.error(`init: --repo-root is not a directory: ${repoRoot}`);
    return 2;
  }

  const dryRun = flags['dry-run'] === true;
  // A non-TTY stdin (CI, a pipe, a test) is treated exactly like --yes.
  const interactive = flags.yes !== true && Boolean(input.isTTY);
  const prompt = createPrompter(interactive, { input, output });

  const outDir = flags.out ? resolve(cwd, flags.out) : join(repoRoot, DEFAULTS.outDir);
  const relOut = relative(repoRoot, outDir);
  const cacheInsideRepo = relOut !== '' && !relOut.startsWith('..') && !isAbsolute(relOut);

  // Every touched file lands here: { path, action, detail }.
  const actions = [];
  const record = (path, action, detail) => actions.push({ path, action, detail });
  // Anything the user has to do by hand, printed after the summary.
  const notes = [];

  /** Write unless this is a dry run; a failed write is recorded, never thrown. */
  const put = (absPath, content, { mode, action, detail } = {}) => {
    const shown = posix(relative(repoRoot, absPath));
    if (!dryRun) {
      try {
        writeTextAtomic(absPath, content);
        if (mode !== undefined) chmodSync(absPath, mode);
      } catch (err) {
        record(shown, 'failed', err.message);
        return false;
      }
    }
    record(shown, action, detail);
    return true;
  };

  try {
    const project = detectProject({ repoRoot });

    // --- Step 1: report what is here, before asking anything ---------------
    say(`loregraph init — ${repoRoot}`);
    if (dryRun) say('Dry run: nothing will be written.');
    say();
    say('Detected');
    const field = (label, value) => say(`  ${label.padEnd(14)} ${value}`);
    field('project', project.hasPackageJson
      ? `${project.projectName} (package.json)`
      : `${project.projectName} (no package.json)`);
    field('source roots', project.srcRoots.join(', ')
      + (project.usedFallbackSrcRoots ? ' (default — none of src/app/lib/packages found)' : ''));
    if (project.usedFallbackSrcRoots && project.srcRootCandidates.length > 0) {
      field('top-level dirs', project.srcRootCandidates.join(', '));
    }
    field('tsconfig', project.hasTsconfig ? 'tsconfig.json' : 'none');
    field('git', project.isGitRepo ? 'yes' : 'no');
    const foundConfigs = project.agentConfigs.filter((c) => c.exists);
    field('agent configs', foundConfigs.length > 0
      ? foundConfigs.map((c) => `${c.file} (${c.label})`).join(', ')
      : 'none found');
    if (project.packageJsonError) field('warning', `package.json is not valid JSON: ${project.packageJsonError}`);
    say();

    // --- Step 2: loregraph.config.mjs --------------------------------------
    let srcRoots = project.srcRoots;
    if (project.hasConfigFile) {
      record(project.configFile, 'unchanged', 'already exists — left untouched');
    } else if (await prompt.confirm(`Write ${project.configFile}?`, true)) {
      const answer = await prompt.text('  source roots to scan (comma-separated)', srcRoots.join(', '));
      srcRoots = answer.split(',').map((s) => s.trim()).filter(Boolean);
      if (srcRoots.length === 0) srcRoots = [...DEFAULTS.srcRoots];
      put(join(repoRoot, project.configFile), renderConfigFile({
        projectName: project.projectName,
        srcRoots,
        // Only worth recording when it is not the built-in default.
        outDir: cacheInsideRepo && posix(relOut) !== DEFAULTS.outDir ? posix(relOut) : undefined,
      }), { action: 'created', detail: `srcRoots: ${srcRoots.join(', ')}` });
    } else {
      record(project.configFile, 'skipped', 'declined');
    }

    // --- Step 3: .gitignore -------------------------------------------------
    const ignorePath = join(repoRoot, '.gitignore');
    if (!cacheInsideRepo) {
      record('.gitignore', 'skipped', `cache dir is outside the repo (${outDir})`);
    } else {
      const entry = `${posix(relOut)}/`;
      const plan = planGitignore(readOrNull(ignorePath), { entry, comment: GITIGNORE_COMMENT });
      if (plan.status === 'unchanged') {
        record('.gitignore', 'unchanged', `already ignores ${entry}`);
      } else if (await prompt.confirm(`Add ${entry} to .gitignore?`, true)) {
        put(ignorePath, plan.content, {
          action: plan.status === 'create' ? 'created' : 'updated',
          detail: `ignores ${entry}`,
        });
      } else {
        record('.gitignore', 'skipped', 'declined');
      }
    }

    // --- Step 4: the MCP server, in whatever agent config this project uses --
    const targets = [];
    if (foundConfigs.length > 0) {
      for (const client of foundConfigs) {
        if (await prompt.confirm(`Add the loregraph MCP server to ${client.file} (${client.label})?`, true)) {
          targets.push(client);
        } else {
          record(client.file, 'skipped', 'declined');
        }
      }
    } else {
      const [fallback] = MCP_CLIENTS;
      const choices = MCP_CLIENTS.map((c) => c.file).join(' | ');
      const answer = await prompt.text(
        `No agent config found. Create one for the MCP server?\n  ${choices} | none`,
        fallback.file,
      );
      const chosen = MCP_CLIENTS.find((c) => c.file === answer.trim() || c.id === answer.trim());
      if (chosen) targets.push(chosen);
      else record(answer.trim() === 'none' ? fallback.file : answer.trim(), 'skipped',
        answer.trim() === 'none' ? 'declined' : `unknown agent config "${answer.trim()}"`);
    }

    for (const client of targets) {
      const path = join(repoRoot, client.file);
      const plan = planJsonServerEntry(readOrNull(path), {
        key: client.key,
        name: MCP_SERVER_NAME,
        entry: MCP_SERVER_ENTRY,
      });
      if (plan.status === 'unchanged') {
        record(client.file, 'unchanged', `${client.key}.${MCP_SERVER_NAME} already configured`);
      } else if (plan.status === 'conflict') {
        record(client.file, 'skipped',
          `a different "${MCP_SERVER_NAME}" entry is already there (${JSON.stringify(plan.existingEntry)}) — left untouched`);
      } else if (plan.status === 'invalid') {
        record(client.file, 'skipped', `not valid JSON (${plan.reason}) — left untouched`);
      } else {
        put(path, plan.content, {
          action: plan.status === 'create' ? 'created' : 'updated',
          detail: `${client.key}.${MCP_SERVER_NAME} → npx -y loregraph mcp (${client.label})`,
        });
      }
    }

    // --- Step 5: npm scripts (silent when there is no package.json) ---------
    const pkgPath = join(repoRoot, 'package.json');
    // Scripts that end up running OUR commands — the ones worth suggesting.
    const ourScripts = new Set();
    if (project.hasPackageJson) {
      const plan = planPackageScripts(readOrNull(pkgPath) ?? '', INIT_SCRIPTS);
      const kept = plan.conflicts.map((c) => `kept your "${c.name}": ${c.existing}`).join('; ');
      // A script we did not write (a conflict) runs the user's command, not ours.
      const ours = Object.keys(INIT_SCRIPTS).filter((n) => !plan.conflicts.some((c) => c.name === n));
      if (plan.status === 'invalid') {
        record('package.json', 'skipped', `not valid JSON (${plan.reason}) — left untouched`);
      } else if (plan.status === 'unchanged') {
        record('package.json', 'unchanged', kept || `scripts ${Object.keys(INIT_SCRIPTS).join(', ')} already present`);
        for (const name of ours) ourScripts.add(name);
      } else if (await prompt.confirm(`Add npm scripts ${plan.added.join(', ')} to package.json?`, true)) {
        if (put(pkgPath, plan.content, {
          action: 'updated',
          detail: [`added ${plan.added.join(', ')}`, kept].filter(Boolean).join('; '),
        })) {
          for (const name of ours) ourScripts.add(name);
        }
      } else {
        record('package.json', 'skipped', 'declined');
      }
    }

    // --- Step 6: the post-merge hook (opt-in, never under --yes) ------------
    const hookRel = posix(join('.git', 'hooks', 'post-merge'));
    let wantHook = flags.hook === true;
    if (!wantHook && interactive) {
      wantHook = await prompt.confirm('Install a git post-merge hook that refreshes the graph after a pull?', false);
    }
    if (wantHook && !project.gitHooksDir) {
      record(hookRel, 'skipped', project.isGitRepo
        ? 'not a plain git repository (worktree or submodule) — install the hook manually'
        : 'not a git repository');
    } else if (wantHook) {
      const hookPath = join(project.gitHooksDir, 'post-merge');
      const plan = planPostMergeHook(readOrNull(hookPath));
      if (plan.status === 'unchanged') {
        record(hookRel, 'unchanged', 'our block is already installed');
      } else if (plan.status === 'conflict') {
        record(hookRel, 'skipped', 'a post-merge hook already exists — left untouched');
        notes.push(`${hookRel} already exists and was NOT modified. Add these lines to it yourself:`);
        notes.push(...plan.snippet.trimEnd().split('\n').map((line) => `    ${line}`));
      } else {
        put(hookPath, plan.content, { mode: 0o755, action: 'created', detail: 'refreshes the graph after `git pull`' });
      }
    }

    // --- Summary ------------------------------------------------------------
    const width = Math.max(...actions.map((a) => a.path.length), 12);
    say('Actions');
    for (const a of actions) {
      const verb = dryRun ? (DRY_VERB[a.action] ?? a.action) : a.action;
      say(`  ${verb.padEnd(13)} ${a.path.padEnd(width)}  ${a.detail}`);
    }
    const tally = (name) => actions.filter((a) => a.action === name).length;
    say();
    say(`Summary${dryRun ? ' (planned)' : ''}: created ${tally('created')} · updated ${tally('updated')} · `
      + `unchanged ${tally('unchanged')} · skipped ${tally('skipped')}`
      + (tally('failed') > 0 ? ` · failed ${tally('failed')}` : ''));

    if (notes.length > 0) {
      say();
      for (const note of notes) say(`  ${note}`);
    }

    // --- Step 7: build the graph now ----------------------------------------
    let buildCode = 0;
    let built = false;
    if (!dryRun && flags['no-build'] !== true) {
      const wantBuild = flags.build === true
        || (interactive && await prompt.confirm('Build the graph now?', true));
      if (wantBuild) {
        prompt.close();
        say();
        const { run: regenerate } = await import('../orchestrate/regenerate.mjs');
        buildCode = await regenerate(['--repo-root', repoRoot, '--out', outDir]);
        built = buildCode === 0;
      }
    }

    // --- What to do next ----------------------------------------------------
    const wired = actions.filter((a) => MCP_CLIENTS.some((c) => c.file === a.path)
      && (a.action === 'created' || a.action === 'updated' || a.action === 'unchanged'));
    const alias = (script) => (ourScripts.has(script) ? `   (or: npm run ${script})` : '');
    say();
    say('Next');
    if (!built) say(`  loregraph regenerate         # build the graph${alias('graph')}`);
    say(`  loregraph explorer --serve   # browse it at http://localhost:8765/${alias('graph:explore')}`);
    if (wired.length > 0) {
      say(`  The MCP server is wired into ${wired.map((a) => a.path).join(', ')} — `
        + 'restart your agent so it picks it up.');
    }

    if (tally('failed') > 0) return 1;
    if (buildCode !== 0) {
      console.error('init: the graph build failed — everything else was set up. Re-run `loregraph regenerate` to retry.');
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`init: ${err?.stack || err?.message || err}`);
    return 1;
  } finally {
    prompt.close();
  }
}
