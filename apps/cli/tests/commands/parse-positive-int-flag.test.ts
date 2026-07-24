// #1084: parsePositiveIntFlag backs --concurrency/--per-host on both `audit`
// (#1068) and `crawl`. Exported from cli/commands/audit.ts and reused as-is
// by cli/commands/crawl.ts — tested once here for both callers.

import { describe, expect, spyOn, test } from "bun:test";

import { parsePositiveIntFlag } from "@/cli/commands/audit";
import { logger } from "@/utils/logger";

describe("parsePositiveIntFlag", () => {
  test("undefined input passes through as undefined (flag not set)", () => {
    expect(parsePositiveIntFlag(undefined, "--concurrency")).toBeUndefined();
  });

  test("parses a valid positive integer", () => {
    expect(parsePositiveIntFlag("8", "--concurrency")).toBe(8);
    expect(parsePositiveIntFlag("1", "--per-host")).toBe(1);
  });

  test("rejects non-numeric input", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parsePositiveIntFlag("abc", "--concurrency")).toBeNull();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]?.[0]).toContain("--concurrency");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("rejects zero and negative values", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parsePositiveIntFlag("0", "--per-host")).toBeNull();
      expect(parsePositiveIntFlag("-3", "--per-host")).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  test("clamps values above MAX_CRAWL_CONCURRENCY and warns", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(parsePositiveIntFlag("500", "--concurrency")).toBe(100);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not warn at exactly the max", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(parsePositiveIntFlag("100", "--concurrency")).toBe(100);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
