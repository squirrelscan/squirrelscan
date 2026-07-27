import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { getProjectDbPath } from "../../src/crawler/storage/index";
import { getProjectsPath } from "../../src/self/paths";

// The `[project] name` comes from a cloned repo's squirrel.toml, so it is
// attacker-controlled. getProjectDbPath() must reject any name that would let
// the resulting project dir escape ~/.squirrel/projects (path traversal),
// before it touches the filesystem (#1397).
describe("getProjectDbPath path traversal guard", () => {
  test("rejects a traversal name and never creates the escape target", () => {
    const name = `../../../../../../tmp/squirrelscan-evil-${randomUUID()}`;
    // Where the un-guarded join()+resolve() would have landed.
    const escapeTarget = resolve(getProjectsPath(), name);
    expect(existsSync(escapeTarget)).toBe(false);

    expect(() => getProjectDbPath(name)).toThrow(/squirrel\.toml/);

    // Guard must fire before mkdirSync, so nothing was created outside projects.
    expect(existsSync(escapeTarget)).toBe(false);
  });

  test.each([
    "..",
    ".",
    "a/b",
    "/etc/passwd",
    "..\\..\\windows",
    "foo/../../bar",
    "",
  ])("rejects unsafe name %j", (name) => {
    expect(() => getProjectDbPath(name)).toThrow(/squirrel\.toml/);
  });

  test("accepts a legit single-segment name, kept under the projects dir", () => {
    const name = `sqtest-${randomUUID()}`;
    const projectsDir = getProjectsPath();
    const expectedDir = join(projectsDir, name);
    try {
      const dbPath = getProjectDbPath(name);

      expect(dbPath).toBe(join(expectedDir, "project.db"));
      // Resolved dir stays inside the projects directory.
      expect(resolve(expectedDir).startsWith(resolve(projectsDir) + sep)).toBe(
        true
      );
      // Directory was actually created.
      expect(existsSync(expectedDir)).toBe(true);
    } finally {
      rmSync(expectedDir, { recursive: true, force: true });
    }
  });
});
