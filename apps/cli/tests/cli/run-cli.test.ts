// #2367: the real entry point, end to end. Every run gets a scratch HOME and
// no update/telemetry, so nothing touches the machine's own ~/.squirrel.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../../src/cli.ts");
const home = mkdtempSync(join(tmpdir(), "squirrel-run-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function squirrel(...args: string[]) {
  const run = Bun.spawnSync(["bun", "run", entry, ...args], {
    env: {
      ...process.env,
      HOME: home,
      SQUIRREL_NO_UPDATE: "1",
      NO_TELEMETRY: "1",
      NO_COLOR: "1",
      LANG: "en_US.UTF-8",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    out: run.stdout.toString(),
    err: run.stderr.toString(),
  };
}

describe("squirrel (#2367)", () => {
  test("bare: home screen, exit 0, no error", () => {
    const r = squirrel();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Quick start");
    expect(r.out).toContain("squirrel setup");
    expect(r.out + r.err).not.toContain("No command specified");
  });

  test("a group with no command shows its help and exits 0", () => {
    const r = squirrel("self");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage  squirrel self <command> [options]");
  });

  test("a typo suggests the command and exits 1", () => {
    const r = squirrel("audti");
    expect(r.code).toBe(1);
    expect(r.err).toContain("Did you mean squirrel audit?");
    expect(r.err).not.toMatch(/\bat \S+:\d+/); // no stack trace
  });

  test("a missing argument shows usage and exits 1", () => {
    const r = squirrel("audit");
    expect(r.code).toBe(1);
    expect(r.err).toContain("squirrel audit needs a URL.");
  });

  test("--version still prints the bare version", () => {
    const r = squirrel("--version");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("setup --yes --dry-run changes nothing", () => {
    const r = squirrel("setup", "--yes", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Would install squirrelscan and audit-website");
    expect(r.out).toContain("You're ready.");
    const settings = join(home, ".squirrel", "settings.json");
    if (existsSync(settings))
      expect(readFileSync(settings, "utf8")).not.toContain(
        "setup_completed_at"
      );
  });
});
