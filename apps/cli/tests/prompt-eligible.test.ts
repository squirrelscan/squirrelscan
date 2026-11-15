import { describe, expect, test } from "bun:test";

import { promptEligible } from "../src/cli/prompt";

describe("promptEligible", () => {
  test("both TTY", () => {
    expect(promptEligible({ stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
  });
  test("stdin only", () => {
    expect(promptEligible({ stdinIsTTY: true, stdoutIsTTY: false })).toBe(
      false
    );
  });
  test("stdout only", () => {
    expect(promptEligible({ stdinIsTTY: false, stdoutIsTTY: true })).toBe(
      false
    );
  });
  test("neither", () => {
    expect(promptEligible({ stdinIsTTY: false, stdoutIsTTY: false })).toBe(
      false
    );
  });
  test("--yes suppresses", () => {
    expect(
      promptEligible({ stdinIsTTY: true, stdoutIsTTY: true, yes: true })
    ).toBe(false);
  });
});
