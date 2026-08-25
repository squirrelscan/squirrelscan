import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkBinary, unlinkIfPresent } from "../../src/self/link-binary";

// Windows refuses symlinks to unprivileged users, which is what made
// `self install` exit 1 on stock Windows boxes (#1538). The deps are injected
// so both branches are testable from any host platform.
function eperm(): never {
  const error = new Error(
    "EPERM: operation not permitted, symlink"
  ) as NodeJS.ErrnoException;
  error.code = "EPERM";
  throw error;
}

describe("linkBinary", () => {
  test("symlinks on posix", () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-link-"));
    try {
      const target = join(dir, "squirrel");
      const link = join(dir, "bin-squirrel");
      writeFileSync(target, "binary");

      linkBinary(target, link, { isWindows: false });

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to a copy on windows when symlink is denied", () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-link-"));
    try {
      const target = join(dir, "squirrel.exe");
      const link = join(dir, "bin-squirrel.exe");
      writeFileSync(target, "binary");

      linkBinary(target, link, { isWindows: true, symlink: eperm });
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      expect(readFileSync(link, "utf-8")).toBe("binary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the symlink on windows when the privilege is available", () => {
    let copied = false;
    const linked: string[] = [];

    linkBinary("C:\\target.exe", "C:\\bin\\squirrel.exe", {
      isWindows: true,
      symlink: (target, path) => linked.push(`${target}->${path}`),
      copy: () => {
        copied = true;
      },
    });

    expect(linked).toEqual(["C:\\target.exe->C:\\bin\\squirrel.exe"]);
    expect(copied).toBe(false);
  });

  test("does not swallow a symlink failure on posix", () => {
    let copied = false;

    expect(() =>
      linkBinary("/target", "/bin/squirrel", {
        isWindows: false,
        symlink: eperm,
        copy: () => {
          copied = true;
        },
      })
    ).toThrow("EPERM");
    // A copy here would leave an install `self update` can't swap.
    expect(copied).toBe(false);
  });
});

describe("unlinkIfPresent", () => {
  // Why the bug existed: the old code guarded its unlink with existsSync.
  test("existsSync reports a dangling symlink as absent, lstat does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-unlink-"));
    try {
      const link = join(dir, "squirrel");
      // An older release directory was cleaned up, leaving the bin symlink
      // pointing at nothing — the shape of the reported failure.
      symlinkSync(join(dir, "releases", "0.0.86", "squirrel"), link);

      expect(existsSync(link)).toBe(false); // follows the link to a missing file
      expect(lstatSync(link).isSymbolicLink()).toBe(true); // the link is right there
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes a dangling symlink so the relink can't hit EEXIST", () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-unlink-"));
    try {
      const link = join(dir, "squirrel");
      const target = join(dir, "new-squirrel");
      symlinkSync(join(dir, "releases", "0.0.86", "squirrel"), link);
      writeFileSync(target, "binary");

      unlinkIfPresent(link);
      linkBinary(target, link, { isWindows: false });

      // readlink, not readFileSync: assert the link was repointed, which is
      // what the fix is about, rather than reading through it.
      expect(readlinkSync(link)).toBe(target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes a live symlink and a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-unlink-"));
    try {
      const target = join(dir, "target");
      const link = join(dir, "link");
      const plain = join(dir, "plain");
      writeFileSync(target, "binary");
      symlinkSync(target, link);
      writeFileSync(plain, "not a link");

      unlinkIfPresent(link);
      unlinkIfPresent(plain);

      expect(existsSync(link)).toBe(false);
      expect(existsSync(plain)).toBe(false);
      expect(existsSync(target)).toBe(true); // unlink the link, never its target
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op when nothing is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-unlink-"));
    try {
      expect(() => unlinkIfPresent(join(dir, "absent"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("surfaces a non-ENOENT errno instead of swallowing it", () => {
    // EACCES on an unwritable bin dir is a real problem, not a missing file.
    expect(() =>
      unlinkIfPresent("/bin/squirrel", {
        unlink: () => {
          const error = new Error(
            "EACCES: permission denied, unlink"
          ) as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      })
    ).toThrow("EACCES");
  });
});
