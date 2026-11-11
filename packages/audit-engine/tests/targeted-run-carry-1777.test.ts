// #1777, #1778: a targeted run never resolves what it did not check.
//
// Two cases. A whole-site rule that still skips on a targeted run (`links/orphan-pages`): its earlier finding on a
// fetched page carries, because a skip is not evidence of a fix. A site rule that now RUNS over the listed pages
// (`links/broken-links`, #1778): an earlier finding on a page that was NOT listed carries too, because that page
// was not crawled, while the same finding on a listed page resolves when the rule ran clean there (the control that
// shows the carry is the page's doing and not a merge that never resolves).

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFindingRecord } from "@squirrelscan/core-contracts";
import { TARGETED_RUN_SKIP_REASON } from "@squirrelscan/core-contracts";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { computeMerge, createNotEvaluatedCollector } from "../src/merge-core";

const SITE = "web_1777";
const A = "https://example.com/a"; // listed
const B = "https://example.com/b"; // not listed

const prior = (url: string, ruleId: string, checkName: string): PageFindingRecord => ({
  siteKey: SITE,
  normalizedUrl: normalizePageUrl(url),
  ruleId,
  checkName,
  locator: "",
  status: "fail",
  severity: "error",
  message: "an earlier finding",
  value: null,
  expected: null,
  payload: null,
  fingerprint: "f",
  firstSeenAt: 1,
  lastSeenCrawlId: "audit_1",
  lastSeenAt: 1,
  provenance: "fresh",
  state: "open",
});

const targetedSkip = (name: string): CheckResult => ({
  name,
  status: "skipped",
  message: "Skipped: this run audited only the URLs it was given, not the whole site",
  skipReason: TARGETED_RUN_SKIP_REASON,
});
const clean = (name: string): CheckResult => ({ name, status: "pass", message: "ok" });

/** The state of each earlier finding after a targeted run that fetched only A. */
function after(ruleId: string, checkName: string, rows: CheckResult[], pages: string[]) {
  const collector = createNotEvaluatedCollector(normalizePageUrl);
  for (const c of rows) collector.add(ruleId, c);
  const out = computeMerge({
    siteKey: SITE,
    crawlId: "audit_2",
    crawledUrls: new Set([A].map(normalizePageUrl)),
    freshFindings: [],
    removedUrls: new Set(),
    severityByRule: new Map([[ruleId, "error"]]),
    statusByUrl: new Map(),
    priorFindings: pages.map((p) => prior(p, ruleId, checkName)),
    priorPages: [],
    now: 2,
    notEvaluated: collector.result(),
  });
  const stateOf = (url: string) =>
    out.persisted.find((f) => f.normalizedUrl === normalizePageUrl(url))?.state;
  return { a: stateOf(A), b: stateOf(B) };
}

describe("a whole-site rule that still skips on a targeted run (#1777)", () => {
  test("the finding on a fetched page carries, nothing resolves", () => {
    const r = after("links/orphan-pages", "orphan-pages", [targetedSkip("links/orphan-pages")], [A, B]);
    expect(r).toEqual({ a: "open", b: "open" });
  });
});

describe("a site rule that runs over the listed pages only (#1778)", () => {
  for (const [ruleId, checkName] of [
    ["links/broken-links", "broken-links"],
    ["links/broken-external-links", "broken-external-links"],
    ["links/broken-anchors", "broken-anchors"],
    ["security/leaked-secrets", "leaked-secrets-high"],
    ["security/csp", "csp-missing"],
  ] as const) {
    test(`${ruleId}: ran clean over A, so A's earlier finding resolves (control) and B's, never fetched, carries`, () => {
      const r = after(ruleId, checkName, [clean(checkName)], [A, B]);
      expect(r.a).toBe("resolved");
      expect(r.b).toBe("open");
    });
  }
});
