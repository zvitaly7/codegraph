// Test-run setup, applied to every file (see vitest.config.mjs).
//
// Windows runners hand out a temp directory in 8.3 short form —
// `C:\Users\RUNNER~1\AppData\Local\Temp`. A tilde in a path is legal, but once
// `pathToFileURL` percent-encodes it to `%7E` the test runner's module loader
// cannot resolve the resulting `file://` URL, and every test that dynamically
// imports a generated config file fails. Node itself handles the URL correctly,
// so this is the runner's limit rather than the tool's — expanding the path to
// its long form keeps the tests measuring the tool.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

if (process.platform === 'win32') {
  try {
    const long = realpathSync.native(tmpdir());
    process.env.TEMP = long;
    process.env.TMP = long;
  } catch {
    // A temp dir we cannot expand is still usable; the affected tests will say so.
  }
}
