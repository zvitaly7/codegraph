import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAnalyzableSource, readInventorySources, readInventoryManifest,
} from './inventory_reader.mjs';

describe('isAnalyzableSource', () => {
  it('accepts TS/JS code and test files', () => {
    expect(isAnalyzableSource({ language: 'TypeScript', kind: 'code' })).toBe(true);
    expect(isAnalyzableSource({ language: 'TypeScript', kind: 'test' })).toBe(true);
    expect(isAnalyzableSource({ language: 'JavaScript', kind: 'code' })).toBe(true);
    expect(isAnalyzableSource({ language: 'JavaScript', kind: 'test' })).toBe(true);
  });

  it('rejects assets, docs, lockfiles, config, and other languages', () => {
    expect(isAnalyzableSource({ language: 'TypeScript', kind: 'config' })).toBe(false);
    expect(isAnalyzableSource({ language: 'Markdown', kind: 'doc' })).toBe(false);
    expect(isAnalyzableSource({ language: 'JSON', kind: 'lockfile' })).toBe(false);
    expect(isAnalyzableSource({ language: 'Binary', kind: 'asset' })).toBe(false);
    expect(isAnalyzableSource({ language: 'Python', kind: 'code' })).toBe(false);
    expect(isAnalyzableSource({ language: 'CSS', kind: 'code' })).toBe(false);
  });
});

describe('readInventorySources / readInventoryManifest', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cg-invread-'));
    mkdirSync(dir, { recursive: true });
    const rows = [
      { id: 'file:src/a.ts', path: 'src/a.ts', language: 'TypeScript', kind: 'code' },
      { id: 'file:src/a.test.ts', path: 'src/a.test.ts', language: 'TypeScript', kind: 'test' },
      { id: 'file:src/b.mjs', path: 'src/b.mjs', language: 'JavaScript', kind: 'code' },
      { id: 'file:README.md', path: 'README.md', language: 'Markdown', kind: 'doc' },
      { id: 'file:pkg-lock', path: 'package-lock.json', language: 'JSON', kind: 'lockfile' },
      { id: 'file:logo.png', path: 'logo.png', language: 'Binary', kind: 'asset' },
    ];
    writeFileSync(join(dir, 'files.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ snapshotId: 'snapshot:demo:abc' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns only analyzable TS/JS sources', () => {
    const rows = readInventorySources(dir);
    expect(rows.map((r) => r.path)).toEqual(['src/a.ts', 'src/a.test.ts', 'src/b.mjs']);
  });

  it('tolerates blank lines in files.jsonl', () => {
    writeFileSync(
      join(dir, 'files.jsonl'),
      '\n' + JSON.stringify({ id: 'file:x.ts', path: 'x.ts', language: 'TypeScript', kind: 'code' }) + '\n\n',
    );
    expect(readInventorySources(dir).map((r) => r.path)).toEqual(['x.ts']);
  });

  it('reads the inventory manifest', () => {
    expect(readInventoryManifest(dir).snapshotId).toBe('snapshot:demo:abc');
  });
});
