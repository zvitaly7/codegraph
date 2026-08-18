#!/usr/bin/env node
import process from 'node:process';
import { formatMainUsage, formatCommandHelp, wantsHelp } from './lib/help.mjs';

const COMMANDS = {
  init: () => import('../src/init/run.mjs'),
  inventory: () => import('../src/inventory/run.mjs'),
  imports: () => import('../src/imports/run.mjs'),
  symbols: () => import('../src/symbols/run.mjs'),
  references: () => import('../src/references/run.mjs'),
  usages: () => import('../src/usages/run.mjs'),
  domains: () => import('../src/domains/run.mjs'),
  brief: () => import('../src/brief/run.mjs'),
  outline: () => import('../src/outline/run.mjs'),
  show: () => import('../src/show/run.mjs'),
  impact: () => import('../src/impact/run.mjs'),
  cycles: () => import('../src/cycles/run.mjs'),
  check: () => import('../src/check/run.mjs'),
  describe: () => import('../src/describe/run.mjs'),
  explorer: () => import('../src/explorer/run.mjs'),
  docs: () => import('../src/docs/run.mjs'),
  mcp: () => import('../src/mcp/run.mjs'),
  regenerate: () => import('../src/orchestrate/regenerate.mjs'),
};

const USAGE = formatMainUsage();

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 2);
  }
  const loader = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!loader) {
    console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(2);
  }

  // `--help`/`-h` anywhere in the sub-command's own args prints ITS help and
  // exits 0 — checked before the command module is ever imported, so a help
  // request can never run the layer or write cache artifacts.
  if (wantsHelp(rest)) {
    console.log(formatCommandHelp(cmd));
    process.exit(0);
  }

  const mod = await loader();
  const code = await mod.run(rest);
  process.exit(typeof code === 'number' ? code : 0);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
