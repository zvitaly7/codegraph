import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';

const CHUNK = 1 << 16; // 64 KiB

/**
 * Stream a file through SHA-256 in bounded-memory chunks.
 * Never throws — an I/O error yields { sha256: null, hashError: <message> }.
 *
 * @param {string} absPath
 * @returns {{ sha256: string|null, hashError: string|null }}
 */
export function hashFile(absPath) {
  let fd;
  try {
    fd = openSync(absPath, 'r');
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK);
    let bytesRead;
    while ((bytesRead = readSync(fd, buf, 0, CHUNK, null)) > 0) {
      hash.update(bytesRead === CHUNK ? buf : buf.subarray(0, bytesRead));
    }
    return { sha256: hash.digest('hex'), hashError: null };
  } catch (err) {
    return { sha256: null, hashError: err && err.message ? err.message : String(err) };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed / never opened */
      }
    }
  }
}
