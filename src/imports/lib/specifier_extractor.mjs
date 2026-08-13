// Extract raw import specifier strings from a source file using the standard
// TypeScript pre-processor. `ts.preProcessFile` walks the token stream (not a
// full parse) and reports every module referenced by:
//   - `import … from '…'` / `export … from '…'`
//   - bare `import '…'`
//   - dynamic `import('…')` with a string-literal argument
//   - `require('…')` (only when detectJavaScriptImports is on)
// Computed specifiers (e.g. `import(variable)`) are not literals and are
// therefore not reported, which is exactly what we want.

import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * @param {string} filePath absolute path of the importing file (used only when
 *        `text` is omitted, so callers may pass just the path).
 * @param {string} [text] file contents; read from `filePath` when undefined.
 * @returns {string[]} import specifier strings, in source order (duplicates kept).
 */
export function extractSpecifiers(filePath, text) {
  const source = text ?? readFileSync(filePath, 'utf8');
  const info = ts.preProcessFile(source, /* readImportFiles */ true, /* detectJavaScriptImports */ true);
  return info.importedFiles.map((f) => f.fileName);
}
