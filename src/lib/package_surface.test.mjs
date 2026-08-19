import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// What a package exports is a promise: rename anything reachable from outside
// and somebody's code breaks. Without an `exports` map every internal file is
// reachable, so the promise is made by accident and covers the whole tree. This
// package is a CLI and an MCP server — the promise it means to make is the
// command line, and nothing else.
describe('the published surface', () => {
  let consumer;

  beforeAll(() => {
    consumer = mkdtempSync(join(tmpdir(), 'lg-consumer-'));
    mkdirSync(join(consumer, 'node_modules'), { recursive: true });
    // Windows refuses a `dir` symlink without elevation; a junction is what npm
    // creates for a linked package anyway.
    symlinkSync(REPO, join(consumer, 'node_modules', 'loregraph'),
      process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module' }));
  });
  afterAll(() => rmSync(consumer, { recursive: true, force: true }));

  /** Import `specifier` from a package consumer; returns the error code, or null on success. */
  function importFromConsumer(specifier) {
    const script = `import(${JSON.stringify(specifier)})
      .then(() => { console.log('OK'); })
      .catch((e) => { console.log(e.code ?? 'ERROR'); });`;
    return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: consumer,
      encoding: 'utf8',
    }).trim();
  }

  it('refuses a deep import of an internal module', () => {
    expect(importFromConsumer('loregraph/src/lib/graph_load.mjs'))
      .toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('refuses the bare package specifier — there is no library entry point', () => {
    expect(importFromConsumer('loregraph')).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('still lets tooling read the manifest', () => {
    // Resolution, not import: a JSON import needs an attribute, which has
    // nothing to do with whether the path is exported.
    const script = "import { createRequire } from 'node:module';"
      + "const r = createRequire(process.cwd() + '/x.js');"
      + "try { r.resolve('loregraph/package.json'); console.log('OK'); }"
      + "catch (e) { console.log(e.code ?? 'ERROR'); }";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: consumer, encoding: 'utf8',
    }).trim();
    expect(out).toBe('OK');
  });

  it('keeps the CLI reachable — it is what the package is for', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(pkg.bin.loregraph).toBe('bin/loregraph.mjs');
    const out = execFileSync(process.execPath, [join(REPO, pkg.bin.loregraph), '--help'], { encoding: 'utf8' });
    expect(out).toContain('loregraph <command>');
  });
});
