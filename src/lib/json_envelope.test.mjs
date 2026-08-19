import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withEnvelope, JSON_SCHEMA_VERSION } from './json_envelope.mjs';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
);

// `--json` output is read by scripts and agents, and a payload that does not say
// what shape it is cannot be checked by the thing reading it: a renamed field
// just arrives as undefined and the consumer carries on with a hole in it.
describe('withEnvelope', () => {
  it('stamps the schema version, the tool and its version', () => {
    expect(withEnvelope({ kind: 'file' })).toEqual({
      schemaVersion: JSON_SCHEMA_VERSION,
      tool: 'loregraph',
      version: pkg.version,
      kind: 'file',
    });
  });

  it('puts the stamp first, so it is visible in a truncated dump', () => {
    expect(Object.keys(withEnvelope({ kind: 'file' })).slice(0, 3))
      .toEqual(['schemaVersion', 'tool', 'version']);
  });

  it('never overwrites a payload field of the same name', () => {
    expect(withEnvelope({ version: 'payload-owns-this' }).version).toBe('payload-owns-this');
  });

  it('leaves a non-object payload alone', () => {
    expect(withEnvelope(null)).toBe(null);
    expect(withEnvelope([1, 2])).toEqual([1, 2]);
  });
});
