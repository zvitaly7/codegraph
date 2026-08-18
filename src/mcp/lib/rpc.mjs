// Minimal stdio JSON-RPC 2.0 server for the Model Context Protocol.
//
// `handleRequest(msg, graph)` is a pure request handler — given one parsed
// JSON-RPC message and the loaded graph, it returns the response object (or
// `null` for a notification, which must not be answered). `serve(graph, io)`
// wraps it in a `node:readline` loop over stdin, writing one JSON response per
// line to stdout. The loop never throws: a malformed line becomes a parse-error
// response, and a handler failure becomes a JSON-RPC error response.

import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS, TOOL_NAMES, callTool } from './tools.mjs';

const JSONRPC = '2.0';

/**
 * Clients log and gate on `serverInfo.version`, so it is read from the package
 * manifest rather than restated here — a release bump cannot leave it stale.
 */
function packageVersion() {
  try {
    const path = fileURLToPath(new URL('../../../package.json', import.meta.url));
    return JSON.parse(readFileSync(path, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_INFO = { name: 'loregraph', version: packageVersion() };
/** Protocol version echoed to a client that omits its own. */
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function errorResponse(id, code, message) {
  return { jsonrpc: JSONRPC, id: id ?? null, error: { code, message } };
}

function successResponse(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}

/**
 * Handle one parsed JSON-RPC message.
 * @param {any} msg parsed message (any shape — validated here).
 * @param {object} graph loaded graph index.
 * @returns {object|null} response object, or null for a notification (no reply).
 */
export function handleRequest(msg, graph) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return errorResponse(null, -32600, 'Invalid Request');
  }
  const isNotification = !Object.prototype.hasOwnProperty.call(msg, 'id');
  const id = isNotification ? null : msg.id;

  if (msg.jsonrpc !== JSONRPC || typeof msg.method !== 'string') {
    return isNotification ? null : errorResponse(id, -32600, 'Invalid Request');
  }

  try {
    switch (msg.method) {
      case 'initialize':
        return successResponse(id, {
          protocolVersion: msg.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        });

      case 'tools/list':
        return successResponse(id, { tools: TOOLS });

      case 'tools/call': {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        if (!TOOL_NAMES.has(name)) {
          return isNotification ? null : errorResponse(id, -32602, `Unknown tool: ${name}`);
        }
        const out = callTool(graph, name, args);
        // Compact, not pretty: the consumer is an agent paying per token, and
        // indentation adds bytes no reader benefits from.
        return successResponse(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
      }

      case 'ping':
        return successResponse(id, {});

      default:
        // Notifications (e.g. notifications/initialized) get no reply.
        return isNotification ? null : errorResponse(id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    return isNotification ? null : errorResponse(id, -32603, err?.message ?? String(err));
  }
}

/** Serialize one message as a single stdout line. */
function writeMessage(output, obj) {
  output.write(`${JSON.stringify(obj)}\n`);
}

/**
 * Run the stdio JSON-RPC loop until stdin closes (EOF).
 * @param {object} graph loaded graph index.
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [io]
 * @returns {Promise<number>} resolves 0 once input closes and output has drained.
 */
export function serve(graph, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolvePromise) => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        writeMessage(output, errorResponse(null, -32700, 'Parse error'));
        return;
      }
      let response;
      try {
        response = handleRequest(msg, graph);
      } catch (err) {
        // Defensive: handleRequest is designed not to throw, but never crash the loop.
        response = errorResponse(msg?.id ?? null, -32603, err?.message ?? String(err));
      }
      if (response !== null && response !== undefined) writeMessage(output, response);
    });

    rl.on('close', () => {
      // Flush any buffered stdout before resolving so a piped consumer sees it all.
      if (typeof output.writableLength === 'number' && output.writableLength > 0) {
        output.once('drain', () => resolvePromise(0));
        // Safety net in case 'drain' never fires (already flushed).
        setImmediate(() => resolvePromise(0));
      } else {
        resolvePromise(0);
      }
    });
  });
}
