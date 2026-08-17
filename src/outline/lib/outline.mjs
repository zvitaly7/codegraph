// `outline` — a file's skeleton: what it declares, without the bodies.
//
// `buildOutline(relPath, text, opts)` is PURE and needs no graph: it parses the
// text with the TypeScript parser (`ts.createSourceFile`, parse-only — no
// type-checker, no program, so it stays fast) and returns
//   - the module's imports, compacted to specifiers;
//   - every TOP-LEVEL declaration: kind, name, exported, line range, a one-line
//     signature and the first line of an attached comment;
//   - for classes, their public members — one level deep, never recursive.
// Bodies are never included. That is the whole point: an agent that wants to
// know what lives in a 900-line file reads ~20 lines instead of the file.
//
// Two deliberate limits, so the output is never mistaken for the file itself:
//   - only module-scope statements are walked (a declaration nested inside a
//     function or a namespace body is invisible here, exactly as in the
//     `symbols` layer);
//   - a comment block sitting directly above a declaration is treated as that
//     declaration's doc, which for the FIRST statement in a file can pick up a
//     module header comment instead.
//
// A file with syntax errors still yields whatever the parser recovered, with
// `parseErrors` set — degrading beats throwing when an agent is mid-edit.

import ts from 'typescript';
import { collectExportIntent } from '../../symbols/lib/symbol_extractor.mjs';
import { attachedCommentRange, firstDocLine } from '../../lib/ts_doc.mjs';

/** Default cap on the declaration / member / import lists. */
export const DEFAULT_LIMIT = 100;

/** Longest initializer/expression fragment printed inside a signature. */
const MAX_FRAGMENT = 40;

// ---- small helpers ------------------------------------------------------

function hasModifier(node, kind) {
  const mods = node.modifiers;
  return Array.isArray(mods) && mods.some((m) => m.kind === kind);
}

/** One-line, length-capped rendering of a source fragment. */
function fragment(text, max = MAX_FRAGMENT) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Safe `node.getText()` — a recovered parse tree can hold odd ranges. */
function textOf(node, sf) {
  try {
    return node.getText(sf);
  } catch {
    return '';
  }
}

/** First line of the comment block attached to `node`, or null. */
function docOf(text, node, sf) {
  const range = attachedCommentRange(text, node, sf);
  return range ? firstDocLine(text.slice(range.pos, range.end)) : null;
}

// ---- signatures ---------------------------------------------------------

function typeParams(node, sf) {
  const list = node.typeParameters;
  return list?.length ? `<${list.map((p) => textOf(p, sf)).join(', ')}>` : '';
}

/** `name<T>(a: string, b?: N): R` — params and return type exactly as written. */
function functionSignature(node, name, sf) {
  const params = (node.parameters ?? []).map((p) => fragment(textOf(p, sf), 60)).join(', ');
  const ret = node.type ? `: ${fragment(textOf(node.type, sf), 60)}` : '';
  return `${name}${typeParams(node, sf)}(${params})${ret}`;
}

/** `Name<T> extends A implements B`. */
function classSignature(node, name, sf) {
  const heritage = (node.heritageClauses ?? []).map((h) => fragment(textOf(h, sf), 60)).join(' ');
  return `${name}${typeParams(node, sf)}${heritage ? ` ${heritage}` : ''}`;
}

/**
 * What a variable is initialized to, when that is trivially readable from the
 * source text — `arrow fn`, `object`, `create(…)`, `'cart'`. Anything else
 * (a conditional, a template with substitutions, an await) yields null rather
 * than a guess.
 */
function initializerKind(init, sf) {
  if (!init) return null;
  if (ts.isArrowFunction(init)) return 'arrow fn';
  if (ts.isFunctionExpression(init)) return 'function';
  if (ts.isClassExpression(init)) return 'class';
  if (ts.isNewExpression(init)) return `new ${fragment(textOf(init.expression, sf), 24)}(…)`;
  if (ts.isCallExpression(init)) return `${fragment(textOf(init.expression, sf), 24)}(…)`;
  if (ts.isObjectLiteralExpression(init)) return 'object';
  if (ts.isArrayLiteralExpression(init)) return 'array';
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) || ts.isNumericLiteral(init)) {
    return fragment(textOf(init, sf), 32);
  }
  if (init.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (init.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (init.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isIdentifier(init)) return fragment(init.text, 24);
  // `x as T`, `x satisfies T`, `(x)` — the wrapper says nothing, the inside does.
  if (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)
    || (ts.isSatisfiesExpression?.(init) ?? false)) {
    return initializerKind(init.expression, sf);
  }
  return null;
}

/** `name: T = arrow fn` — whichever of the two halves the source actually has. */
function variableSignature(decl, name, sf) {
  const type = decl.type ? `: ${fragment(textOf(decl.type, sf), 48)}` : '';
  const init = initializerKind(decl.initializer, sf);
  return `${name}${type}${init ? ` = ${init}` : ''}`;
}

// ---- class members ------------------------------------------------------

