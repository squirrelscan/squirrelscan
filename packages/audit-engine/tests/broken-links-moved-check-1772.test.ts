// #1772: moving a broken link between `broken-links` (page content) and `broken-links-sitewide` (header,
// navigation or footer of most pages) changes its check name, not the finding. The merge must treat it as the
// same finding: a previous run had it under one name, the next run reports it under the other, and it does NOT
// resolve (which would send a false "fixed" notification and open a "new" finding for the same link).

import { describe, expect, test } from "bun:test";

import type { PageFindingRecord } from "@squirrelscan/core-contracts";
import { buildSupersededIndex } from "@squirrelscan/core-contracts/resolution";
import { loadAllRules } from "@squirrelscan/rules";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { computeMerge, type FlatFinding } from "../src/merge-core";

const SITE = "web_1772";
const RULE = "links/broken-links";
const LINK = "https://example.com/gone";
const PAGE = normalizePageUrl("https://example.com/");

const superseded = buildSupersededIndex([...loadAllRules().values()].map((r) => r.meta));

const prior = (checkName: string): PageFindingRecord => ({
  siteKey: SITE,
  normalizedUrl: PAGE,
  ruleId: RULE,
  checkName,
  locator: LINK,
  status: "fail",
  severity: "error",
  message: "1 broken internal link(s)",
  value: null,
  expected: null,
  payload: null,
  fingerprint: "f",
  firstSeenAt: 111,
  lastSeenCrawlId: "audit_1",
  lastSeenAt: 111,
  provenance: "fresh",
  state: "open",
});

const fresh = (checkName: string): FlatFinding => ({
  normalizedUrl: PAGE,
  ruleId: RULE,
  checkName,
  locator: LINK,
  status: "fail",
  message: "1 broken internal link(s)",
  value: null,
  expected: null,
  payload: null,
});

function merge(previous: string, now: string | null) {
  return computeMerge({
    siteKey: SITE,
    crawlId: "audit_2",
    crawledUrls: new Set([PAGE]),
    freshFindings: now ? [fresh(now)] : [],
    removedUrls: new Set(),
    severityByRule: new Map([[RULE, "error"]]),
    statusByUrl: new Map(),
    priorFindings: [prior(previous)],
    priorPages: [],
    now: 2,
    supersededChecks: superseded,
  });
}

const rowOf = (m: ReturnType<typeof merge>, checkName: string) =>
  m.persisted.find((f) => f.checkName === checkName);

describe("a broken link that moves between the content and the site-wide check (#1772)", () => {
  for (const [from, to] of [
    ["broken-links", "broken-links-sitewide"],
    ["broken-links-sitewide", "broken-links"],
  ] as const) {
    test(`${from} then ${to}: the old row retires (never resolved) and the finding continues under ${to}`, () => {
      const m = merge(from, to);
      // No "resolved" row anywhere: nothing was fixed.
      expect(m.persisted.filter((f) => f.state === "resolved")).toEqual([]);
      expect(rowOf(m, from)?.state).toBe("stale");
      // The new row is open and inherits when the finding was first seen.
      const next = rowOf(m, to);
      expect(next?.state).toBe("open");
      expect(next?.firstSeenAt).toBe(111);
      expect(m.findings.map((f) => f.checkName)).toEqual([to]);
    });
  }

  test("still under the same name: untouched, still open", () => {
    const m = merge("broken-links", "broken-links");
    expect(m.persisted.filter((f) => f.state === "resolved")).toEqual([]);
    expect(rowOf(m, "broken-links")?.state).toBe("open");
  });

  test("control: gone under both names on a crawled page resolves", () => {
    const m = merge("broken-links", null);
    expect(rowOf(m, "broken-links")?.state).toBe("resolved");
  });
});
