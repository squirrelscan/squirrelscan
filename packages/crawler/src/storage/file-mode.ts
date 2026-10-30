import { chmodSync, closeSync, existsSync, openSync } from "node:fs";

/**
 * Make a SQLite database file, and the `-wal` and `-shm` files beside it, owner
 * read and write only (#1268). The content store and the project databases hold
 * crawled HTML and, with `store_scripts`, script bundles that can carry keys, so
 * they are not world readable.
 *
 * Call it BEFORE the first open: a missing file is created here with mode 0600,
 * so the database never exists with wider permissions, and SQLite creates the
 * `-wal` and `-shm` files with the main file's mode. An existing file is
 * tightened. Best effort: a file system without POSIX modes (Windows, FAT), or a
 * file we do not own, keeps what it has.
 */
export function restrictToOwner(path: string): void {
  try {
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  } catch {
    // Unwritable location: the database open reports it.
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(path + suffix, 0o600);
    } catch {
      // A missing side file, or a file system without modes.
    }
  }
}

/** Directory mode for the folders squirrel creates for its databases. */
export const OWNER_ONLY_DIR_MODE = 0o700;
