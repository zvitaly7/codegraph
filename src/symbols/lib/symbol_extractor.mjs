// Extract top-level symbol DECLARATIONS from a single source file using the
// TypeScript parser (AST only — no type-checker, so this stays light and fast).
//
// We look at `sourceFile.statements` and never recurse into function/class
// bodies or namespace blocks, so only module-scope declarations are reported:
//   function · class · interface · type-alias · enum · variable statement.
//
// A symbol is `exported` when its declaration carries an `export` modifier, OR
// its local name appears in a same-module `export { … }` clause, OR it is the
// target of an `export default <name>` / `export = <name>`.
//
// Returned in source order as `{ name, kind, exported, line }` (line is 1-based).
// Within-file name collisions (e.g. function overloads, declaration merging)
// are surfaced as separate entries — de-duplication of ids is the graph's job.

import ts from 'typescript';

/** True when `node` carries a modifier of the given SyntaxKind. */
function hasModifier(node, kind) {
  const mods = node.modifiers;
  return Array.isArray(mods) && mods.some((m) => m.kind === kind);
}

/** Flatten a binding name (identifier or destructuring pattern) to leaf names. */
function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  const out = [];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      // Array holes (`[a, , b]`) are OmittedExpression — not BindingElement.
      if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
    }
  }
  return out;
}

/**
 * Export intent that lives in statements OTHER than the declaration itself:
 *  - local `export { a, b as c }` (no `from`) → the LOCAL names a, b.
 *  - `export default <ident>` / `export = <ident>` → that identifier.
 *
 * Exported because `outline` decides "is this exported?" the same way, and the
 * rule is subtle enough that two copies of it would drift.
 *
 * @param {import('typescript').SourceFile} sf
 * @returns {{exportedByClause: Set<string>, defaultName: string|undefined}}
 */
export function collectExportIntent(sf) {
  const exportedByClause = new Set();
  let defaultName;
  for (const stmt of sf.statements) {
    if (
      ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier
      && stmt.exportClause && ts.isNamedExports(stmt.exportClause)
    ) {
      for (const spec of stmt.exportClause.elements) {
        exportedByClause.add((spec.propertyName ?? spec.name).text);
      }
    } else if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      defaultName = stmt.expression.text;
    }
  }
  return { exportedByClause, defaultName };
}

/**
 * @param {string} relPath repo-relative path — its extension selects the TS
 *        script kind (e.g. `.tsx` enables JSX), so pass the real path.
 * @param {string} text file contents.
 * @returns {Array<{name:string, kind:string, exported:boolean, line:number}>}
 */
export function extractSymbols(relPath, text) {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);

  const { exportedByClause, defaultName } = collectExportIntent(sf);

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const isExported = (name, byKeyword) => byKeyword || exportedByClause.has(name) || name === defaultName;

  const symbols = [];
  const emit = (node, name, kind, byKeyword) => {
    symbols.push({ name, kind, exported: isExported(name, byKeyword), line: lineOf(node) });
  };

  for (const stmt of sf.statements) {
    const exportKeyword = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);

    if (ts.isFunctionDeclaration(stmt)) {
      emit(stmt, stmt.name?.text ?? 'default', 'function', exportKeyword);
    } else if (ts.isClassDeclaration(stmt)) {
      emit(stmt, stmt.name?.text ?? 'default', 'class', exportKeyword);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      emit(stmt, stmt.name.text, 'interface', exportKeyword);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      emit(stmt, stmt.name.text, 'type', exportKeyword);
    } else if (ts.isEnumDeclaration(stmt)) {
      emit(stmt, stmt.name.text, 'enum', exportKeyword);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        for (const name of bindingNames(decl.name)) emit(decl, name, 'variable', exportKeyword);
      }
    } else if (
      ts.isExportAssignment(stmt) && !stmt.isExportEquals && !ts.isIdentifier(stmt.expression)
    ) {
      // Anonymous default value: `export default 42` / `{…}` / `() => …`.
      // (`export default function/class` are declarations, handled above;
      //  `export default <ident>` only flips an existing declaration.)
      emit(stmt, 'default', 'variable', true);
    }
  }

  return symbols;
}
