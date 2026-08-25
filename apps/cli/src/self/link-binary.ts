import { copyFileSync, symlinkSync, unlinkSync } from "node:fs";
import { platform } from "node:os";

export interface UnlinkIfPresentDeps {
  unlink?: (path: string) => void;
}

/**
 * Remove whatever currently sits at `path` — file, live symlink, or dangling
 * symlink — and do nothing if there is genuinely nothing there.
 *
 * Callers used to guard the unlink with `existsSync(path)`, which FOLLOWS
 * symlinks: a link whose release directory has been cleaned up reads as
 * missing, the unlink is skipped, and the symlink/copy that follows dies with
 * `EEXIST: file already exists`. That is the whole of the "Self install failed
 * with exit code 1" the installer has been reporting on reinstall.
 *
 * Unlinking unconditionally and swallowing only ENOENT is the fix: unlink
 * operates on the link itself, so every case above collapses to one call. Any
 * other errno (EACCES on an unwritable bin dir, EBUSY on a running Windows
 * .exe) still surfaces, because those are real problems.
 */
export function unlinkIfPresent(
  path: string,
  deps: UnlinkIfPresentDeps = {}
): void {
  const unlink = deps.unlink ?? unlinkSync;
  try {
    unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

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
