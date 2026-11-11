// The crawl-phase backstop makes a run partial with code crawl_timeout (#1639).
import { describe, expect, test } from "bun:test";

import { withCrawlPhaseCut } from "../../src/reports/reconstruct";

const cut = {
  seconds: 1800,
  pagesCollected: 1568,
  pageBudget: 4000,
  unfetchedPages: 2345,
  linkGraphComplete: false as const,
};

describe("withCrawlPhaseCut", () => {
  test("completed becomes partial with crawl_timeout and coverage in the reason", () => {
    const out = withCrawlPhaseCut(
      { status: "completed", reason: undefined, reasonCode: undefined },
      cut
    );
    expect(out.status).toBe("partial");
    expect(out.reasonCode).toBe("crawl_timeout");
    expect(out.reason).toContain("1568 pages");
    expect(out.reason).toContain("link graph is incomplete");
  });

  test("an already failed or partial run keeps its own status", () => {
    const failed = withCrawlPhaseCut(
      { status: "failed", reason: "dns", reasonCode: "dns" },
      cut
    );
    expect(failed.status).toBe("failed");
    const partial = withCrawlPhaseCut(
      { status: "partial", reason: "max", reasonCode: "max_duration" },
      cut
    );
    expect(partial.reasonCode).toBe("max_duration");
  });

  test("no cut leaves the status alone", () => {
    expect(withCrawlPhaseCut({ status: undefined }, undefined).status).toBe(
      "completed"
    );
  });
});
