// #2307: a page that is NOT re-crawled this run is replayed from its stored
// finding by `carriedFindingToCheck`, which rebuilds a CheckResult from the
// payload field-by-field. If it does not restore component evidence, a carried
// page renders bare while a freshly crawled page with the identical footer
// renders a fix group — the same defect splits on crawl recency alone.
//
// So this drives the real round-trip: flattenChecks writes the payload, the
// carried replay reads it back, and the replayed check must reach the SAME fix
// group id as the fresh one it is standing in for.

import { expect, test } from "bun:test";
import type { CheckResult, ComponentOccurrence } from "@squirrelscan/core-contracts";
import { componentFixGroups } from "@squirrelscan/report";

import { flattenChecks } from "../src/merge-core";
import { carriedFindingToCheck } from "../src/scoring";

const RULE_ID = "content/stale-copyright";

function occurrence(pageUrl: string): ComponentOccurrence {
  return {
    version: 1,
    pageUrl,
    siteOrigin: "https://example.test",
    provenance: { source: "page-dom", rendered: true },
    groupable: true,
    confidence: "observed",
    region: { role: "footer", nestedIn: "none", structuralSignature: "s128:r" },
    family: { key: "s128:f", structuralSignature: "s128:f" },
    variant: { key: "s128:v", structuralSignature: "s128:v", contentHash: "s128:c" },
    element: { locator: "footer:1>footer>p:1", structuralSignature: "s128:e" },
    defect: { kind: "stale-copyright", values: { year: 2019 }, valueHashes: { year: "s128:y" } },
  };
}

function freshCheck(pageUrl: string): CheckResult {
  return {
    name: "footer-copyright-year",
    status: "warn",
    message: "Footer copyright year is 2019, behind the current year 2026",
    pageUrl,
    value: 2019,
    expected: 2026,
    componentOccurrences: [occurrence(pageUrl)],
  };
}

/** Store a fresh check the way the engine does, then replay it as carried. */
function replayAsCarried(pageUrl: string): CheckResult {
  const check = freshCheck(pageUrl);
  const [row] = flattenChecks(pageUrl, RULE_ID, [check]);
  expect(row).toBeDefined();
  return carriedFindingToCheck(
    {
      normalizedUrl: pageUrl,
      ruleId: RULE_ID,
      checkName: row!.checkName,
      status: row!.status,
      message: row!.message,
      value: row!.value,
      expected: row!.expected,
      payload: row!.payload,
      lastSeenAt: 1,
    },
    pageUrl,
  );
}

test("a carried finding restores its component evidence from the stored payload", () => {
  const carried = replayAsCarried("https://example.test/carried");

  expect(carried.provenance).toBe("carried");
  expect(carried.componentOccurrences).toEqual([occurrence("https://example.test/carried")]);
  // The legacy replay is unaffected: page-level message/value/expected still
  // come back exactly as the fresh check had them.
  expect(carried.message).toBe(freshCheck("https://example.test/carried").message);
  // Legacy round-trip stringifies these; asserted as-is rather than "fixed".
  expect(carried.value).toBe("2019");
  expect(carried.expected).toBe("2026");
});

test("a payload-limit omission marker survives the carried replay", () => {
  // Enough evidence to blow REPORT_LIMITS.maxFindingPayload, so `flattenChecks`
  // itself replaces it with the marker — which the carried replay must restore,
  // or a carried page silently reads as "this check never had evidence".
  //
  // NOTE (reported, deliberately not fixed here): this covers a marker GENERATED
  // at flatten time. A marker that ARRIVES already set on a check — e.g. fold's
  // `page-sample-limit` — is not persisted: both payload writers gate the marker
  // on `componentOccurrences.length > 0`, so a check carrying only
  // `componentEvidence` stores `null`.
  const many = Array.from({ length: 400 }, (_, i) => ({
    ...occurrence("https://example.test/marked"),
    element: { locator: `footer:1>footer>p:${i}`, structuralSignature: `s128:e${i}` },
  }));
  const check: CheckResult = {
    ...freshCheck("https://example.test/marked"),
    items: [{ id: "a" }, { id: "b" }],
    componentOccurrences: many,
  };
  const rows = flattenChecks("https://example.test/marked", RULE_ID, [check]);
  const owner = rows.at(-1)!;
  expect(JSON.parse(owner.payload!).componentEvidence.reason).toBe("payload-limit");

  const carried = carriedFindingToCheck(
    {
      normalizedUrl: "https://example.test/marked",
      ruleId: RULE_ID,
      checkName: owner.checkName,
      status: owner.status,
      message: owner.message,
      value: owner.value,
      expected: owner.expected,
      payload: owner.payload,
      lastSeenAt: 1,
    },
    "https://example.test/marked",
  );
  expect(carried.componentOccurrences).toBeUndefined();
  expect(carried.componentEvidence).toEqual({
    state: "omitted",
    reason: "payload-limit",
    occurrenceCount: 400,
  });
});

test("a carried page joins the SAME fix group as a freshly crawled one", () => {
  const fresh = freshCheck("https://example.test/fresh");
  const carried = replayAsCarried("https://example.test/carried");

  const mixed = componentFixGroups(RULE_ID, [fresh, carried]);
  expect(mixed).toHaveLength(1);
  expect(mixed[0]!.affectedPageCount).toBe(2);
  expect(mixed[0]!.affectedPages).toEqual([
    "https://example.test/carried",
    "https://example.test/fresh",
  ]);

  // The group identity must not depend on how the page was obtained: an
  // all-fresh pair has to produce the identical id.
  const allFresh = componentFixGroups(RULE_ID, [fresh, freshCheck("https://example.test/carried")]);
  expect(allFresh).toHaveLength(1);
  expect(mixed[0]!.id).toBe(allFresh[0]!.id);
});