/** A class member is "public" unless it says otherwise (or uses a `#name`). */
function isPublicMember(member) {
  if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) return false;
  if (hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) return false;
  return !(member.name && ts.isPrivateIdentifier(member.name));
}

function memberEntry(member, sf) {
  const kind = ts.isMethodDeclaration(member) ? 'method'
    : ts.isGetAccessor(member) ? 'getter'
      : ts.isSetAccessor(member) ? 'setter'
        : ts.isConstructorDeclaration(member) ? 'constructor'
          : ts.isPropertyDeclaration(member) ? 'property'
            : null;
  if (kind === null) return null; // index signature, static block, semicolon
  if (!isPublicMember(member)) return null;

  const name = kind === 'constructor' ? 'constructor' : textOf(member.name, sf);
  if (!name) return null;
  const signature = kind === 'property'
    ? variableSignature(member, name, sf)
    : functionSignature(member, name, sf);

  return {
    name,
    kind,
    static: hasModifier(member, ts.SyntaxKind.StaticKeyword),
    line: sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1,
    signature,
  };
}

// ---- the outline --------------------------------------------------------

function cap(list, limit) {
  return { count: list.length, list: list.slice(0, limit), truncated: list.length > limit };
}

/** `export { a } from './x'` / `export * from './x'` rendered as written. */
function reexportSignature(stmt, sf) {
  const spec = stmt.moduleSpecifier.text;
  if (!stmt.exportClause) return `* from '${spec}'`;
  if (ts.isNamespaceExport(stmt.exportClause)) return `* as ${textOf(stmt.exportClause.name, sf)} from '${spec}'`;
  const names = stmt.exportClause.elements.map((e) => textOf(e.name, sf)).join(', ');
  return `{ ${fragment(names, 60)} } from '${spec}'`;
}

/** `const x = require('y')` — the CJS spelling of an import. */
function requireSpecifier(decl) {
  const init = decl.initializer;
  if (!init || !ts.isCallExpression(init)) return null;
  if (!ts.isIdentifier(init.expression) || init.expression.text !== 'require') return null;
  const arg = init.arguments[0];
  return arg && ts.isStringLiteral(arg) ? arg.text : null;
}

/**
 * Parse `text` and describe what it declares.
 *
 * @param {string} relPath repo-relative path — its extension selects the script
 *        kind (`.tsx` enables JSX), so pass the real path.
 * @param {string} text file contents.
 * @param {{limit?: number}} [opts] cap for the import / declaration / member lists.
 * @returns {object} the `outline` shape (see formatOutline for the rendering).
 */
export function buildOutline(relPath, text, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const src = typeof text === 'string' ? text : '';
  const sf = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, true);
  const { exportedByClause, defaultName } = collectExportIntent(sf);

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const endLineOf = (node) => sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const isExported = (name, byKeyword) => byKeyword || exportedByClause.has(name) || name === defaultName;

  const imports = [];
  const seenImports = new Set();
  const addImport = (spec) => {
    if (typeof spec !== 'string' || spec.length === 0 || seenImports.has(spec)) return;
    seenImports.add(spec);
    imports.push(spec);
  };

  const declarations = [];
  const add = (node, { name, kind, exported, signature, members }) => {
    declarations.push({
      name,
      kind,
      exported,
      default: hasModifier(node, ts.SyntaxKind.DefaultKeyword),
      async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
      generator: node.asteriskToken != null,
      startLine: lineOf(node),
      endLine: endLineOf(node),
      signature,
      doc: docOf(src, node, sf),
      ...(members ? { members } : {}),
    });
  };

  for (const stmt of sf.statements) {
    const byKeyword = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);

    if (ts.isImportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) addImport(stmt.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      const ref = stmt.moduleReference;
      if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteral(ref.expression)) {
        addImport(ref.expression.text);
      }
    } else if (ts.isFunctionDeclaration(stmt)) {
      const name = stmt.name?.text ?? 'default';
      add(stmt, {
        name,
        kind: 'function',
        exported: isExported(name, byKeyword),
        signature: functionSignature(stmt, name, sf),
      });
    } else if (ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text ?? 'default';
      const members = (stmt.members ?? []).map((m) => memberEntry(m, sf)).filter(Boolean);
      add(stmt, {
        name,
        kind: 'class',
        exported: isExported(name, byKeyword),
        signature: classSignature(stmt, name, sf),
        members: cap(members, limit),
      });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      add(stmt, {
        name: stmt.name.text,
        kind: 'interface',
        exported: isExported(stmt.name.text, byKeyword),
        signature: `${stmt.name.text}${typeParams(stmt, sf)}`,
      });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      add(stmt, {
        name: stmt.name.text,
        kind: 'type',
        exported: isExported(stmt.name.text, byKeyword),
        signature: `${stmt.name.text}${typeParams(stmt, sf)}`,
      });
    } else if (ts.isEnumDeclaration(stmt)) {
      add(stmt, {
        name: stmt.name.text,
        kind: 'enum',
        exported: isExported(stmt.name.text, byKeyword),
        signature: stmt.name.text,
      });
    } else if (ts.isModuleDeclaration(stmt)) {
      const name = textOf(stmt.name, sf);
      add(stmt, {
        name,
        kind: 'namespace',
        exported: isExported(name, byKeyword),
        signature: name,
      });
    } else if (ts.isVariableStatement(stmt)) {
      const keyword = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0 ? 'const'
        : (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0 ? 'let' : 'var';
      for (const decl of stmt.declarationList.declarations) {
        addImport(requireSpecifier(decl));
        // Destructuring keeps its pattern as the name (`{ a, b }`) — that is
        // what the source says, and splitting it would invent declarations.
        const name = ts.isIdentifier(decl.name) ? decl.name.text : fragment(textOf(decl.name, sf), 48);
        declarations.push({
          name,
          kind: keyword,
          exported: isExported(name, byKeyword),
          default: false,
          async: false,
          generator: false,
          startLine: lineOf(stmt),
          endLine: endLineOf(stmt),
          signature: variableSignature(decl, name, sf),
          doc: docOf(src, stmt, sf),
        });
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      add(stmt, {
        name: stmt.moduleSpecifier.text,
        kind: 'reexport',
        exported: true,
        signature: reexportSignature(stmt, sf),
      });
    } else if (ts.isExportAssignment(stmt) && !ts.isIdentifier(stmt.expression)) {
      // `export default <value>` — an anonymous export with no declaration of
      // its own. (`export default <ident>` only flips an existing one.)
      add(stmt, {
        name: 'default',
        kind: 'default',
        exported: true,
        signature: initializerKind(stmt.expression, sf) ?? 'expression',
      });
    }
  }

  const capped = cap(declarations, limit);
  const cappedImports = cap(imports, limit);

  return {
    kind: 'outline',
    path: relPath,
    lines: src === '' ? 0 : src.split('\n').length,
    parseErrors: Array.isArray(sf.parseDiagnostics) ? sf.parseDiagnostics.length : 0,
    imports: { count: cappedImports.count, list: cappedImports.list, truncated: cappedImports.truncated },
    declarations: { count: capped.count, list: capped.list, truncated: capped.truncated },
  };
}

