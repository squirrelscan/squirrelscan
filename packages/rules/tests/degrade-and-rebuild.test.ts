// degradeAndRebuild (#1172) — the SHARED publish degrade pass. Both producers
// (CLI publishReport, cloud attemptPublishReport) call it when the primary-capped
// body still exceeds the payload/isolate gate: re-sample every rule's checks +
// siteChecks to the harder PUBLISH_DEGRADE_LIMITS. Must degrade the caps AND be
// idempotent (a second pass — or a pass over already-degraded input — is a no-op),
// AND equivalent to sampling the original once at the harder limits.

import { describe, expect, test } from "bun:test";

import { PUBLISH_DEGRADE_LIMITS } from "@squirrelscan/core-contracts/limits";

import {
  degradeAndRebuild,
  DEFAULT_PUBLISH_SAMPLE,
  sampleChecksForPublish,
  type PublishSampleLimits,
} from "../src/fold";
import type { CheckResult } from "../src/types";

const PRIMARY: PublishSampleLimits = DEFAULT_PUBLISH_SAMPLE;
const DEGRADE: PublishSampleLimits = PUBLISH_DEGRADE_LIMITS;

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
