// `loregraph explorer` — build the browser index from cached graph artifacts,
// and (optionally) serve the explorer directory over HTTP for local browsing.
//
// Reads every present layer under <cache> (default: the resolved outDir),
// computes a single `graph-index.json`, and writes it to <cache>/explorer/.
// The packaged SPA `index.html` is copied there too, so the browser explorer
// and its data sit side by side. With --serve, a static file server hosts
// <cache>/explorer/ so index.html and graph-index.json are browsable offline.
//
// Exit codes: 0 success · 1 write / server failure · 2 usage / no artifacts.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { resolveConfig } from '../config/load.mjs';
import { checkStaleness } from '../lib/staleness.mjs';
import { writeJsonAtomic, writeTextAtomic } from '../inventory/write.mjs';
import { loadGraph } from '../lib/graph_load.mjs';
import { loadDescriptions } from '../describe/lib/store.mjs';
import { buildIndex } from './lib/build_index.mjs';

const DEFAULT_PORT = 8765;

/** Packaged SPA shipped beside this module; copied into <cache>/explorer/. */
const SPA_HTML_PATH = fileURLToPath(new URL('./index.html', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Minimal read-only static file server rooted at `rootDir`. Resolves with the
 * listening server once bound; rejects if the port cannot be bound.
 */
function startStaticServer(rootDir, port) {
  const root = resolve(rootDir);
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request');
        return;
      }
      if (pathname === '/' || pathname === '') pathname = '/index.html';

      // Contain the resolved path within root (defeat path traversal).
      const abs = normalize(join(root, pathname));
      if (abs !== root && !abs.startsWith(root + sep)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const type = CONTENT_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      createReadStream(abs).pipe(res);
    });
    server.on('error', reject);
    server.listen(port, () => resolvePromise(server));
  });
}

/** Serve `dir` on `port` until SIGINT/SIGTERM; resolves once the server closes. */
async function serveUntilSignal(dir, port) {
  const server = await startStaticServer(dir, port);
  const url = `http://localhost:${port}/`;
  // The URL goes to stderr so stdout stays a clean summary line.
  process.stderr.write(`[loregraph] explorer serving ${dir} at ${url} (Ctrl+C to stop)\n`);
  await new Promise((resolvePromise) => {
    const shutdown = () => server.close(() => resolvePromise());
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

export async function run(argv) {
  const cwd = process.cwd();

  let cfg;
  try {
    cfg = await resolveConfig({
      cwd,
      argv,
      extraOptions: {
        cache: { type: 'string' },
        serve: { type: 'boolean' },
        port: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`explorer: usage error: ${err.message}`);
    return 2;
  }

  const { outDir, _flags: flags } = cfg;
  const cache = flags.cache ? resolve(cwd, flags.cache) : outDir;

  let port = DEFAULT_PORT;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(`explorer: --port must be an integer 0-65535, got ${flags.port}`);
      return 2;
    }
  }

  if (!existsSync(cache)) {
    console.error(`explorer: cache dir not found: ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  const graph = loadGraph(cache);
  if (graph.loadedLayers.length === 0) {
    console.error(`explorer: no graph artifacts under ${cache} — run \`loregraph regenerate\` first`);
    return 2;
  }

  // Embed a cache-freshness signal so the SPA can flag a stale index.
  const staleness = checkStaleness(cache);
  // Model-written descriptions, when `loregraph describe` has produced any. They
  // ride in their own map in the index and the SPA labels every one it shows.
  const descriptions = loadDescriptions(cache);
  const index = buildIndex(graph, { generatedAt: new Date().toISOString(), staleness, descriptions });

  const explorerDir = join(cache, 'explorer');
  const outPath = join(explorerDir, 'graph-index.json');
  const htmlPath = join(explorerDir, 'index.html');
  try {
    writeJsonAtomic(outPath, index);
    // Copy the packaged SPA next to the index so `--serve` (and any static
    // host) can serve both files from <cache>/explorer/.
    writeTextAtomic(htmlPath, readFileSync(SPA_HTML_PATH, 'utf8'));
  } catch (err) {
    console.error(`explorer: failed to write index: ${err.message}`);
    return 1;
  }

  const { files, symbols, packages, domains, edges } = index.stats;
  console.log(
    `[loregraph] explorer files=${files} symbols=${symbols} packages=${packages} `
    + `domains=${domains} edges=${edges} layers=${graph.loadedLayers.join('+')} out=${outPath}`,
  );

  if (flags.serve) {
    try {
      await serveUntilSignal(explorerDir, port);
    } catch (err) {
      console.error(`explorer: failed to start server on port ${port}: ${err.message}`);
      return 1;
    }
  }

  return 0;
}
