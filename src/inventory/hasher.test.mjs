import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hashFile } from './hasher.mjs';

let dir;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cg-hash-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('hashFile', () => {
  it('hashes a small file (matches node:crypto)', () => {
    const p = join(dir, 'a.txt');
    writeFileSync(p, 'hello world');
    const expected = createHash('sha256').update('hello world').digest('hex');
    const r = hashFile(p);
    expect(r.hashError).toBeNull();
    expect(r.sha256).toBe(expected);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes an empty file', () => {
    const p = join(dir, 'empty.txt');
    writeFileSync(p, '');
    const r = hashFile(p);
    expect(r.hashError).toBeNull();
    expect(r.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes a multi-chunk (>64KiB) file identically to node:crypto', () => {
    const p = join(dir, 'big.bin');
    const payload = Buffer.alloc(200 * 1024, 7);
    writeFileSync(p, payload);
    const expected = createHash('sha256').update(payload).digest('hex');
    expect(hashFile(p).sha256).toBe(expected);
  });

  it('never throws on a missing file', () => {
    const r = hashFile(join(dir, 'does-not-exist'));
    expect(r.sha256).toBeNull();
    expect(typeof r.hashError).toBe('string');
    expect(r.hashError.length).toBeGreaterThan(0);
  });
});
