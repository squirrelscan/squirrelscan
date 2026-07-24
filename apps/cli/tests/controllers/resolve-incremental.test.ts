// Precedence: --refresh (full) > --incremental/--no-incremental > config. (#125)

import { getDefaultConfig } from "@squirrelscan/config";
import { describe, expect, test } from "bun:test";

import { resolveIncremental } from "../../src/controllers/audit";

describe("resolveIncremental", () => {
  test("defaults to the config value when no flags are set", () => {
    expect(resolveIncremental(undefined, undefined, true)).toBe(true);
    expect(resolveIncremental(undefined, undefined, false)).toBe(false);
  });

  test("--refresh forces a full fetch, beating flag and config", () => {
    expect(resolveIncremental(true, undefined, true)).toBe(false);
    expect(resolveIncremental(true, true, true)).toBe(false);
    expect(resolveIncremental(true, false, false)).toBe(false);
  });

  test("explicit --incremental / --no-incremental overrides config", () => {
    expect(resolveIncremental(undefined, true, false)).toBe(true);
    expect(resolveIncremental(undefined, false, true)).toBe(false);
  });

  test("config default ships incremental on", () => {
    expect(getDefaultConfig().crawler.incremental).toBe(true);
  });
});
