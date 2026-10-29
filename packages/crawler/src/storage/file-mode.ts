import { chmodSync } from "node:fs";

/**
 * Make a SQLite database file, and the `-wal` and `-shm` files beside it, owner
 * read and write only (#1268). The content store and the project databases hold
 * crawled HTML and, with `store_scripts`, script bundles that can carry keys, so
 * they are not world readable. SQLite creates the side files with the main
 * file's mode, so this runs right after the schema. Best effort: a file system
 * with no modes (or a file we do not own) keeps what it has.
 */
export function restrictToOwner(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(path + suffix, 0o600);
    } catch {
      // A missing side file, or a file system without modes.
    }
  }
}
