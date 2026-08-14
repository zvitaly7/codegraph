// Marker-aware merge: regenerate a doc without destroying what a human wrote.
//
// A generated page is one block delimited by HTML comments:
//
//   <!-- codegraph:begin generated -->
//   ...everything here is owned by `codegraph docs` and rewritten on every run...
//   <!-- codegraph:end generated -->
//
// Anything OUTSIDE that block — a paragraph above it, team notes below it — is
// carried over byte for byte. A target file that has no usable block is assumed
// to be hand-authored and is skipped, so `codegraph docs` can never silently
// eat someone's `AGENTS.md`; `--force` opts into overwriting it.
//
// Pure string in, string out: no I/O lives here.

/** Opening delimiter of the generated block. */
export const BEGIN_MARKER = '<!-- codegraph:begin generated -->';
/** Closing delimiter of the generated block. */
export const END_MARKER = '<!-- codegraph:end generated -->';

/**
 * Locate the generated block in `text`.
 * @returns {{start: number, end: number}|null} offsets of the begin/end markers,
 *   or null when there is no complete, correctly ordered pair.
 */
function findBlock(text) {
  const start = text.indexOf(BEGIN_MARKER);
  if (start === -1) return null;
  const end = text.indexOf(END_MARKER, start + BEGIN_MARKER.length);
  if (end === -1) return null;
  return { start, end };
}

/** Whether `text` already carries a complete generated block. */
export function hasMarkers(text) {
  return typeof text === 'string' && findBlock(text) !== null;
}

/** Wrap a rendered body in the begin/end markers (the shape of a fresh file). */
export function wrapGenerated(body) {
  const inner = String(body ?? '').replace(/\n+$/, '');
  return `${BEGIN_MARKER}\n${inner}\n${END_MARKER}\n`;
}

/**
 * Merge a freshly rendered body into whatever is already on disk.
 *
 * @param {string|null|undefined} existing current file contents (null/'' → new file).
 * @param {string} body the rendered body, WITHOUT markers.
 * @param {{force?: boolean}} [opts] `force` overwrites a marker-less file.
 * @returns {{
 *   content: string,
 *   action: 'created'|'merged'|'replaced'|'skipped',
 *   changed: boolean,
 *   reason?: 'no-markers',
 * }} `content` is what to write (for 'skipped' it equals `existing` — write nothing).
 */
export function mergeGenerated(existing, body, { force = false } = {}) {
  const fresh = wrapGenerated(body);

  if (typeof existing !== 'string' || existing.length === 0) {
    return { content: fresh, action: 'created', changed: true };
  }

  const block = findBlock(existing);
  if (!block) {
    // A human wrote this file. Refuse to touch it unless explicitly forced.
    if (!force) {
      return { content: existing, action: 'skipped', changed: false, reason: 'no-markers' };
    }
    return { content: fresh, action: 'replaced', changed: fresh !== existing };
  }

  // Splice the new block in place, leaving both sides byte-identical.
  const before = existing.slice(0, block.start);
  const after = existing.slice(block.end + END_MARKER.length);
  const inner = String(body ?? '').replace(/\n+$/, '');
  const content = `${before}${BEGIN_MARKER}\n${inner}\n${END_MARKER}${after}`;
  return { content, action: 'merged', changed: content !== existing };
}
