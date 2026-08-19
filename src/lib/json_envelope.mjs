// The stamp every `--json` payload carries.
//
// A payload that does not say what shape it is cannot be checked by whatever
// reads it: rename a field and the consumer sees `undefined`, carries on, and
// nobody finds out. The graph artifacts on disk have said `schemaVersion` since
// the first release; the command-line answers had not, though they are the ones
// scripts and agents actually parse.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Bumped when a `--json` payload changes shape in a way a reader would notice. */
export const JSON_SCHEMA_VERSION = 1;

function packageVersion() {
  try {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(path, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = packageVersion();

/**
 * Stamp a payload with the schema version, the tool and its version — first, so
 * a truncated dump still shows them. A payload that already carries one of those
 * keys keeps its own: the answer knows more about itself than the envelope does.
 *
 * @template T
 * @param {T} payload
 * @returns {T} the same value when it is not a plain object.
 */
export function withEnvelope(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    tool: 'loregraph',
    version: VERSION,
    ...payload,
  };
}
