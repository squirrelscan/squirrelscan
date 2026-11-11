import { describe, expect, test } from "bun:test";

import { parseCrawlTimeoutFlag } from "@/cli/commands/audit";
import { CRAWL_PHASE_MAX_TIMEOUT_MS } from "@/constants";

describe("--crawl-timeout flag (#1639)", () => {
  test("unset is undefined", () => {
    expect(parseCrawlTimeoutFlag(undefined)).toBeUndefined();
  });
  test("plain seconds parse, up to the ceiling", () => {
    expect(parseCrawlTimeoutFlag("7200")).toBe(7200);
    expect(
      parseCrawlTimeoutFlag(String(CRAWL_PHASE_MAX_TIMEOUT_MS / 1000))
    ).toBe(CRAWL_PHASE_MAX_TIMEOUT_MS / 1000);
  });
  test.each(["0", "-5", "abc", "", "1e3", "21601", "99999999"])(
    "%p is rejected",
    (raw) => {
      expect(parseCrawlTimeoutFlag(raw)).toBeNull();
    }
  );
});
