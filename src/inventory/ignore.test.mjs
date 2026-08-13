import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnoreRules } from './ignore.mjs';

let repo;
let rules;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'cg-ign-'));
  writeFileSync(join(repo, '.gitignore'), 'secret-dir/\n*.tmp\ngenerated.txt\n');
  writeFileSync(join(repo, '.kgignore'), 'extra/\n');
  rules = IgnoreRules.fromRepo(repo, { ignoreFile: '.gitignore' });
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

describe('hard-skip directories', () => {
  it('skips vendored / build / cache dirs at any depth', () => {
    for (const d of ['node_modules', '.git', '.kg-cache', 'dist', 'build', 'coverage', '__pycache__', '.venv']) {
      expect(rules.shouldSkip(d, true)).toBe(true);
      expect(rules.shouldSkip(`src/${d}`, true)).toBe(true);
    }
  });
  it('skips *.egg-info dirs', () => {
    expect(rules.shouldSkip('pkg.egg-info', true)).toBe(true);
    expect(rules.shouldSkip('a/b/thing.egg-info', true)).toBe(true);
  });
  it('does not hard-skip a file that shares a dir name', () => {
    expect(rules.shouldSkip('scripts/build', false)).toBe(false);
  });
});

describe('hard-skip files', () => {
  it('skips .DS_Store', () => {
    expect(rules.shouldSkip('.DS_Store', false)).toBe(true);
    expect(rules.shouldSkip('a/b/.DS_Store', false)).toBe(true);
  });
});

describe('security credentials', () => {
  it('skips private keys and credential files', () => {
    expect(rules.shouldSkip('id_rsa', false)).toBe(true);
    expect(rules.shouldSkip('.ssh/id_ed25519', false)).toBe(true);
    expect(rules.shouldSkip('.npmrc', false)).toBe(true);
    expect(rules.shouldSkip('.netrc', false)).toBe(true);
    expect(rules.shouldSkip('server.key', false)).toBe(true);
    expect(rules.shouldSkip('tls.key.pem', false)).toBe(true);
    expect(rules.shouldSkip('app-key.pem', false)).toBe(true);
    expect(rules.shouldSkip('cert.p12', false)).toBe(true);
    expect(rules.shouldSkip('APP.MOBILEPROVISION', false)).toBe(true); // case-insensitive
  });
  it('keeps public keys / plain certs', () => {
    expect(rules.shouldSkip('id_rsa.pub', false)).toBe(false);
    expect(rules.shouldSkip('server.crt', false)).toBe(false);
    expect(rules.shouldSkip('ca.cer', false)).toBe(false);
    expect(rules.shouldSkip('fullchain.pem', false)).toBe(false);
    expect(rules.shouldSkip('cert.pem', false)).toBe(false);
  });
});

describe('dotenv', () => {
  it('skips .env and .env.* except sample/example', () => {
    expect(rules.shouldSkip('.env', false)).toBe(true);
    expect(rules.shouldSkip('.env.production', false)).toBe(true);
    expect(rules.shouldSkip('.env.local', false)).toBe(true);
    expect(rules.shouldSkip('.env.sample', false)).toBe(false);
    expect(rules.shouldSkip('.env.example', false)).toBe(false);
  });
});

describe('ignore-file matches', () => {
  it('honors .gitignore file + dir patterns', () => {
    expect(rules.shouldSkip('foo.tmp', false)).toBe(true);
    expect(rules.shouldSkip('generated.txt', false)).toBe(true);
    expect(rules.shouldSkip('secret-dir', true)).toBe(true);       // dir pattern needs trailing slash
    expect(rules.shouldSkip('secret-dir/x.js', false)).toBe(true);
  });
  it('honors .kgignore too', () => {
    expect(rules.shouldSkip('extra', true)).toBe(true);
  });
  it('keeps ordinary files, and never throws on root', () => {
    expect(rules.shouldSkip('src/index.ts', false)).toBe(false);
    expect(rules.shouldSkip('.', true)).toBe(false);
  });
});
