// `show` — the source of exactly one symbol, and nothing else.
//
// `buildShow(ref, {files, readFile, context})` is PURE given its injected
// reader: it locates the declaration, slices its source and returns a payload.
//
// THE IMPORTANT DECISION — the source range is computed by RE-PARSING the file
// at call time with the TypeScript AST, never from line numbers stored in the
// graph. The cache can be stale (it is a snapshot of a revision, and the file
// may have moved on), and printing code by a stale line number would silently
// show the WRONG lines under a header claiming they are the symbol — a
// correctness bug that misleads instead of failing. The graph is therefore used
// only to narrow down WHICH FILES to look in; what the file says now is decided
// by the file.
//
// Ambiguity is never resolved by guessing: two declarations of the same name in
// different files come back as a candidate list. The one exception is adjacent
// declarations of the same name in the same file — TypeScript overload
// signatures and declaration merging — which are one symbol written in several
// statements and are merged into a single range.

import ts from 'typescript';
import { attachedCommentRange } from '../../lib/ts_doc.mjs';
import { resolveFilePath } from '../../lib/path_match.mjs';

/** Default surrounding context, in lines. */
export const DEFAULT_CONTEXT = 0;

/** Beyond this many lines a symbol is flagged as large — still printed. */
export const LARGE_SYMBOL_LINES = 200;

/** How many near-misses a `not-found` carries. */
const SUGGESTION_CAP = 8;

/** Gap (in lines) within which same-name declarations count as one symbol. */
const MERGE_GAP = 2;

/**
 * Split a symbol reference into `{path, name}`.
 * Accepts `name`, `path#name` and `sym:path#name`. Returns null when unusable.
 */
export function parseSymbolRef(ref) {
  if (typeof ref !== 'string') return null;
  const raw = ref.trim().replace(/^sym:/, '');
  if (raw.length === 0) return null;
  const hash = raw.lastIndexOf('#');
  if (hash === -1) return { path: null, name: raw };
  const path = raw.slice(0, hash);
  const name = raw.slice(hash + 1);
  if (name.length === 0) return null;
  return { path: path.length > 0 ? path : null, name };
}

// ---- declarations in one file ------------------------------------------

function nameOfBinding(node, sf) {
  try {
    return ts.isIdentifier(node) ? node.text : node.getText(sf);
  } catch {
    return null;
  }
}

/**
 * Every TOP-LEVEL declaration in one file, with the exact character range of
 * its source (including an attached doc comment) as the file reads RIGHT NOW.
 *
 * @param {string} relPath repo-relative path (its extension picks the script kind).
 * @param {string} text file contents.
 * @returns {Array<{name, kind, startLine, endLine, declarationLine, pos, end}>}
 */
export function declarationsIn(relPath, text) {
  const src = typeof text === 'string' ? text : '';
  const sf = ts.createSourceFile(relPath, src, ts.ScriptTarget.Latest, true);
  const lineAt = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out = [];

  const emit = (node, name, kind) => {
    if (!name) return;
    let start;
    let end;
    try {
      start = node.getStart(sf);
      end = node.getEnd();
    } catch {
      return;
    }
    const doc = attachedCommentRange(src, node, sf);
    const pos = doc ? doc.pos : start;
    out.push({
      name,
      kind,
      pos,
      end,
      startLine: lineAt(pos),
      endLine: lineAt(Math.max(pos, end - 1)),
      declarationLine: lineAt(start),
    });
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) emit(stmt, stmt.name?.text ?? 'default', 'function');
    else if (ts.isClassDeclaration(stmt)) emit(stmt, stmt.name?.text ?? 'default', 'class');
    else if (ts.isInterfaceDeclaration(stmt)) emit(stmt, stmt.name.text, 'interface');
    else if (ts.isTypeAliasDeclaration(stmt)) emit(stmt, stmt.name.text, 'type');
    else if (ts.isEnumDeclaration(stmt)) emit(stmt, stmt.name.text, 'enum');
    else if (ts.isModuleDeclaration(stmt)) emit(stmt, nameOfBinding(stmt.name, sf), 'namespace');
    else if (ts.isVariableStatement(stmt)) {
      // The printed range is the whole STATEMENT, so `export const x = …` keeps
      // its `export const` — a declaration without its keywords is not source.
      for (const decl of stmt.declarationList.declarations) {
        emit(stmt, nameOfBinding(decl.name, sf), 'variable');
      }
    }
  }
  return out;
}

/**
 * Fold overload signatures / merged declarations into one entry: same name,
 * same file, separated by at most `MERGE_GAP` lines.
 */
function mergeAdjacent(hits) {
  const sorted = [...hits].sort((a, b) => a.pos - b.pos);
  const merged = [];
  for (const hit of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.path === hit.path && prev.name === hit.name
      && hit.startLine - prev.endLine <= MERGE_GAP) {
      prev.end = Math.max(prev.end, hit.end);
      prev.endLine = Math.max(prev.endLine, hit.endLine);
      continue;
    }
    merged.push({ ...hit });
  }
  return merged;
}

