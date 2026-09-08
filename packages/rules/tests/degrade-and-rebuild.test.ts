// degradeAndRebuild (#1172) — the SHARED publish degrade pass. Both producers
// (CLI publishReport, cloud attemptPublishReport) call it when the primary-capped
// body still exceeds the payload/isolate gate: re-sample every rule's checks +
// siteChecks to the harder PUBLISH_DEGRADE_LIMITS. Must degrade the caps AND be
// idempotent (a second pass — or a pass over already-degraded input — is a no-op),
// AND equivalent to sampling the original once at the harder limits.

import { describe, expect, test } from "bun:test";

import { PUBLISH_DEGRADE_LIMITS } from "@squirrelscan/core-contracts/limits";

import {
  clipPageStatusesToBytes,
  degradeAndRebuild,
  DEFAULT_PUBLISH_SAMPLE,
  sampleChecksForPublish,
  type PublishDegradeLimits,
  type PublishSampleLimits,
} from "../src/fold";
import type { CheckResult } from "../src/types";

const PRIMARY: PublishSampleLimits = DEFAULT_PUBLISH_SAMPLE;
const DEGRADE: PublishDegradeLimits = PUBLISH_DEGRADE_LIMITS;

const pageList = (n: number) => Array.from({ length: n }, (_, i) => `https://x.test/p/${i}`);

// A single big check: 500 affected pages + 60 items each fanning out to 20
// sourcePages. Over every axis of both the primary and degrade caps. Fresh copy
// per call so the two sampling paths never alias.
function bigCheck(): CheckResult {
  return {
    name: "broken",
    status: "fail",
    message: "500 things broken",
    pages: pageList(500),
    items: Array.from({ length: 60 }, (_, i) => ({
      id: `item-${i}`,
      label: `Broken ${i}`,
      sourcePages: Array.from({ length: 20 }, (_, j) => `https://x.test/src/${i}-${j}`),
    })),
  };
}

function report() {
  return {
    baseUrl: "https://x.test",
    ruleResults: {
      "some-rule": { meta: { id: "some-rule" }, checks: [bigCheck()] },
    },
    siteChecks: [bigCheck()],
  };
}

describe("degradeAndRebuild", () => {
  test("re-samples ruleResults checks + siteChecks to the given caps", () => {
    const r = report();
    const returned = degradeAndRebuild(r, DEGRADE);

    // Mutates in place + returns the SAME report reference.
    expect(returned).toBe(r);

    const ruleCheck = r.ruleResults["some-rule"]!.checks[0]!;
    const siteCheck = r.siteChecks[0]!;
    for (const check of [ruleCheck, siteCheck]) {
      // pages clipped to the degrade cap, TRUE pre-sample count preserved.
      expect(check.pages).toHaveLength(DEGRADE.maxPagesPerCheck);
      expect(check.details?.pagesTruncated).toBe(500);
      // items clipped to the degrade cap, remainder rolled into details.additional.
      expect(check.items).toHaveLength(DEGRADE.maxItems);
      expect(check.details?.additional).toBe(60 - DEGRADE.maxItems);
      // per-item sourcePages clipped to the degrade cap.
      for (const item of check.items!) {
        expect(item.sourcePages!.length).toBeLessThanOrEqual(DEGRADE.maxSourcePagesPerItem);
      }
    }
  });

  test("degrading a primary-sampled report == sampling the original once at degrade caps", () => {
    // Two-step: primary sample, then degrade the result.
    const twoStep = report();
    degradeAndRebuild(twoStep, PRIMARY); // primary sample (100/50/10)
    degradeAndRebuild(twoStep, DEGRADE); // then harder degrade (25/10/3)

    // One-step: sample the original directly at the degrade caps.
    const oneStepRuleCheck = sampleChecksForPublish([bigCheck()], DEGRADE)[0]!;
    const oneStepSiteCheck = sampleChecksForPublish([bigCheck()], DEGRADE)[0]!;

    expect(twoStep.ruleResults["some-rule"]!.checks[0]!).toEqual(oneStepRuleCheck);
    expect(twoStep.siteChecks[0]!).toEqual(oneStepSiteCheck);
  });

  test("idempotent: a second degrade at the same caps is a no-op (same refs)", () => {
    const r = report();
    degradeAndRebuild(r, DEGRADE);
    const ruleChecksAfterFirst = r.ruleResults["some-rule"]!.checks;
    const ruleCheckAfterFirst = ruleChecksAfterFirst[0]!;
    const siteChecksAfterFirst = r.siteChecks;

    degradeAndRebuild(r, DEGRADE);

    // sampleChecksForPublish returns the SAME array/check refs when nothing
    // overran, so an already-degraded report is untouched down to identity.
    expect(r.ruleResults["some-rule"]!.checks).toBe(ruleChecksAfterFirst);
    expect(r.ruleResults["some-rule"]!.checks[0]!).toBe(ruleCheckAfterFirst);
    expect(r.siteChecks).toBe(siteChecksAfterFirst);
    expect(r.ruleResults["some-rule"]!.checks[0]!.details?.pagesTruncated).toBe(500);
    expect(r.ruleResults["some-rule"]!.checks[0]!.details?.additional).toBe(60 - DEGRADE.maxItems);
  });

  test("already-small report passes through untouched (same references)", () => {
    const small: { ruleResults: Record<string, { checks: CheckResult[] }>; siteChecks: CheckResult[] } = {
      ruleResults: {
        r1: { checks: [{ name: "ok", status: "pass", message: "fine" }] },
      },
      siteChecks: [{ name: "ok2", status: "pass", message: "fine" }],
    };
    const beforeRuleChecks = small.ruleResults.r1!.checks;
    const beforeSiteChecks = small.siteChecks;
    degradeAndRebuild(small, DEGRADE);
    expect(small.ruleResults.r1!.checks).toBe(beforeRuleChecks);
    expect(small.siteChecks).toBe(beforeSiteChecks);
  });

  test("tolerates a report missing ruleResults / siteChecks (no crash)", () => {
    expect(() => degradeAndRebuild({}, DEGRADE)).not.toThrow();
    expect(() => degradeAndRebuild({ ruleResults: undefined, siteChecks: undefined }, DEGRADE)).not.toThrow();
    // A null rule value in the record is skipped, not dereferenced.
    const r = { ruleResults: { bad: null }, siteChecks: [] };
    expect(() => degradeAndRebuild(r, DEGRADE)).not.toThrow();
  });
});

