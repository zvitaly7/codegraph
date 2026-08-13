import {
  mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';

let tmpCounter = 0;

/** Recursively sort object keys so serialization is deterministic. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

function writeAtomic(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${tmpCounter++}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, 'w');
    if (data.length > 0) writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
}

/** Pretty-printed JSON, written atomically. */
export function writeJsonAtomic(path, obj) {
  writeAtomic(path, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * JSON Lines, written atomically: one compact JSON per line joined by '\n',
 * keys recursively sorted for determinism, no trailing newline.
 * An empty `rows` array yields a 0-byte file.
 */
export function writeJsonlAtomic(path, rows) {
  const data = rows.map((row) => JSON.stringify(sortDeep(row))).join('\n');
  writeAtomic(path, data);
}
