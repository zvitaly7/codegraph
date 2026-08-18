export const DEFAULTS = {
  srcRoots: ['src'],
  ignoreFile: '.gitignore',
  tsconfig: null,      // null → auto-discover
  vcs: 'auto',         // 'auto' | 'git' | 'arc' | 'none'
  outDir: '.kg-cache',
  domains: null,       // null → auto-derive
  incremental: 'off',  // 'off' | 'incremental' — heavy-layer rebuild mode
  compressPaths: false, // factor shared directory prefixes out of path lists
  entryPoints: [],     // globs whose exports are never reported dead; package.json
                       // main/module/exports/bin are detected on top of these
};
