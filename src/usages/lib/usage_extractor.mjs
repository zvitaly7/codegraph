// Resolve, for each declared SYMBOL, which OTHER declared symbols its body
// references — producing symbol→symbol USES edges. This powers "most-connected
// symbols" (a symbol's total USES degree).
//
// Like the references layer, resolution is done by the TypeScript type-checker
// (not a hand-rolled scope walker), so a bare `foo()` is tied back to wherever
// `foo` was declared, following import aliases and re-export chains to the
// ORIGINAL declaration. The DIFFERENCE from references: every resolved use is
// attributed to the ENCLOSING top-level symbol (the "from"), not to its file.
//
// How the enclosing symbol is tracked: we walk each SourceFile keeping a stack
// of the current enclosing TOP-LEVEL declaration's symbol id. We push when we
// enter a top-level function / class / interface / type-alias / enum, or a
// top-level variable declarator (its initializer subtree belongs to it); we pop
// on the way out. A use is attributed to the stack top. Uses at module top level
// (empty stack) are skipped — USES is symbol→symbol. Self-uses (recursion) and
// targets outside the known symbol set are skipped. Deduped per (from, to).

import ts from 'typescript';
import {
  isDeclarationName,
  isShorthandValue,
  toRepoRel,
  resolveAlias,
  declaredName,
} from '../../lib/ts_resolve.mjs';

/** The base `sym:<path>#<name>` id if it names a known symbol, else null. */
function knownSymId(path, name, symbolIds) {
  const id = `sym:${path}#${name}`;
  return symbolIds.has(id) ? id : null;
}

/**
 * The symbol id a node introduces as a NEW enclosing scope, or null. Only
 * top-level declarations count — named declarations sit directly under the
 * SourceFile, and a variable declarator's chain is SourceFile > VariableStatement
 * > VariableDeclarationList > VariableDeclaration. Requiring top-level-ness is
 * what stops a nested `function foo` (whose name may collide with a top-level
 * symbol) from being mistaken for the enclosing symbol.
 *
 * Destructuring declarators (`const { a, b } = f()`) bind several names to one
 * shared initializer — genuinely ambiguous ownership — so we don't guess: the
 * initializer's uses fall through to the enclosing stack (empty at top level).
 */
function enclosingSymId(node, path, symbolIds) {
  const parent = node.parent;

  if (parent && ts.isSourceFile(parent)) {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      return knownSymId(path, node.name?.text ?? 'default', symbolIds);
    }
    if (
      ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isEnumDeclaration(node)
    ) {
      return knownSymId(path, node.name.text, symbolIds);
    }
  }

  if (
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && parent && ts.isVariableDeclarationList(parent)
    && parent.parent && ts.isVariableStatement(parent.parent)
    && parent.parent.parent && ts.isSourceFile(parent.parent.parent)
  ) {
    return knownSymId(path, node.name.text, symbolIds);
  }

  return null;
}

/**
 * @param {object} args
 * @param {string[]} args.fileNames absolute paths of the source files to analyze
 *        (they also seed the program; the checker may pull in more on demand).
 * @param {import('typescript').CompilerOptions} args.options compiler options.
 * @param {Set<string>} args.symbolIds resolvable endpoints — Symbol node ids of
 *        the form `sym:<relPath>#<name>`.
 * @param {string} args.repoRoot absolute repo root (for relative paths).
 * @returns {Array<{fromSymId:string, toSymId:string}>} deduped per (from, to),
 *          sorted deterministically.
 */
export function extractUsages({ fileNames, options, symbolIds, repoRoot }) {
  const roots = [...fileNames].sort();
  const program = ts.createProgram(roots, options);
  const checker = program.getTypeChecker();

  const seen = new Map(); // `${fromSymId} ${toSymId}` → record

  for (const fileName of roots) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue; // failed to load — skip gracefully
    const path = toRepoRel(repoRoot, sf.fileName);
    if (path === null) continue;

    const stack = []; // enclosing top-level symbol ids (depth is 0 or 1)

    const visit = (node) => {
      const pushed = enclosingSymId(node, path, symbolIds);
      if (pushed) stack.push(pushed);

      if (ts.isIdentifier(node) && stack.length > 0) {
        resolveIdentifier(node, stack[stack.length - 1]);
      }
      ts.forEachChild(node, visit);

      if (pushed) stack.pop();
    };
    visit(sf);
  }

  function resolveIdentifier(id, fromSymId) {
    const shorthand = isShorthandValue(id);
    if (!shorthand && isDeclarationName(id)) return; // declaration site, not a use

    let symbol = shorthand
      ? checker.getShorthandAssignmentValueSymbol(id.parent)
      : checker.getSymbolAtLocation(id);
    if (!symbol) return;

    symbol = resolveAlias(checker, symbol);
    const decl = symbol?.declarations?.[0];
    if (!decl) return;

    const declPath = toRepoRel(repoRoot, decl.getSourceFile().fileName);
    if (declPath === null) return; // declared outside the repo (lib.d.ts, deps)

    const name = declaredName(symbol, decl);
    if (!name) return;

    const toSymId = `sym:${declPath}#${name}`;
    if (!symbolIds.has(toSymId)) return;
    if (toSymId === fromSymId) return; // self-use (e.g. recursion) — not an edge

    const key = `${fromSymId} ${toSymId}`;
    if (!seen.has(key)) seen.set(key, { fromSymId, toSymId });
  }

  return [...seen.values()].sort((a, b) => {
    if (a.fromSymId !== b.fromSymId) return a.fromSymId < b.fromSymId ? -1 : 1;
    if (a.toSymId !== b.toSymId) return a.toSymId < b.toSymId ? -1 : 1;
    return 0;
  });
}
