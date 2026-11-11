// #1777: a targeted run never resolves what it did not check. An earlier `links/broken-links` finding on a
// page the targeted run DID fetch stays open (carried) after the run, because the whole-site rule skipped with
// `targeted-run` and a skip is not evidence of a fix. The same page after a run where the rule really ran and
// found nothing resolves, so the carry is the skip's doing and not a merge that never resolves.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFindingRecord } from "@squirrelscan/core-contracts";
import { TARGETED_RUN_SKIP_REASON } from "@squirrelscan/core-contracts";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { computeMerge, createNotEvaluatedCollector } from "../src/merge-core";

const SITE = "web_1777";
const RULE = "links/broken-links";
const A = "https://example.com/a";
const B = "https://example.com/b";

const prior = (url: string): PageFindingRecord => ({
  siteKey: SITE,
  normalizedUrl: normalizePageUrl(url),
  ruleId: RULE,
  checkName: "broken-links",
  locator: "",
  status: "fail",
  severity: "error",
  message: "1 broken internal link(s)",
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

const targetedSkip: CheckResult = {
  name: RULE,
  status: "skipped",
  message: "Skipped: this run audited only the URLs it was given, not the whole site",
  skipReason: TARGETED_RUN_SKIP_REASON,
};
const clean: CheckResult = { name: "broken-links", status: "pass", message: "No broken internal links detected" };

function stateAfter(rows: CheckResult[]) {
  const collector = createNotEvaluatedCollector(normalizePageUrl);
  for (const c of rows) collector.add(RULE, c);
  const out = computeMerge({
    siteKey: SITE,
    crawlId: "audit_2",
    // The targeted run fetched A and B.
    crawledUrls: new Set([A, B].map(normalizePageUrl)),
    freshFindings: [],
    removedUrls: new Set(),
    severityByRule: new Map([[RULE, "error"]]),
    statusByUrl: new Map(),
    priorFindings: [prior(A)],
    priorPages: [],
    now: 2,
    notEvaluated: collector.result(),
  });
  return out.persisted.find((f) => f.normalizedUrl === normalizePageUrl(A))!;
}

describe("a targeted run and an earlier broken-links finding (#1777)", () => {
  test("the whole-site rule skipped with targeted-run: the finding on a fetched page carries, nothing resolves", () => {
    const row = stateAfter([targetedSkip]);
    expect(row.state).toBe("open");
  });

  test("control: the rule ran and found nothing, so the same finding resolves", () => {
    expect(stateAfter([clean]).state).toBe("resolved");
  });
});
