import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { loadGraph } from '../../lib/graph_load.mjs';
import { handleRequest, serve } from './rpc.mjs';

function tinyGraph() {
  const cache = mkdtempSync(join(tmpdir(), 'cg-mcp-rpc-'));
  const dir = join(cache, 'inventory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nodes.jsonl'), JSON.stringify({ id: 'file:src/run.mjs', labels: ['File'], properties: { path: 'src/run.mjs', name: 'run.mjs' } }));
  writeFileSync(join(dir, 'edges.jsonl'), '');
  return loadGraph(cache);
}

let g;
beforeEach(() => { g = tinyGraph(); });

describe('handleRequest — protocol methods', () => {
  it('initialize returns serverInfo + tools capability', () => {
    // The reported version is read from package.json rather than restated here,
    // so a release bump can never leave the server lying about what it is.
    const pkgVersion = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ).version;
    const r = handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, g);
    expect(r.result.serverInfo).toEqual({ name: 'loregraph', version: pkgVersion });
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result.protocolVersion).toBe('2025-06-18'); // echoes client's
  });

  it('tools/list returns the tool specs', () => {
    const r = handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, g);
    expect(Array.isArray(r.result.tools)).toBe(true);
    expect(r.result.tools.find((t) => t.name === 'find_node')).toBeTruthy();
    expect(r.result.tools.length).toBeGreaterThanOrEqual(11);
  });

  it('tools/call runs a tool and wraps JSON in a text content block', () => {
    const r = handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_node', arguments: { query: 'run.mjs' } } }, g);
    expect(r.result.content[0].type).toBe('text');
    const payload = JSON.parse(r.result.content[0].text);
    expect(payload.results.map((n) => n.id)).toContain('file:src/run.mjs');
  });

  it('tools/call serializes the payload compactly (no pretty-print padding)', () => {
    const r = handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_node', arguments: { query: 'run.mjs' } } }, g);
    const text = r.result.content[0].text;
    // Compact JSON has no newlines and no indent runs — every byte carries payload.
    expect(text).not.toMatch(/\n/);
    const payload = JSON.parse(text);
    expect(text).toBe(JSON.stringify(payload));
    expect(text.length).toBeLessThan(JSON.stringify(payload, null, 2).length);
  });

  it('ping returns an empty result', () => {
    expect(handleRequest({ jsonrpc: '2.0', id: 4, method: 'ping' }, g).result).toEqual({});
  });
});

describe('handleRequest — errors', () => {
  it('unknown method → -32601', () => {
    const r = handleRequest({ jsonrpc: '2.0', id: 5, method: 'no/such' }, g);
    expect(r.error.code).toBe(-32601);
  });

  it('unknown tool → -32602', () => {
    const r = handleRequest({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ghost' } }, g);
    expect(r.error.code).toBe(-32602);
  });

  it('bad jsonrpc envelope → -32600', () => {
    expect(handleRequest({ id: 7, method: 'ping' }, g).error.code).toBe(-32600);
    expect(handleRequest(null, g).error.code).toBe(-32600);
  });

  it('a notification (no id) is never answered', () => {
    expect(handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, g)).toBeNull();
    // even an unknown-method notification stays silent
    expect(handleRequest({ jsonrpc: '2.0', method: 'no/such' }, g)).toBeNull();
  });
});

describe('serve — stdio line loop', () => {
  function collect() {
    const chunks = [];
    const output = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); } });
    return { output, lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
  }

  it('answers each request line, skips notifications, and exits clean on EOF', async () => {
    const input = new PassThrough();
    const { output, lines } = collect();
    const done = serve(g, { input, output });

    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); // no reply
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"find_node","arguments":{"query":"run.mjs"}}}\n');
    input.end();

    const code = await done;
    expect(code).toBe(0);
    const out = lines();
    expect(out).toHaveLength(2); // notification produced no line
    expect(out[0].id).toBe(1);
    expect(out[0].result.tools.length).toBeGreaterThan(0);
    expect(out[1].id).toBe(2);
    expect(JSON.parse(out[1].result.content[0].text).results[0].id).toBe('file:src/run.mjs');
  });

  it('a malformed line yields a parse-error response without crashing the loop', async () => {
    const input = new PassThrough();
    const { output, lines } = collect();
    const done = serve(g, { input, output });

    input.write('not json at all\n');
    input.write('\n'); // blank line ignored
    input.write('{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
    input.end();

    await done;
    const out = lines();
    expect(out[0].error.code).toBe(-32700);
    expect(out[1].id).toBe(9);
    expect(out[1].result).toEqual({});
  });
});
