import { copyFileSync, symlinkSync } from "node:fs";
import { platform } from "node:os";

export interface LinkBinaryDeps {
  symlink?: (target: string, path: string) => void;
  copy?: (source: string, destination: string) => void;
  isWindows?: boolean;
}

/**
 * Point `linkPath` at `targetPath`, the way this platform can.
 *
 * Windows hands SeCreateSymbolicLinkPrivilege only to elevated processes and
 * to accounts with Developer Mode on, so symlinkSync throws EPERM for a normal
 * user in Windows PowerShell. That is what made `squirrel self install` exit 1
 * on stock Windows boxes while install.ps1 could only report the exit code
 * (#1538). Fall back to a plain copy there: it costs the binary's size on disk
 * but leaves a working squirrel.exe on PATH, and `self update` overwrites it
 * the same way. POSIX keeps the symlink (cheap, and self update flips it).
 *
 * The fallback is Windows-only on purpose — an EPERM on macOS/Linux is a real
 * problem (unwritable bin dir) and must keep surfacing instead of silently
 * turning into a copy that the next update can't swap.
 */
export function linkBinary(
  targetPath: string,
  linkPath: string,
  deps: LinkBinaryDeps = {}
): void {
  const symlink = deps.symlink ?? symlinkSync;
  const copy = deps.copy ?? copyFileSync;
  const isWindows = deps.isWindows ?? platform() === "win32";

  if (!isWindows) {
    symlink(targetPath, linkPath);
    return;
  }

  try {
    symlink(targetPath, linkPath);
  } catch {
    copy(targetPath, linkPath);
  }
}