// ---- the lookup ---------------------------------------------------------

/**
 * Locate `ref` and slice its source.
 *
 * @param {string} ref `name`, `path#name` or `sym:path#name`.
 * @param {object} opts
 * @param {string[]} opts.files repo-relative candidate paths to search.
 * @param {(path: string) => string|null} opts.readFile reads one candidate.
 * @param {number} [opts.context] lines of surrounding context (default 0).
 * @returns {object} `symbol` / `ambiguous` / `not-found`.
 */
export function buildShow(ref, { files = [], readFile, context = DEFAULT_CONTEXT } = {}) {
  const parsed = parseSymbolRef(ref);
  if (!parsed) {
    return { kind: 'not-found', symbol: ref ?? null, error: 'symbol must be a non-empty string', candidates: [] };
  }
  const ctx = Number.isInteger(context) && context > 0 ? context : 0;

  // A `path#name` ref narrows the search the same forgiving way a file target
  // is resolved anywhere else — `b.ts#loadCart` is enough.
  let searchIn = files;
  if (parsed.path) {
    const { matches } = resolveFilePath(files, parsed.path);
    searchIn = matches.length > 0 ? matches : [parsed.path];
  }

  const hits = [];
  const nearMisses = [];
  const needle = parsed.name.toLowerCase();
  for (const path of searchIn) {
    const text = readFile(path);
    if (typeof text !== 'string') continue;
    // Cheap pre-filter: no occurrence of the name, no reason to parse.
    if (!text.includes(parsed.name)) {
      if (nearMisses.length < SUGGESTION_CAP && parsed.path === null) {
        for (const d of declarationsIn(path, text)) {
          if (d.name.toLowerCase().includes(needle) || needle.includes(d.name.toLowerCase())) {
            nearMisses.push({ name: d.name, path, line: d.declarationLine, kind: d.kind });
          }
        }
      }
      continue;
    }
    for (const d of declarationsIn(path, text)) {
      if (d.name === parsed.name) hits.push({ ...d, path, text });
      else if (nearMisses.length < SUGGESTION_CAP
        && (d.name.toLowerCase().includes(needle) || needle.includes(d.name.toLowerCase()))) {
        nearMisses.push({ name: d.name, path, line: d.declarationLine, kind: d.kind });
      }
    }
  }

  const merged = mergeAdjacent(hits);

  if (merged.length === 0) {
    return {
      kind: 'not-found',
      symbol: ref,
      name: parsed.name,
      candidates: nearMisses.slice(0, SUGGESTION_CAP),
    };
  }
  if (merged.length > 1) {
    return {
      kind: 'ambiguous',
      symbol: ref,
      name: parsed.name,
      total: merged.length,
      candidates: merged.map((h) => ({
        id: `sym:${h.path}#${h.name}`, path: h.path, line: h.declarationLine, kind: h.kind,
      })),
    };
  }

  const hit = merged[0];
  const lines = hit.text.split('\n');
  const startLine = Math.max(1, hit.startLine - ctx);
  const endLine = Math.min(lines.length, hit.endLine + ctx);
  const source = lines.slice(startLine - 1, endLine).join('\n');
  const lineCount = endLine - startLine + 1;

  return {
    kind: 'symbol',
    symbol: ref,
    id: `sym:${hit.path}#${hit.name}`,
    path: hit.path,
    name: hit.name,
    symbolKind: hit.kind,
    startLine,
    endLine,
    declarationLine: hit.declarationLine,
    lines: lineCount,
    context: ctx,
    large: lineCount > LARGE_SYMBOL_LINES,
    source,
  };
}

// ---- formatting ---------------------------------------------------------

/** Render a `show` payload: one header line, then the source with line numbers. */
export function formatShow(r) {
  if (!r) return '';
  if (r.kind === 'ambiguous') {
    return [`ambiguous symbol "${r.name}" — ${r.total} candidates:`]
      .concat(r.candidates.map((c) => `  ${c.path}:${c.line}  ${c.kind} ${c.name ?? r.name}`))
      .join('\n');
  }
  if (r.kind === 'not-found') {
    return [`no symbol "${r.name ?? r.symbol}"${r.error ? ` — ${r.error}` : ''}`]
      .concat(r.candidates?.length
        ? ['did you mean:', ...r.candidates.map((c) => `  ${c.name}  ${c.path}:${c.line}`)]
        : [])
      .join('\n');
  }

  const meta = [`${r.lines} lines`];
  if (r.context > 0) meta.push(`+${r.context} context`);
  if (r.large) meta.push('large');
  const header = `${r.path}:${r.startLine}-${r.endLine}  ${r.symbolKind} ${r.name}  (${meta.join(', ')})`;

  const width = String(r.endLine).length;
  const body = r.source.split('\n')
    .map((line, i) => `${String(r.startLine + i).padStart(width)} | ${line}`);
  return [header, ...body].join('\n');
}
