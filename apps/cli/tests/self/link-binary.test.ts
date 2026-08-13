import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { linkBinary } from "../../src/self/link-binary";

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

      expect(existsSync(link)).toBe(true);
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
