// Shared TypeScript type-checker resolution helpers, used by the reference
// (file→symbol) and usage (symbol→symbol) layers. Both walk the AST and, for
// each Identifier that is a *usage*, resolve it via the checker — following
// import aliases and re-export chains — back to the ORIGINAL declaration, then
// map that declaration to a `sym:<relPath>#<name>` id (a membership test against
// the known Symbol nodes).
//
// These helpers isolate the subtle, shared bits so the two layers can't drift:
//   * what is a declaration/binding SITE (never a usage) vs. object-literal
//     shorthand (a read of the outer variable),
//   * following an alias to its aliased symbol,
//   * mapping an absolute path to a repo-relative POSIX path, and
//   * recovering the real name behind a `default` export.

import ts from 'typescript';
import { relative } from 'node:path';
import { normPosix } from '../inventory/schema.mjs';

/**
 * The sensible bundler-ish default when a repo ships no tsconfig: accept JS,
 * resolve like a bundler, don't type-check JS or emit anything. Callers may
 * substitute options parsed from a real tsconfig.
 */
export function defaultCompilerOptions() {
  return {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
  };
}

// Declaration kinds whose `.name` identifier introduces a binding — the token IS
// the declaration site, never a reference. Object-literal shorthand is handled
// separately (its name is a *usage* of the outer variable), so it is absent here.
const DECLARATION_NAME_PARENTS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.TypeParameter,
  // Import/export binding sites — importing is not, by itself, a usage.
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.NamespaceExport,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ExportSpecifier,
]);

/** True when `id` is the declared name of its parent declaration. */
export function isDeclarationName(id) {
  const parent = id.parent;
  return parent != null && parent.name === id && DECLARATION_NAME_PARENTS.has(parent.kind);
}

/** The object-literal shorthand `{ foo }`, whose name is a read of `foo`. */
export function isShorthandValue(id) {
  const parent = id.parent;
  return parent != null && ts.isShorthandPropertyAssignment(parent) && parent.name === id;
}

/** repo-relative POSIX path, or null when the file lives outside the repo. */
export function toRepoRel(repoRoot, absPath) {
  const rel = normPosix(relative(repoRoot, absPath));
  if (rel === '' || rel.startsWith('../') || rel === '..') return null;
  return rel;
}

/** Follow an alias symbol to the symbol it ultimately refers to. */
export function resolveAlias(checker, symbol) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol; // unresolvable alias (e.g. import from an unresolved module)
    }
  }
  return symbol;
}

/**
 * The declared name to compare against the symbols layer. Symbols are keyed by
 * their declaration's written name, so prefer the symbol name — but recover the
 * real name for `export default function foo` (where the symbol is "default").
 */
export function declaredName(symbol, decl) {
  const name = symbol.getName();
  if (name === 'default' && decl) {
    const declName = ts.getNameOfDeclaration(decl);
    if (declName && ts.isIdentifier(declName)) return declName.text;
  }
  return name;
}
