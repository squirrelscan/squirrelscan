// #2341: resource evidence has to survive every hop it takes, and say so when
// it cannot.
//
// The grouping stage answers "which pages reference this map" by PAGE SET, so
// losing occurrences in transit does not merely thin the evidence — it returns
// a different answer, a unit naming fewer pages, which reads exactly like a
// correct one. That is why every drop here leaves a marker, and why these tests
// assert on the marker as hard as on the round-trip.

import { describe, expect, test } from "bun:test";
import type { CheckResult, SiteResourceOccurrence } from "@squirrelscan/core-contracts";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import {
  packSiteResourceOccurrences,
  unpackSiteResourceOccurrences,
} from "@squirrelscan/core-contracts/site-resource-evidence";

import { flattenChecks } from "../src/merge-core";
import { reconstructPageRuleChecks } from "../src/reconstruct";
import { carriedFindingToCheck } from "../src/scoring";
import type { PageFindingRecord } from "@squirrelscan/core-contracts";

const ORIGIN = "https://example.test";
const URL = `${ORIGIN}/about`;

function occurrence(page: string, key: string): SiteResourceOccurrence {
  return {
    kind: "source-map",
    key,
    pageUrl: page,
    source: "/assets/app.js",
    siteOrigin: ORIGIN,
  };
}

function check(occurrences: SiteResourceOccurrence[], items?: string[]): CheckResult {
  return {
    name: "source-maps-exposed",
    status: "warn",
    message: `${occurrences.length} potential source map(s) detected`,
    pageUrl: URL,
    ...(items ? { items: items.map((id) => ({ id })) } : {}),
    siteResourceOccurrences: occurrences,
  };
}

/** flattenChecks -> PageFindingRecord[] -> reconstruct, the full store hop. */
function roundTrip(source: CheckResult): CheckResult {
  const findings = flattenChecks(URL, "perf/source-maps", [source]).map(
    (f): PageFindingRecord => ({
      siteKey: "s",
      normalizedUrl: f.normalizedUrl,
      ruleId: f.ruleId,
      checkName: f.checkName,
      locator: f.locator,
      status: f.status,
      severity: "info",
      message: f.message,
      value: f.value,
      expected: f.expected,
      payload: f.payload,
      fingerprint: "fp",
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastSeenCrawlId: "c",
      provenance: "fresh",
      state: "open",
    }),
  );
  const rebuilt = reconstructPageRuleChecks(findings).get("perf/source-maps")!;
  return rebuilt[0]!;
}

describe("the codec", () => {
  test("hoists every repeated string and rebuilds the occurrences exactly", () => {
    const pages = Array.from({ length: 30 }, (_, i) => `${ORIGIN}/p${i}`);
    const keys = ["app", "vendor", "theme"].map((n) => `${ORIGIN}/assets/${n}.js.map`);
    const occurrences = pages.flatMap((page) => keys.map((key) => occurrence(page, key)));

    const packed = packSiteResourceOccurrences(occurrences);
    expect(packed.keys).toHaveLength(3);
    expect(packed.pages).toHaveLength(30);
    expect(packed.origins).toHaveLength(1);
    expect(packed.kinds).toHaveLength(1);
    expect(unpackSiteResourceOccurrences(packed)).toEqual(occurrences);

    // The point of hoisting: 90 records must not carry 90 copies of each URL.
    const raw = JSON.stringify(occurrences).length;
    expect(JSON.stringify(packed).length).toBeLessThan(raw / 2);
  });

  test("reads the un-hoisted array a pre-codec store holds", () => {
    const plain = [occurrence(URL, `${ORIGIN}/a.js.map`)];
    expect(unpackSiteResourceOccurrences(plain)).toEqual(plain);
  });

  test("skips a row whose index does not resolve rather than inventing a page", () => {
    const packed = packSiteResourceOccurrences([occurrence(URL, `${ORIGIN}/a.js.map`)]);
    packed.occurrences.push([0, 0, 99, 0, 0]);
    expect(unpackSiteResourceOccurrences(packed)).toHaveLength(1);
  });

  test("a malformed blob yields undefined instead of throwing", () => {
    expect(unpackSiteResourceOccurrences({ v: 99, nonsense: true })).toBeUndefined();
    expect(unpackSiteResourceOccurrences(null)).toBeUndefined();
  });
});

