// Language-agnostic file classification from a relative POSIX path.
// Pure and deterministic.

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.tif', '.tiff', '.avif', '.heic', '.heif',
]);
const FONT_EXTS = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']);
const MEDIA_EXTS = new Set([
  '.mp3', '.mp4', '.wav', '.ogg', '.oga', '.webm', '.mov', '.avi',
  '.mkv', '.flac', '.m4a', '.aac', '.m4v', '.wmv',
]);
const ARCHIVE_EXTS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.tar.gz', '.bz2', '.tar.bz2',
  '.xz', '.tar.xz', '.7z', '.rar', '.jar', '.war',
]);
const OTHER_BINARY_EXTS = new Set([
  '.pdf', '.wasm', '.so', '.dylib', '.dll', '.exe', '.bin',
  '.class', '.o', '.a', '.node', '.dat', '.dmg', '.iso',
]);

const BINARY_EXTS = new Set([
  ...IMAGE_EXTS, ...FONT_EXTS, ...MEDIA_EXTS, ...ARCHIVE_EXTS, ...OTHER_BINARY_EXTS,
]);

const LANGUAGE_BY_EXT = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.d.ts': 'TypeScript', '.d.mts': 'TypeScript', '.d.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.pyi': 'Python',
  '.json': 'JSON', '.jsonc': 'JSON', '.json5': 'JSON',
  '.md': 'Markdown', '.markdown': 'Markdown', '.mdx': 'Markdown',
  '.css': 'CSS', '.scss': 'CSS', '.sass': 'CSS', '.less': 'CSS',
  '.html': 'HTML', '.htm': 'HTML',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.svg': 'SVG',
  '.xml': 'XML',
  '.toml': 'TOML',
  '.ini': 'INI', '.cfg': 'INI', '.conf': 'INI',
  '.txt': 'Text',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell', '.ps1': 'PowerShell',
  '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.scala': 'Scala',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++',
  '.hpp': 'C++', '.hh': 'C++', '.hxx': 'C++', '.m': 'Objective-C', '.mm': 'Objective-C++',
  '.sql': 'SQL', '.graphql': 'GraphQL', '.gql': 'GraphQL', '.proto': 'Protobuf',
  '.vue': 'Vue', '.svelte': 'Svelte', '.astro': 'Astro',
};

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.go', '.rs', '.java', '.kt', '.kts', '.rb', '.php', '.swift', '.scala',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.m', '.mm',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql', '.graphql', '.gql', '.proto',
  '.vue', '.svelte', '.astro',
]);

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'npm-shrinkwrap.json', 'bun.lockb',
]);

const CONFIG_FILENAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json',
  'tsconfig.base.json', 'tsconfig.build.json',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json',
  '.eslintrc.yaml', '.eslintrc.yml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs',
  '.prettierrc.yaml', '.prettierrc.yml', 'prettier.config.js', 'prettier.config.cjs',
  'babel.config.js', 'babel.config.json', '.babelrc', '.babelrc.js', '.babelrc.json',
  'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
  'vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs',
  'webpack.config.js', 'rollup.config.js', 'rollup.config.mjs',
  'jest.config.js', 'jest.config.ts', 'jest.config.cjs',
  '.editorconfig', '.nvmrc', '.node-version',
  '.gitignore', '.gitattributes', '.dockerignore', '.npmignore', '.kgignore',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'makefile', 'loregraph.config.mjs', 'loregraph.config.json',
]);

const CONFIG_EXTS = new Set([
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.editorconfig',
]);

// Multi-part suffixes recognised as a single "extension".
const COMPOUND_EXTS = ['.d.ts', '.d.mts', '.d.cts', '.tar.gz', '.tar.bz2', '.tar.xz'];

/** Lowercased final suffix, with a few well-known compound suffixes preserved. */
export function getExtension(name) {
  const lower = String(name).toLowerCase();
  for (const c of COMPOUND_EXTS) {
    if (lower.endsWith(c) && lower.length > c.length) return c;
  }
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or a leading-dot dotfile like ".gitignore"
  return lower.slice(dot);
}

function detectLanguage(extension, base, isBinary) {
  const mapped = LANGUAGE_BY_EXT[extension];
  if (mapped) return mapped;
  if (isBinary) return 'Binary';
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'Dockerfile';
  if (base === 'makefile') return 'Makefile';
  return 'Unknown';
}

/**
 * @param {string} relPosixPath
 * @returns {{extension:string, language:string, kind:string, trust:string, isBinary:boolean, isGenerated:boolean}}
 */
export function classify(relPosixPath) {
  const norm = String(relPosixPath ?? '').replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);
  const base = (segments.length ? segments[segments.length - 1] : norm).toLowerCase();
  const extension = getExtension(base);

  const isSvg = extension === '.svg';
  const isBinary = BINARY_EXTS.has(extension);
  const isAsset = isBinary || isSvg;

  const language = detectLanguage(extension, base, isBinary);

  const isLockfile = LOCKFILES.has(base);
  const isMinified = base.includes('.min.');
  const isMap = extension === '.map';
  const isGenerated = isLockfile || isMinified || isMap;

  const isTestName = /\.(test|spec)\./.test(base);
  const parentSegments = segments.slice(0, -1);
  const isUnderTests = parentSegments.some((s) => s === 'tests' || s === '__tests__');
  const isCodeLang = CODE_EXTS.has(extension);
  const isConfig = CONFIG_FILENAMES.has(base) || CONFIG_EXTS.has(extension);

  let kind;
  if (isLockfile) kind = 'lockfile';
  else if (isAsset) kind = 'asset';
  else if (isTestName || (isUnderTests && isCodeLang)) kind = 'test';
  else if (language === 'Markdown') kind = 'doc';
  else if (isConfig) kind = 'config';
  else kind = 'code';

  let trust;
  if (language === 'Markdown') trust = 'doc';
  else if (isAsset) trust = 'asset';
  else trust = 'code';

  return { extension, language, kind, trust, isBinary, isGenerated };
}
