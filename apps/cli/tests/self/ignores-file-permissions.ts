import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * True when permission bits do not bind this process: root, or a user holding CAP_DAC_OVERRIDE / CAP_DAC_READ_SEARCH (a Boat sandbox
 * user is uid 1000 and still reads a chmod 000 file). Measured, not inferred from the uid, because a test that expects EACCES is a
 * no-op there.
 */
export const ignoresFilePermissions: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "sq-perm-probe-"));
  try {
    const file = join(dir, "f");
    writeFileSync(file, "x");
    chmodSync(file, 0o000);
    try {
      readFileSync(file);
      return true;
    } catch {
      return false;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
