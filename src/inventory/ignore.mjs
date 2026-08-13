import ignore from 'ignore';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Hard-skipped directory names, applied at any depth.
const HARD_SKIP_DIRS = new Set([
  '.git', '.kg-cache', 'node_modules', '.cache', '.turbo', '.vite',
  'dist', 'build', 'coverage', '.next', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.mypy_cache',
]);

// Hard-skipped file names.
const HARD_SKIP_FILES = new Set(['.DS_Store']);

// Never index credential material (any depth).
const SECURITY_FILENAMES = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.netrc', '_netrc',
]);
const SECURITY_SUFFIXES = [
  '.key', '.key.pem', '-key.pem', '.private.pem', '.p12', '.pfx', '.jks',
  '.keystore', '.pkcs12', '.ppk', '.p8', '.mobileprovision', '.provisionprofile',
];

function baseName(relPosixPath) {
  const parts = String(relPosixPath).split('/');
  return parts[parts.length - 1];
}

export class IgnoreRules {
  constructor(ig) {
    this._ig = ig;
  }

  /**
   * Build from `<repoRoot>/<ignoreFile>` (default `.gitignore`) plus
   * `<repoRoot>/.kgignore` when present.
   */
  static fromRepo(repoRoot, { ignoreFile = '.gitignore' } = {}) {
    const ig = ignore();
    const files = ignoreFile === '.kgignore' ? [ignoreFile] : [ignoreFile, '.kgignore'];
    for (const f of files) {
      if (!f) continue;
      const p = join(repoRoot, f);
      if (existsSync(p)) {
        try {
          ig.add(readFileSync(p, 'utf8'));
        } catch {
          /* unreadable ignore file → treat as no rules */
        }
      }
    }
    return new IgnoreRules(ig);
  }

  _ignoresSafe(p) {
    if (!p || p === '.') return false;
    try {
      return this._ig.ignores(p);
    } catch {
      return false;
    }
  }

  /**
   * @param {string} relPosixPath  path relative to the repo root (POSIX, no leading './')
   * @param {boolean} isDir
   * @returns {boolean}
   */
  shouldSkip(relPosixPath, isDir) {
    const name = baseName(relPosixPath);
    const lower = name.toLowerCase();

    // 1. hard-skip dir names + *.egg-info (directories)
    if (isDir && (HARD_SKIP_DIRS.has(name) || name.endsWith('.egg-info'))) return true;

    // 2. hard-skip filename
    if (HARD_SKIP_FILES.has(name)) return true;

    // 3. security credentials
    if (SECURITY_FILENAMES.has(name)) return true;
    for (const suf of SECURITY_SUFFIXES) {
      if (lower.endsWith(suf)) return true;
    }

    // 4. dotenv: skip `.env` and `.env.*`, except *.sample / *.example
    if (name === '.env' || name.startsWith('.env.')) {
      if (!(lower.endsWith('.sample') || lower.endsWith('.example'))) return true;
    }

    // 5. ignore-file match — test the path, and for dirs also with a trailing '/'
    if (this._ignoresSafe(relPosixPath)) return true;
    if (isDir && this._ignoresSafe(relPosixPath.endsWith('/') ? relPosixPath : `${relPosixPath}/`)) return true;

    return false;
  }
}
