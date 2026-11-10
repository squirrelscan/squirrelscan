// The crawl and frontier status transition tables (#1659).

import { describe, expect, test } from "bun:test";

import {
  canTransitionCrawl,
  canTransitionFrontier,
  CRAWL_STATUS_TRANSITIONS,
  FRONTIER_STATUS_TRANSITIONS,
  type CrawlStatus,
  type FrontierStatus,
} from "../src/storage";

const CRAWL: CrawlStatus[] = ["running", "paused", "crawled", "analyzed", "completed", "stopped", "failed"];
const FRONTIER: FrontierStatus[] = ["pending", "fetching", "done", "failed", "skipped"];

// from -> the statuses it may be written to, spelled out edge by edge.
const CRAWL_LEGAL: Record<CrawlStatus, CrawlStatus[]> = {
  running: ["running", "paused", "completed", "stopped", "crawled", "analyzed", "failed"],
  paused: ["running", "paused", "completed", "stopped", "crawled", "analyzed", "failed"],
  completed: ["running", "completed", "crawled", "analyzed"],
  stopped: ["running", "stopped", "crawled", "analyzed"],
  crawled: ["running", "crawled", "analyzed"],
  analyzed: ["running", "analyzed"],
  failed: ["running", "failed"],
};

const FRONTIER_LEGAL: Record<FrontierStatus, FrontierStatus[]> = {
  pending: ["fetching"],
  fetching: ["done", "failed", "skipped", "pending"],
  done: [],
  failed: [],
  skipped: [],
};

describe("crawl status transitions", () => {
  for (const from of CRAWL) {
    for (const to of CRAWL) {
      const legal = CRAWL_LEGAL[from].includes(to);
      test(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        expect(canTransitionCrawl(from, to)).toBe(legal);
      });
    }
  }

  test("every status has an entry, and every entry lists real statuses", () => {
    expect(Object.keys(CRAWL_STATUS_TRANSITIONS).sort()).toEqual([...CRAWL].sort());
    for (const froms of Object.values(CRAWL_STATUS_TRANSITIONS)) for (const f of froms) expect(CRAWL).toContain(f);
  });

  test("a finished crawl cannot be paused or re-finished by a late write", () => {
    for (const from of ["completed", "stopped", "crawled", "analyzed", "failed"] as const) {
      expect(canTransitionCrawl(from, "paused"), from).toBe(false);
    }
  });
});

describe("frontier status transitions", () => {
  for (const from of FRONTIER) {
    for (const to of FRONTIER) {
      const legal = FRONTIER_LEGAL[from].includes(to);
      test(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        expect(canTransitionFrontier(from, to)).toBe(legal);
      });
    }
  }

  test("done, failed and skipped are final", () => {
    for (const from of ["done", "failed", "skipped"] as const) {
      for (const to of FRONTIER) expect(canTransitionFrontier(from, to)).toBe(false);
    }
  });

  test("every status has an entry", () => {
    expect(Object.keys(FRONTIER_STATUS_TRANSITIONS).sort()).toEqual([...FRONTIER].sort());
  });
});
