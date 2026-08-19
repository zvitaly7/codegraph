import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { run } from './run.mjs';
import { loadDescriptions, pathForKind } from './lib/store.mjs';

// ---------------------------------------------------------------------------
// A fake provider: a tiny node script that echoes a canned line. No network
// call is made anywhere in this file — that is the point.
// ---------------------------------------------------------------------------

const CANNED_CLI = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const m = /^(DOMAIN|FILE|SYMBOL) (\\S+)/m.exec(input);
  process.stdout.write('Canned description of ' + (m ? m[2] : 'something') + '.\\n');
});
`;

const FLAKY_CLI = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (input.includes('DOMAIN util')) { process.stderr.write('model exploded\\n'); process.exit(7); }
  process.stdout.write('ok\\n');
});
`;

const COUNTING_CLI = (counter) => `
import { appendFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(counter)}, 'x');
  process.stdout.write('counted\\n');
});
`;

function cliFor(body) {
  const dir = mkdtempSync(join(tmpdir(), 'lg-desc-run-cli-'));
  const path = join(dir, 'fake.mjs');
  writeFileSync(path, body);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
}

// ---------------------------------------------------------------------------
// A small graph cache: two domains, three files, two symbols.
// ---------------------------------------------------------------------------

const edge = (type, from, to, properties = {}) => ({ id: `edge:${from}:${type}:${to}`, type, from, to, properties });
const fileNode = (path, sha = `sha-${path}`) => ({
  id: `file:${path}`,
  labels: ['File'],
  properties: { path, name: path.split('/').pop(), language: 'TypeScript', kind: 'code', sizeBytes: 10, sha256: sha },
});

function writeLayer(cache, layer, { nodes = [], edges = [] } = {}) {
  const dir = join(cache, layer);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), nodes.map((n) => JSON.stringify(n)).join('\n'));
  writeFileSync(join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n'));
}

function seed({ cartSha } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'lg-desc-run-repo-'));
  mkdirSync(join(repo, 'src', 'cart'), { recursive: true });
  mkdirSync(join(repo, 'src', 'util'), { recursive: true });
  writeFileSync(join(repo, 'src', 'cart', 'Cart.tsx'), 'export function Cart() { return 1; }\n');
  writeFileSync(join(repo, 'src', 'cart', 'total.ts'), 'export function total() { return 2; }\n');
  writeFileSync(join(repo, 'src', 'util', 'fmt.ts'), 'export const fmt = 3;\n');

  const cache = mkdtempSync(join(tmpdir(), 'lg-desc-run-cache-'));
  writeLayer(cache, 'inventory', {
    nodes: [
      fileNode('src/cart/Cart.tsx', cartSha),
      fileNode('src/cart/total.ts'),
      fileNode('src/util/fmt.ts'),
    ],
  });
  writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({ repoRoot: repo }));
  writeLayer(cache, 'imports', {
    edges: [edge('IMPORTS', 'file:src/cart/Cart.tsx', 'file:src/cart/total.ts', { kind: 'internal' })],
  });
  writeLayer(cache, 'symbols', {
    nodes: [
      { id: 'sym:src/cart/Cart.tsx#Cart', labels: ['Symbol'], properties: { name: 'Cart', path: 'src/cart/Cart.tsx', kind: 'function', exported: true, line: 1 } },
      { id: 'sym:src/cart/total.ts#total', labels: ['Symbol'], properties: { name: 'total', path: 'src/cart/total.ts', kind: 'function', exported: true, line: 1 } },
    ],
    edges: [
      edge('DECLARES', 'file:src/cart/Cart.tsx', 'sym:src/cart/Cart.tsx#Cart'),
      edge('DECLARES', 'file:src/cart/total.ts', 'sym:src/cart/total.ts#total'),
    ],
  });
  writeLayer(cache, 'domains', {
    nodes: [
      { id: 'domain:cart', labels: ['Domain'], properties: { name: 'cart', kind: 'product' } },
      { id: 'domain:util', labels: ['Domain'], properties: { name: 'util', kind: 'platform' } },
    ],
    edges: [
      edge('BELONGS_TO', 'file:src/cart/Cart.tsx', 'domain:cart'),
      edge('BELONGS_TO', 'file:src/cart/total.ts', 'domain:cart'),
      edge('BELONGS_TO', 'file:src/util/fmt.ts', 'domain:util'),
    ],
  });
  return { repo, cache };
}

let repo;
let cache;
let out;
let err;
let cli;

