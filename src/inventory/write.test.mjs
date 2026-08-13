import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic, writeJsonlAtomic } from './write.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cg-write-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeJsonlAtomic', () => {
  it('writes compact, key-sorted lines joined by \\n with no trailing newline', () => {
    const p = join(dir, 'nested/out/rows.jsonl');
    writeJsonlAtomic(p, [{ b: 1, a: 2, c: { z: 1, y: 2 } }, { a: 3, b: 4 }]);
    const text = readFileSync(p, 'utf8');
    expect(text).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}\n{"a":3,"b":4}');
    expect(text.endsWith('\n')).toBe(false);
    expect(text.split('\n')).toHaveLength(2);
  });

  it('empty rows → 0-byte file', () => {
    const p = join(dir, 'empty.jsonl');
    writeJsonlAtomic(p, []);
    expect(statSync(p).size).toBe(0);
  });

  it('leaves no temp files behind', () => {
    const p = join(dir, 'rows.jsonl');
    writeJsonlAtomic(p, [{ a: 1 }]);
    expect(readdirSync(dir)).toEqual(['rows.jsonl']);
  });

  it('is deterministic across calls', () => {
    const p1 = join(dir, 'a.jsonl');
    const p2 = join(dir, 'b.jsonl');
    const rows = [{ z: 1, a: 2 }, { m: 3 }];
    writeJsonlAtomic(p1, rows);
    writeJsonlAtomic(p2, rows);
    expect(readFileSync(p1, 'utf8')).toBe(readFileSync(p2, 'utf8'));
  });
});

describe('writeJsonAtomic', () => {
  it('writes pretty JSON and round-trips', () => {
    const p = join(dir, 'manifest.json');
    const obj = { schemaVersion: 1, counts: { files: 2 } };
    writeJsonAtomic(p, obj);
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('\n  '); // indented
    expect(JSON.parse(text)).toEqual(obj);
  });

  it('mkdir -p the target directory', () => {
    const p = join(dir, 'deep/a/b/manifest.json');
    writeJsonAtomic(p, { ok: true });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ ok: true });
  });
});
