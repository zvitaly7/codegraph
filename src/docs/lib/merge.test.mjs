import { describe, it, expect } from 'vitest';
import {
  BEGIN_MARKER, END_MARKER, wrapGenerated, hasMarkers, mergeGenerated,
} from './merge.mjs';

const BODY = '# Title\n\nsome generated lines\n';
const NEXT = '# Title\n\ndifferent generated lines\n';

describe('wrapGenerated / hasMarkers', () => {
  it('wraps a body between the two markers', () => {
    const out = wrapGenerated(BODY);
    expect(out.startsWith(BEGIN_MARKER)).toBe(true);
    expect(out.trimEnd().endsWith(END_MARKER)).toBe(true);
    expect(out).toContain('some generated lines');
    expect(hasMarkers(out)).toBe(true);
  });

  it('a plain file has no markers', () => {
    expect(hasMarkers('# hand written\n')).toBe(false);
    // an opening marker with no closing one is NOT a usable block
    expect(hasMarkers(`${BEGIN_MARKER}\nx\n`)).toBe(false);
  });
});

describe('mergeGenerated — creating', () => {
  it('a missing file is created as a fully wrapped block', () => {
    const r = mergeGenerated(null, BODY);
    expect(r.action).toBe('created');
    expect(r.changed).toBe(true);
    expect(r.content).toBe(wrapGenerated(BODY));
  });

  it('an empty existing file counts as missing', () => {
    expect(mergeGenerated('', BODY).action).toBe('created');
  });
});

describe('mergeGenerated — hand-written content survives', () => {
  const handwritten = [
    '# Checkout',
    '',
    'Hand-written: the retry budget here is deliberate, ask #payments before changing it.',
    '',
    wrapGenerated(BODY),
    '',
    '## Notes from the team',
    '',
    'Also hand-written, below the generated block.',
    '',
  ].join('\n');

  it('replaces only the block between the markers', () => {
    const r = mergeGenerated(handwritten, NEXT);
    expect(r.action).toBe('merged');
    expect(r.changed).toBe(true);
    // both hand-written paragraphs survive verbatim
    expect(r.content).toContain('Hand-written: the retry budget here is deliberate');
    expect(r.content).toContain('Also hand-written, below the generated block.');
    expect(r.content).toContain('## Notes from the team');
    // the generated part was updated, the previous generated text is gone
    expect(r.content).toContain('different generated lines');
    expect(r.content).not.toContain('some generated lines');
    // and the markers still delimit exactly one block
    expect(r.content.split(BEGIN_MARKER)).toHaveLength(2);
    expect(r.content.split(END_MARKER)).toHaveLength(2);
  });

  it('is idempotent — merging the same body twice changes nothing', () => {
    const first = mergeGenerated(handwritten, NEXT).content;
    const second = mergeGenerated(first, NEXT);
    expect(second.content).toBe(first);
    expect(second.changed).toBe(false);
    expect(second.action).toBe('merged');
  });

  it('keeps the exact bytes outside the markers (no reflow)', () => {
    const spaced = `lead\n\n\n${wrapGenerated(BODY)}\n\n\ttrailing tab line\n`;
    const r = mergeGenerated(spaced, NEXT);
    expect(r.content.startsWith('lead\n\n\n')).toBe(true);
    expect(r.content.endsWith('\n\n\ttrailing tab line\n')).toBe(true);
  });
});

describe('mergeGenerated — marker-less files are not clobbered', () => {
  const human = '# AGENTS\n\nEverything here was written by a person.\n';

  it('skips a file with no markers', () => {
    const r = mergeGenerated(human, BODY);
    expect(r.action).toBe('skipped');
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('no-markers');
    expect(r.content).toBe(human); // untouched
  });

  it('skips a file with an unbalanced marker pair', () => {
    const broken = `${BEGIN_MARKER}\nhalf a block\n`;
    expect(mergeGenerated(broken, BODY).action).toBe('skipped');
  });

  it('--force overwrites a marker-less file with a fresh generated block', () => {
    const r = mergeGenerated(human, BODY, { force: true });
    expect(r.action).toBe('replaced');
    expect(r.changed).toBe(true);
    expect(r.content).toBe(wrapGenerated(BODY));
    expect(r.content).not.toContain('written by a person');
  });

  it('--force still merges (does not clobber) when markers are present', () => {
    const withBlock = `keep me\n\n${wrapGenerated(BODY)}\n`;
    const r = mergeGenerated(withBlock, NEXT, { force: true });
    expect(r.action).toBe('merged');
    expect(r.content).toContain('keep me');
  });
});