beforeEach(() => {
  ({ repo, cache } = seed());
  cli = cliFor(CANNED_CLI);
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation((s) => err.push(String(s)));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const stdout = () => out.join('\n');
const stderr = () => err.join('\n');
const base = () => ['--cache', cache, '--repo-root', repo];

describe('describe CLI — prerequisites', () => {
  it('exits 2 with a helpful message when no provider is configured', async () => {
    const code = await run([...base(), '--dry-run']);
    expect(code).toBe(2);
    expect(stderr()).toContain('no model provider configured');
    expect(stderr()).toContain('--command');
    expect(stderr()).toContain('ANTHROPIC_API_KEY');
    expect(stderr()).toContain('OPENAI_API_KEY');
    expect(existsSync(join(cache, 'descriptions'))).toBe(false);
  });

  it('exits 2 when the cache has no graph', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lg-desc-empty-'));
    expect(await run(['--cache', empty, '--command', cli, '--yes'])).toBe(2);
    expect(stderr()).toContain('no graph artifacts');
  });

  it('rejects an unknown --scope', async () => {
    expect(await run([...base(), '--scope', 'everything', '--command', cli])).toBe(2);
    expect(stderr()).toContain('--scope must be one of');
  });

  it('rejects a non-positive --top / --budget', async () => {
    expect(await run([...base(), '--top', '0', '--command', cli])).toBe(2);
    expect(await run([...base(), '--budget', 'lots', '--command', cli])).toBe(2);
  });
});

describe('describe CLI — cost controls', () => {
  it('--dry-run prints an estimate, makes ZERO calls and writes nothing', async () => {
    const counter = join(mkdtempSync(join(tmpdir(), 'lg-desc-count-')), 'calls');
    writeFileSync(counter, '');
    const code = await run([...base(), '--command', cliFor(COUNTING_CLI(counter)), '--dry-run']);
    expect(code).toBe(0);
    expect(stdout()).toContain('to describe:   2 item(s)');
    expect(stdout()).toContain('input tokens:  ~');
    expect(stdout()).toContain('--dry-run: no calls made, nothing written.');
    expect(readFileSync(counter, 'utf8')).toBe('');
    expect(existsSync(join(cache, 'descriptions'))).toBe(false);
  });

  it('reports an unknown cost for a provider whose pricing we do not know', async () => {
    await run([...base(), '--command', cli, '--dry-run']);
    expect(stdout()).toContain('cost:          unknown');
    expect(stdout()).not.toMatch(/\$\d/);
  });

  it('quotes a bounded cost when the model has a price on record', async () => {
    await run([...base(), '--command', cli, '--model', 'claude-opus-5', '--dry-run']);
    expect(stdout()).toMatch(/cost: +~\$\d+\.\d+ at most/);
  });

  it('refuses to spend without confirmation on a non-interactive stdin', async () => {
    const wasTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      const code = await run([...base(), '--command', cli]);
      expect(code).toBe(2);
      expect(stderr()).toContain('refusing to spend without confirmation');
      expect(existsSync(join(cache, 'descriptions'))).toBe(false);
    } finally {
      process.stdin.isTTY = wasTTY;
    }
  });

  it('--budget stops cleanly and reports what is left undone', async () => {
    const code = await run([...base(), '--scope', 'files', '--command', cli, '--yes', '--budget', '1']);
    expect(code).toBe(0);
    expect(stdout()).toContain('described=1');
    expect(stdout()).toContain('Stopped by --budget 1 item(s)');
    expect(stdout()).toContain('2 item(s) left undescribed');
    expect(loadDescriptions(cache).size).toBe(1);
  });

  it('--budget-tokens stops cleanly before exceeding the cap', async () => {
    const code = await run([...base(), '--scope', 'files', '--command', cli, '--yes', '--budget-tokens', '450']);
    expect(code).toBe(0);
    expect(stdout()).toContain('Stopped by --budget-tokens 450');
    expect(loadDescriptions(cache).size).toBeLessThan(3);
  });

  it('a budget of zero-fits stops before the first call', async () => {
    const counter = join(mkdtempSync(join(tmpdir(), 'lg-desc-count2-')), 'calls');
    writeFileSync(counter, '');
    const code = await run([...base(), '--command', cliFor(COUNTING_CLI(counter)), '--yes', '--budget-tokens', '1']);
    expect(code).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('');
    expect(stdout()).toContain('described=0');
  });
});

