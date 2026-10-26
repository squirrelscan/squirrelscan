import { describe, expect, test } from "bun:test";

import { formatResumeClaimWarning } from "@/audit/crawl-lease";

describe("formatResumeClaimWarning", () => {
  test("names the live owner that prevented resume", () => {
    expect(
      formatResumeClaimWarning("crawl-123", {
        acquired: false,
        ownerPid: 4242,
        ownerHost: "worker-a",
      })
    ).toBe(
      "--resume requested but crawl crawl-123 is active in pid 4242 on worker-a; starting new"
    );
  });

  test("does not present an unknown lease failure as a live owner", () => {
    expect(formatResumeClaimWarning("crawl-123", { acquired: false })).toBe(
      "--resume requested but ownership of crawl crawl-123 could not be established; starting new"
    );
  });
});
