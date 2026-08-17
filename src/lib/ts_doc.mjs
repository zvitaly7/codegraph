// Doc comments attached to a declaration — the one rule `outline` and `show`
// both need, so they cannot disagree about what a symbol's comment is.
//
// "Attached" means the run of leading comments sitting DIRECTLY above the
// declaration: no blank line between the block and the declaration, and none
// inside the run. A blank line detaches, which is how a file header stops being
// the first declaration's doc — usually. When a file opens with a header comment
// and no blank line before the first declaration, the two are genuinely
// indistinguishable and the header wins.

import ts from 'typescript';

const countNewlines = (s) => (s.match(/\n/g) ?? []).length;

/**
 * The comment block attached to `node`.
 * @param {string} text full file text.
 * @param {import('typescript').Node} node
 * @param {import('typescript').SourceFile} sf
 * @returns {{pos: number, end: number}|null} character offsets, or null.
 */
export function attachedCommentRange(text, node, sf) {
  let ranges;
  try {
    ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
  } catch {
    return null;
  }
  if (!ranges || ranges.length === 0) return null;
  const start = node.getStart(sf);
  if (countNewlines(text.slice(ranges[ranges.length - 1].end, start)) > 1) return null;
  let i = ranges.length - 1;
  while (i > 0 && countNewlines(text.slice(ranges[i - 1].end, ranges[i].pos)) <= 1) i -= 1;
  return { pos: ranges[i].pos, end: ranges[ranges.length - 1].end };
}

/**
 * First non-empty line of a comment block, stripped of its `/** `, `*` and `//`
 * markers and capped at `max` characters.
 */
export function firstDocLine(raw, max = 100) {
  for (const line of String(raw).split('\n')) {
    const cleaned = line
      .replace(/^\s*\/\*\*?/, '')
      .replace(/^\s*\/\//, '')
      .replace(/^\s*\*+\/?/, '')
      .replace(/\*\/\s*$/, '')
      .trim();
    if (cleaned.length > 0) return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  }
  return null;
}