describe("flatten -> reconstruct", () => {
  test("a whole-check finding round-trips the evidence", () => {
    const source = check([
      occurrence(URL, `${ORIGIN}/a.js.map`),
      occurrence(URL, `${ORIGIN}/b.js.map`),
    ]);
    expect(roundTrip(source).siteResourceOccurrences).toEqual(source.siteResourceOccurrences!);
  });

  test("an item check stores ONE copy and the rest carry sibling markers", () => {
    const source = check(
      [occurrence(URL, `${ORIGIN}/a.js.map`), occurrence(URL, `${ORIGIN}/b.js.map`)],
      [`${ORIGIN}/a.js.map`, `${ORIGIN}/b.js.map`],
    );
    const findings = flattenChecks(URL, "perf/source-maps", [source]);
    const payloads = findings.map((f) => JSON.parse(f.payload!) as Record<string, unknown>);
    const owners = payloads.filter((p) => p.siteResourceOccurrences !== undefined);
    expect(owners).toHaveLength(1);
    const siblings = payloads.filter(
      (p) => (p.siteResourceEvidence as { reason?: string } | undefined)?.reason === "sibling-row",
    );
    expect(siblings).toHaveLength(1);
    // And the rebuild still gets the complete set from the single owner.
    expect(roundTrip(source).siteResourceOccurrences).toHaveLength(2);
  });

  test("a check with no evidence gains neither field", () => {
    const rebuilt = roundTrip({
      name: "source-maps-exposed",
      status: "warn",
      message: "x",
      pageUrl: URL,
      pages: [URL],
    });
    expect(rebuilt.siteResourceOccurrences).toBeUndefined();
    expect(rebuilt.siteResourceEvidence).toBeUndefined();
  });
});

describe("over-cap payload", () => {
  // Enough distinct maps that the packed set cannot fit the finding payload.
  const huge = Array.from({ length: 4000 }, (_, i) =>
    occurrence(URL, `${ORIGIN}/assets/${"x".repeat(60)}-${i}.js.map`),
  );

  test("the evidence yields and leaves a payload-limit marker behind", () => {
    const findings = flattenChecks(URL, "perf/source-maps", [check(huge)]);
    const payload = findings[0]!.payload!;
    expect(payload.length).toBeLessThanOrEqual(REPORT_LIMITS.maxFindingPayload);
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.siteResourceOccurrences).toBeUndefined();
    expect(parsed.siteResourceEvidence).toEqual({
      state: "omitted",
      reason: "payload-limit",
      occurrenceCount: huge.length,
    });
  });

  test("the marker survives the rebuild, so the loss stays visible", () => {
    const rebuilt = roundTrip(check(huge));
    expect(rebuilt.siteResourceOccurrences).toBeUndefined();
    expect(rebuilt.siteResourceEvidence?.reason).toBe("payload-limit");
    expect(rebuilt.siteResourceEvidence?.occurrenceCount).toBe(huge.length);
  });
});

describe("a carried page", () => {
  test("replays its evidence, so a partial re-audit keeps the page in the unit", () => {
    const source = check([
      occurrence(URL, `${ORIGIN}/a.js.map`),
      occurrence(URL, `${ORIGIN}/b.js.map`),
    ]);
    const finding = flattenChecks(URL, "perf/source-maps", [source])[0]!;
    const carried = carriedFindingToCheck(
      {
        ruleId: "perf/source-maps",
        normalizedUrl: URL,
        checkName: finding.checkName,
        locator: finding.locator,
        status: "warn",
        message: finding.message,
        value: finding.value,
        expected: finding.expected,
        payload: finding.payload,
        lastSeenAt: 123,
      } as Parameters<typeof carriedFindingToCheck>[0],
      URL,
    );
    expect(carried.siteResourceOccurrences).toEqual(source.siteResourceOccurrences!);
    expect(carried.provenance).toBe("carried");
  });
});