// #1028: raising the crawl ceiling to 10,000 pages made `pageStatuses` big
// enough to blow the 20MB publish gate on its own — it lists every non-2xx page,
// is count-capped at the ceiling, and per-check sampling cannot see it. The
// degrade pass has to reach it or it runs, shrinks nothing that matters, and the
// publish fails anyway.
describe("clipPageStatusesToBytes (#1028)", () => {
  const budget = PUBLISH_DEGRADE_LIMITS.maxPageStatusBytes;
  const statuses = (n: number, urlLen = 40) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://x.test/p/${i}`.padEnd(urlLen, "a"),
      status: 404,
    }));
  const bytes = (arr: unknown) => new TextEncoder().encode(JSON.stringify(arr)).length;

  test("leaves an array already inside the budget completely alone", () => {
    const r = { pageStatuses: statuses(100) };
    const before = r.pageStatuses;
    clipPageStatusesToBytes(r, budget);
    expect(r.pageStatuses).toBe(before);
    expect(r.pageStatuses).toHaveLength(100);
  });

  test("clips an over-budget array to fit, and the result really is under", () => {
    const r = { pageStatuses: statuses(20_000, 300) };
    expect(bytes(r.pageStatuses)).toBeGreaterThan(budget);
    clipPageStatusesToBytes(r, budget);
    expect(r.pageStatuses.length).toBeLessThan(20_000);
    expect(bytes(r.pageStatuses)).toBeLessThanOrEqual(budget);
  });

  // The point of budgeting BYTES rather than entries: entry size varies by three
  // orders of magnitude with URL length, so a fixed count is either wasteful for
  // short URLs or useless for long ones.
  test("keeps far more short URLs than long ones for the same budget", () => {
    // A budget both arrays overrun, so the comparison is about entry size and
    // not about one of them happening to fit.
    const small = 100_000;
    const shortR = { pageStatuses: statuses(20_000, 40) };
    const longR = { pageStatuses: statuses(20_000, 2000) };
    clipPageStatusesToBytes(shortR, small);
    clipPageStatusesToBytes(longR, small);
    expect(shortR.pageStatuses.length).toBeGreaterThan(longR.pageStatuses.length * 10);
    expect(bytes(shortR.pageStatuses)).toBeLessThanOrEqual(small);
    expect(bytes(longR.pageStatuses)).toBeLessThanOrEqual(small);
  });

  test("idempotent: a second pass changes nothing", () => {
    const r = { pageStatuses: statuses(20_000, 300) };
    clipPageStatusesToBytes(r, budget);
    const once = r.pageStatuses.length;
    const ref = r.pageStatuses;
    clipPageStatusesToBytes(r, budget);
    expect(r.pageStatuses).toBe(ref);
    expect(r.pageStatuses).toHaveLength(once);
  });

  test("degradeAndRebuild applies it, and a primary sample does NOT", () => {
    const mk = () => ({ ruleResults: {}, siteChecks: [], pageStatuses: statuses(20_000, 300) });
    const degraded = degradeAndRebuild(mk(), DEGRADE);
    expect(bytes(degraded.pageStatuses)).toBeLessThanOrEqual(budget);

    // DEFAULT_PUBLISH_SAMPLE carries no byte budget on purpose: a primary
    // publish sample must leave the crawl-scaled field whole.
    const sampled = degradeAndRebuild(mk(), PRIMARY);
    expect(sampled.pageStatuses).toHaveLength(20_000);
  });

  test("tolerates a report with no pageStatuses at all", () => {
    expect(() => degradeAndRebuild({}, DEGRADE)).not.toThrow();
    expect(() => clipPageStatusesToBytes({ pageStatuses: null }, budget)).not.toThrow();
    expect(() => clipPageStatusesToBytes({ pageStatuses: [] }, budget)).not.toThrow();
  });
});
