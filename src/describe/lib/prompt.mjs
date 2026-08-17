// Turning one describable target into one prompt.
//
// PURE: target in, string out. No I/O, no clock — the same target always yields
// the same prompt, which is what makes the content hash in ./targets.mjs a valid
// cache key.
//
// Two rules shape everything here:
//
//   1. The prompt is built from material that is ALREADY COMPUTED — the graph's
//      facts plus, for files and symbols, the `outline` (declarations without
//      bodies). A file body is never sent. Describing a 900-line file this way
//      costs the tokens of ~20 lines, and the unit tests assert that a body
//      cannot leak in.
//
//   2. The instruction asks for something small and specific, and tells the
//      model to say what it cannot determine instead of inventing it. The
//      answer is stored as generated text and always labelled as such, but that
//      is no excuse for encouraging a guess.

/** Longest single line kept from an outline signature. */
const MAX_SIGNATURE = 120;

/** The instruction block every prompt opens with. */
export const INSTRUCTION = [
  'You are documenting one item in a code repository for other engineers and AI agents.',
  '',
  'Write 1-2 sentences: what it is, and the role it plays in this codebase.',
  'Rules:',
  '- Plain prose. No markdown, no bullet points, no headings, no code fences.',
  '- Do not restate the name or path; the reader already has them.',
  '- No filler ("this file contains", "a module that", "responsible for handling various").',
  '- Only claim what the facts below support. If they do not tell you what something',
  '  is for, say so plainly (e.g. "purpose is not determinable from its structure")',
  '  rather than guessing.',
  '- Do not include internal or system XML tags in your response.',
  '- Reply with the description only — no preamble, no quotes around it.',
].join('\n');

/** `a, b, c` — or `none` for an empty list. */
function list(items) {
  const arr = (items ?? []).filter((x) => x !== null && x !== undefined && x !== '');
  return arr.length > 0 ? arr.join(', ') : 'none';
}

/** `name (3)` for the `{name, n}` shape the fact lists use. */
const weighted = (entries) => list((entries ?? []).map((e) => `${e.name} (${e.n})`));

function truncate(text, max = MAX_SIGNATURE) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The outline rendered as one line per declaration: kind, name, signature and
 * the first line of its doc comment. Bodies are not part of the outline shape
 * at all, so there is nothing here that could carry one.
 */
function renderOutline(outline) {
  const decls = outline?.declarations?.list ?? [];
  if (decls.length === 0) return null;
  const lines = decls.map((d) => {
    const exported = d.exported ? 'export ' : '';
    const signature = truncate(d.signature ?? d.name);
    const doc = d.doc ? `  — ${truncate(d.doc, 100)}` : '';
    return `  ${exported}${d.kind} ${signature}${doc}`;
  });
  const hidden = (outline.declarations.count ?? decls.length) - decls.length;
  if (hidden > 0) lines.push(`  (+${hidden} more declarations)`);
  return lines.join('\n');
}

function domainBody(f) {
  return [
    `DOMAIN ${f.name}`,
    `kind: ${f.domainKind ?? 'unknown'}`,
    `files: ${f.files}`,
    `depends on domains: ${weighted(f.dependsOn)}`,
    `depended on by domains: ${weighted(f.dependedOnBy)}`,
    `external packages (by files using them): ${weighted(f.packages)}`,
    `most-imported files in it (by importer count): ${weighted(f.topFiles)}`,
    `most-referenced exported symbols: ${list((f.exports ?? []).map((s) => `${s.name} ${s.kind ?? ''}`.trim() + ` (refs ${s.refs})`))}`,
  ].join('\n');
}

function fileBody(f) {
  return [
    `FILE ${f.path}`,
    `language: ${f.language ?? 'unknown'}   kind: ${f.fileKind ?? 'unknown'}   domain: ${f.domain ?? 'none'}`,
    `imports (internal): ${list(f.imports?.internal)}`,
    `imports (packages): ${list(f.imports?.external)}`,
    `imported by ${f.importedBy?.count ?? 0} file(s): ${list(f.importedBy?.files)}`,
    `exported symbols: ${list((f.exports ?? []).map((s) => `${s.name} ${s.kind ?? ''}`.trim() + ` (refs ${s.refs})`))}`,
  ].join('\n');
}

function symbolBody(f) {
  return [
    `SYMBOL ${f.name}`,
    `kind: ${f.symbolKind ?? 'unknown'}   ${f.exported ? 'exported' : 'local'}`,
    `declared in: ${f.path}${f.line ? `:${f.line}` : ''}   domain: ${f.domain ?? 'none'}`,
    `referenced by ${f.referencedBy?.count ?? 0} other file(s): ${list(f.referencedBy?.files)}`,
    `uses symbols: ${list(f.uses)}`,
    `used by symbols: ${list(f.usedBy)}`,
  ].join('\n');
}

/**
 * Build the prompt for one target.
 *
 * @param {object} target from ../lib/targets.mjs: `{kind, facts, outline}`.
 * @returns {string} the full prompt, written to the provider's stdin (or sent
 *   as the single user message).
 */
export function buildPrompt(target) {
  const facts = target?.facts ?? {};
  const body = target?.kind === 'domain' ? domainBody(facts)
    : target?.kind === 'symbol' ? symbolBody(facts)
      : fileBody(facts);

  const parts = [INSTRUCTION, '', 'FACTS FROM THE CODE GRAPH (these are proven by static analysis):', '', body];

  const outline = renderOutline(target?.outline);
  if (outline) {
    parts.push(
      '',
      target.kind === 'symbol'
        ? 'ITS DECLARATION (signature only, body omitted):'
        : 'ITS DECLARATIONS (signatures only, bodies omitted):',
      outline,
    );
  }

  parts.push('', 'Description:');
  return parts.join('\n');
}
