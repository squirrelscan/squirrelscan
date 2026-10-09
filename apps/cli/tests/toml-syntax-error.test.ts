// A malformed squirrel.toml prints the labelled "TOML syntax error:" line with
// the parser detail, so the branch in loadConfig cannot go dead again (repo#2055).

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@/config";

describe("loadConfig with a TOML syntax error", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toml-syntax-"));
    path = join(dir, "squirrel.toml");
    writeFileSync(path, "[crawl\nmax_pages = 5\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("prints the labelled syntax error line followed by the parser detail", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    try {
      await expect(loadConfig(path, { silent: true })).rejects.toThrow("process.exit");
      const lines = error.mock.calls.map((args) => args.join(" "));
      const label = lines.indexOf("TOML syntax error:");
      expect(label).toBeGreaterThanOrEqual(0);
      expect(lines[label + 1]).toBeTruthy();
      expect(lines[label + 1]).not.toBe("TOML syntax error:");
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });
});
