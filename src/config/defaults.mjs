export const DEFAULTS = {
  srcRoots: ['src'],
  ignoreFile: '.gitignore',
  tsconfig: null,      // null → auto-discover
  vcs: 'auto',         // 'auto' | 'git' | 'arc' | 'none'
  outDir: '.kg-cache',
  domains: null,       // null → auto-derive
};