describe('describe CLI — generating and caching', () => {
  it('describes the domains and stores labelled rows', async () => {
    const code = await run([...base(), '--command', cli, '--yes', '--model', 'fake-1']);
    expect(code).toBe(0);
    expect(stdout()).toContain('described=2');

    const rows = loadDescriptions(cache);
    expect(rows.size).toBe(2);
    const cart = rows.get('domain:cart');
    expect(cart.text).toBe('Canned description of cart.');
    expect(cart).toMatchObject({ kind: 'domain', model: 'fake-1', provider: 'command' });
    expect(cart.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(cart.generatedAt)).not.toBeNaN();
  });

  it('says descriptions are model-generated when it wrote any', async () => {
    await run([...base(), '--command', cli, '--yes']);
    expect(stdout()).toContain('MODEL-GENERATED');
  });

  it('writes to <cache>/descriptions/<kind>s.jsonl', async () => {
    await run([...base(), '--command', cli, '--yes']);
    expect(existsSync(pathForKind(cache, 'domain'))).toBe(true);
    expect(existsSync(pathForKind(cache, 'file'))).toBe(false);
  });

  it('a second run re-spends NOTHING when nothing changed', async () => {
    const counter = join(mkdtempSync(join(tmpdir(), 'lg-desc-count3-')), 'calls');
    writeFileSync(counter, '');
    const counting = cliFor(COUNTING_CLI(counter));

    await run([...base(), '--command', counting, '--yes']);
    expect(readFileSync(counter, 'utf8').length).toBe(2);

    out.length = 0;
    const code = await run([...base(), '--command', counting, '--yes']);
    expect(code).toBe(0);
    expect(readFileSync(counter, 'utf8').length).toBe(2); // no new calls
    expect(stdout()).toContain('already described and unchanged');
  });

  it('re-describes ONLY the item whose content changed', async () => {
    const counter = join(mkdtempSync(join(tmpdir(), 'lg-desc-count4-')), 'calls');
    writeFileSync(counter, '');
    const counting = cliFor(COUNTING_CLI(counter));

    await run([...base(), '--scope', 'files', '--command', counting, '--yes']);
    expect(readFileSync(counter, 'utf8').length).toBe(3);
    const before = loadDescriptions(cache).get('file:src/util/fmt.ts').generatedAt;

    // Touch exactly one file's recorded content hash.
    writeLayer(cache, 'inventory', {
      nodes: [
        fileNode('src/cart/Cart.tsx', 'sha-CHANGED'),
        fileNode('src/cart/total.ts'),
        fileNode('src/util/fmt.ts'),
      ],
    });
    writeFileSync(join(cache, 'inventory', 'manifest.json'), JSON.stringify({ repoRoot: repo }));

    out.length = 0;
    await run([...base(), '--scope', 'files', '--command', counting, '--yes']);
    expect(readFileSync(counter, 'utf8').length).toBe(4); // exactly one more call
    expect(stdout()).toContain('described=1');
    expect(stdout()).toContain('cached=2');
    expect(loadDescriptions(cache).get('file:src/util/fmt.ts').generatedAt).toBe(before);
  });

  it('--force re-describes everything even when nothing changed', async () => {
    const counter = join(mkdtempSync(join(tmpdir(), 'lg-desc-count5-')), 'calls');
    writeFileSync(counter, '');
    const counting = cliFor(COUNTING_CLI(counter));
    await run([...base(), '--command', counting, '--yes']);
    await run([...base(), '--command', counting, '--yes', '--force']);
    expect(readFileSync(counter, 'utf8').length).toBe(4);
  });

  it('--top caps how many items are described', async () => {
    await run([...base(), '--scope', 'files', '--top', '1', '--command', cli, '--yes']);
    expect(loadDescriptions(cache).size).toBe(1);
    expect(loadDescriptions(cache).get('file:src/cart/total.ts')).toBeDefined(); // most imported
  });

  it('--scope all describes every kind in one run', async () => {
    await run([...base(), '--scope', 'all', '--command', cli, '--yes']);
    const rows = loadDescriptions(cache);
    expect(rows.byKind('domain')).toHaveLength(2);
    expect(rows.byKind('file')).toHaveLength(3);
    expect(rows.byKind('symbol')).toHaveLength(2);
  });
});

describe('describe CLI — failures and reporting', () => {
  it('one failing item does not abort the run; it is recorded and reported', async () => {
    const code = await run([...base(), '--command', cliFor(FLAKY_CLI), '--yes']);
    expect(code).toBe(0);
    expect(stdout()).toContain('described=1');
    expect(stdout()).toContain('failed=1');
    expect(stdout()).toContain('domain:util');
    expect(stdout()).toContain('exited 7');
    expect(stdout()).toContain('Re-run to retry them');
    expect(loadDescriptions(cache).get('domain:cart')).toBeDefined();
    expect(loadDescriptions(cache).get('domain:util')).toBeUndefined();
  });

  it('--json emits a machine-readable summary', async () => {
    const code = await run([...base(), '--command', cli, '--yes', '--json', '--model', 'fake-2']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed).toMatchObject({
      scope: 'domains', provider: 'command', model: 'fake-2', described: 2, failed: 0, stoppedBy: null,
    });
    expect(parsed.files[0]).toContain('descriptions');
  });

  it('--json --dry-run emits the estimate without spending', async () => {
    const code = await run([...base(), '--command', cli, '--dry-run', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.dryRun).toBe(true);
    expect(parsed.estimate.items).toBe(2);
    expect(parsed.estimate.cost.known).toBe(false);
    // Every --json answer says what shape it is (see lib/json_envelope.mjs).
    expect(parsed).toMatchObject({ schemaVersion: 1, tool: 'loregraph' });
    expect(existsSync(join(cache, 'descriptions'))).toBe(false);
  });

  it('reads describe.command from the config file', async () => {
    writeFileSync(
      join(repo, 'loregraph.config.json'),
      JSON.stringify({ describe: { command: cli, model: 'from-config' } }),
    );
    const code = await run([...base(), '--yes']);
    expect(code).toBe(0);
    expect(loadDescriptions(cache).get('domain:cart').model).toBe('from-config');
  });
});