// ---- formatting ---------------------------------------------------------

/** `export async function foo(a: string): R` — the declaration as it reads. */
function head(d) {
  if (d.kind === 'reexport') return `export ${d.signature}`;
  if (d.kind === 'default') return `export default ${d.signature}`;
  const exported = d.exported ? (d.default ? 'export default ' : 'export ') : '';
  const kindWord = d.kind === 'function'
    ? `${d.async ? 'async ' : ''}function${d.generator ? '*' : ''}`
    : d.kind;
  return `${exported}${kindWord} ${d.signature}`;
}

/** Render an outline as a compact block — the thing an agent reads. */
export function formatOutline(o) {
  if (!o) return '';
  if (o.kind === 'ambiguous') {
    return [`ambiguous file "${o.target}" — ${o.total} candidates:`]
      .concat(o.candidates.map((p) => `  ${p}`))
      .concat(o.total > o.candidates.length ? [`  (+${o.total - o.candidates.length} more)`] : [])
      .join('\n');
  }
  if (o.kind === 'not-found') {
    return [`no file matching "${o.target}"`]
      .concat(o.candidates?.length ? ['did you mean:', ...o.candidates.map((p) => `  ${p}`)] : [])
      .join('\n');
  }

  const meta = [`${o.lines} lines`, `${o.declarations.count} declarations`];
  if (o.parseErrors > 0) meta.push(`${o.parseErrors} parse errors`);
  const lines = [`OUTLINE ${o.path}  (${meta.join(' · ')})`];

  const more = o.imports.count - o.imports.list.length;
  lines.push(`imports (${o.imports.count}): ${
    o.imports.list.length > 0 ? o.imports.list.join(', ') + (more > 0 ? ` (+${more} more)` : '') : '—'}`);

  const width = Math.max(0, ...o.declarations.list.map((d) => `L${d.startLine}-${d.endLine}`.length));
  for (const d of o.declarations.list) {
    const range = `L${d.startLine}-${d.endLine}`.padEnd(width);
    lines.push(`  ${range}  ${head(d)}${d.doc ? `  — ${d.doc}` : ''}`);
    for (const m of d.members?.list ?? []) {
      lines.push(`      ${m.signature}  ${m.static ? 'static ' : ''}${m.kind} L${m.line}`);
    }
    const hiddenMembers = (d.members?.count ?? 0) - (d.members?.list.length ?? 0);
    if (hiddenMembers > 0) lines.push(`      (+${hiddenMembers} more members)`);
  }
  const hidden = o.declarations.count - o.declarations.list.length;
  if (hidden > 0) lines.push(`  (+${hidden} more declarations)`);
  if (o.declarations.count === 0) lines.push('  (no top-level declarations)');

  return lines.join('\n');
}
