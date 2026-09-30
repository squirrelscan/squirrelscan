// #404: `--no-*` flags are read from argv because citty never delivers them.
// The first block pins the citty behaviour that makes the helpers necessary; if
// it ever starts failing, citty changed and the helpers can be revisited.

import { describe, expect, test } from "bun:test";
import { parseArgs } from "citty";

import { audit } from "@/cli/commands/audit";
import { hasFlag, hasNegatedFlag } from "@/cli/flags";

async function parseAudit(argv: string[]): Promise<Record<string, unknown>> {
  const def = await (typeof audit.args === "function"
    ? audit.args()
    : audit.args);
  return parseArgs(argv, def as never) as Record<string, unknown>;
}

describe("citty and --no-* flags (why cli/flags.ts exists)", () => {
  test("a declared no-publish arg is never set", async () => {
    const args = await parseAudit(["https://example.com", "--no-publish"]);
    expect(args["no-publish"]).toBeUndefined();
    expect(args.publish).toBe(false);
  });

  test("both forms together parse by argv order, never as a conflict", async () => {
    const url = "https://example.com";
    expect((await parseAudit([url, "--publish", "--no-publish"])).publish).toBe(
      false
    );
    expect(
      (await parseAudit([url, "--no-publish", "--publish"])).publish
    ).toEqual([false, true]);
    expect((await parseAudit([url, "-p", "--no-publish"])).publish).toBe(true);
  });
});

describe("hasNegatedFlag", () => {
  test("finds --no-<name>", () => {
    expect(hasNegatedFlag(["https://x.test", "--no-publish"], "publish")).toBe(
      true
    );
  });

  test("absent, or another flag's negation", () => {
    expect(hasNegatedFlag(["https://x.test"], "publish")).toBe(false);
    expect(hasNegatedFlag(["--no-incremental"], "publish")).toBe(false);
    expect(hasNegatedFlag(["--publish"], "publish")).toBe(false);
  });

  test("after the -- terminator it is a positional, not a flag", () => {
    expect(hasNegatedFlag(["--", "--no-publish"], "publish")).toBe(false);
  });

  test("no argv at all (a command run with hand-built args)", () => {
    expect(hasNegatedFlag(undefined, "publish")).toBe(false);
  });
});

describe("hasFlag", () => {
  // Each case is also checked against citty's own parse of the audit args, so
  // the helper cannot drift from what the parser treats as --publish.
  test.each([
    [["--publish"]],
    [["--publish=true"]],
    [["-p"]],
    [["-yp"]],
    [["-=p"]],
    [["-o", "out.html", "-p"]],
  ])("%j sets publish", async (argv) => {
    expect(hasFlag(argv, "publish", ["p"])).toBe(true);
    expect(!!(await parseAudit(["https://x.test", ...argv])).publish).toBe(
      true
    );
  });

  test.each([
    [[]],
    [["--no-publish"]],
    [["--publisher"]],
    [["-y"]],
    [["--", "--publish"]],
    [["-o", "p"]],
  ])("%j does not", async (argv) => {
    expect(hasFlag(argv, "publish", ["p"])).toBe(false);
    expect(!!(await parseAudit(["https://x.test", ...argv])).publish).toBe(
      false
    );
  });
});
