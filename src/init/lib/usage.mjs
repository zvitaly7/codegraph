// Usage text for `loregraph init` — the single source of truth for both its own
// usage-error output (run.mjs) and `loregraph init --help` (the bin dispatcher's
// help registry), so the two can never drift apart.
//
// Pure: a template string built from DEFAULTS. No I/O, no imports beyond the
// plain config-defaults data module — safe to import from the CLI dispatcher's
// fast `--help` path, which must never load the command module itself.

import { DEFAULTS } from '../../config/defaults.mjs';

export const USAGE = `loregraph init [options]

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
