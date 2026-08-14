#!/usr/bin/env node
import process from 'node:process';

const COMMANDS = {
  inventory: () => import('../src/inventory/run.mjs'),
  imports: () => import('../src/imports/run.mjs'),
  symbols: () => import('../src/symbols/run.mjs'),
  references: () => import('../src/references/run.mjs'),
  usages: () => import('../src/usages/run.mjs'),
  domains: () => import('../src/domains/run.mjs'),
  brief: () => import('../src/brief/run.mjs'),
  impact: () => import('../src/impact/run.mjs'),
  explorer: () => import('../src/explorer/run.mjs'),
  docs: () => import('../src/docs/run.mjs'),
  mcp: () => import('../src/mcp/run.mjs'),
  regenerate: () => import('../src/orchestrate/regenerate.mjs'),
};

const USAGE = `codegraph <command> [options]

Commands:
  regenerate   Build the whole graph in dependency order
  inventory    Layer 1: files + directories
  imports      Layer 2a: file → file/package imports
  symbols      Layer 2b: declarations
  references   Layer 2c: file → symbol
  usages       Layer 2d: symbol → symbol
  domains      Layer 3: semantic domain overlay
  brief        Context pack for a file / domain / symbol
  impact       Blast radius + likely tests for a diff
  explorer     Build (and optionally serve) the browser index
  docs         Generate AGENTS.md + Markdown docs from the graph
  mcp          Start the stdio MCP server

Global: --repo-root PATH  --out DIR  --config FILE  --help`;

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
  const mod = await loader();
  const code = await mod.run(rest);
  process.exit(typeof code === 'number' ? code : 0);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
