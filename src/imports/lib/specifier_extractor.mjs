// Extract raw import specifier strings from a source file using the standard
// TypeScript pre-processor. `ts.preProcessFile` walks the token stream (not a
// full parse) and reports every module referenced by:
//   - `import … from '…'` / `export … from '…'`
//   - bare `import '…'`
//   - dynamic `import('…')` with a string-literal argument
//   - `require('…')` (only when detectJavaScriptImports is on)
// Computed specifiers (e.g. `import(variable)`) are not literals and are
// therefore not reported, which is exactly what we want.
//
// …but "not reported" used to mean "invisible". A computed dynamic import is a
// real edge in the running program that NOTHING static can follow — not this
// tool, not the TypeScript type-checker — so a module reached only that way looks
// unreachable, and its exports get reported as dead. We still cannot resolve
// them. What we can do is COUNT them, so the uncertainty is stated instead of
// silent wherever it changes how an answer should be read.
//
// Counting them needs a real parse, because "is this specifier a literal" is a
// question about syntax that a token scan cannot answer without also finding
// `import(` inside strings, comments and regular expressions. So `scanImports`
// parses — but only files whose text can possibly contain a dynamic import at
// all, which the `MAYBE_DYNAMIC_IMPORT` pre-filter decides in one regex.

import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * `import` followed by nothing but trivia and then `(` — the only shape a
 * dynamic import can take. Deliberately over-matches (`import` inside a string
 * or comment counts), because a false positive costs one parse that then finds
 * nothing, while a false negative would lose a site silently.
 */
const MAYBE_DYNAMIC_IMPORT = /\bimport\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*\(/;

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

/**
 * How many `import(…)` call sites in `source` have a specifier that is NOT a
 * literal — the ones no static analysis can follow.
 *
 * A no-substitution template (`` import(`./a.mjs`) ``) IS a literal: its text is
 * fixed, and the pre-processor resolves it like a quoted string. A template with
 * a substitution is not.
 */
function countComputedDynamicImports(filePath, source) {
  if (!MAYBE_DYNAMIC_IMPORT.test(source)) return 0;

  // Parent pointers are not needed (we only ever look downwards), and skipping
  // them makes the parse meaningfully cheaper. The script kind is inferred from
  // the file name, so .tsx / .jsx parse as JSX rather than as comparisons.
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ESNext, /* setParentNodes */ false);

  let count = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      const literal = specifier !== undefined
        && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier));
      if (!literal) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

/**
 * Both facts about a file's imports, from ONE read of its text: the specifiers
 * we can resolve, and how many dynamic imports we cannot.
 *
 * @param {string} filePath absolute path of the importing file.
 * @param {string} [text] file contents; read from `filePath` when undefined.
 * @returns {{specifiers: string[], computedDynamicImports: number}}
 */
export function scanImports(filePath, text) {
  const source = text ?? readFileSync(filePath, 'utf8');
  return {
    specifiers: extractSpecifiers(filePath, source),
    computedDynamicImports: countComputedDynamicImports(filePath, source),
  };
}
