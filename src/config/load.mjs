import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULTS } from './defaults.mjs';

const OPTIONS = {
  'repo-root': { type: 'string' },
  'out': { type: 'string' },
  'config': { type: 'string' },
};

export async function resolveConfig({ cwd, argv, extraOptions = {} }) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    options: { ...OPTIONS, ...extraOptions },
  });

  const repoRoot = resolve(cwd, values['repo-root'] ?? '.');

  // Optional config file: explicit --config, else codegraph.config.{mjs,json}
  // at repo root (checked in that order).
  let fileCfg = {};
  let configPath = values['config'] ? resolve(cwd, values['config']) : undefined;
  if (!configPath) {
    const mjsPath = resolve(repoRoot, 'codegraph.config.mjs');
    const jsonPath = resolve(repoRoot, 'codegraph.config.json');
    configPath = existsSync(mjsPath) ? mjsPath : jsonPath;
  }
  if (existsSync(configPath)) {
    if (configPath.endsWith('.json')) {
      // Modern Node's dynamic import() of JSON requires `with { type: 'json' }`
      // (ERR_IMPORT_ATTRIBUTE_MISSING otherwise) — read + parse directly instead.
      fileCfg = JSON.parse(readFileSync(configPath, 'utf8')) ?? {};
    } else {
      const mod = await import(pathToFileURL(configPath).href);
      fileCfg = mod.default ?? {};
    }
  }

  return {
    ...DEFAULTS,
    ...fileCfg,
    repoRoot,
    outDir: resolve(cwd, values['out'] ?? fileCfg.outDir ?? DEFAULTS.outDir),
    // Precedence: flag → config file → default. The flag only appears in `values`
    // when a command declares `--incremental` in its extraOptions.
    incremental: values.incremental ?? fileCfg.incremental ?? DEFAULTS.incremental,
    _flags: values,
    // Bare arguments, in order — e.g. the `<target>` of `codegraph brief`.
    _positionals: positionals,
  };
}
