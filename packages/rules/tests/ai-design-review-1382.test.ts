import { describe, expect, test } from "bun:test";

import type { DesignReviewResult } from "@squirrelscan/core-contracts";
import { DESIGN_REVIEW_MAX_FINDINGS } from "@squirrelscan/core-contracts";

import { designReviewRule } from "../src/ai/design-review";
import type { CloudResultStore } from "../src/cloud";
import type { RuleContext } from "../src/types";
import { expectDeclaredChecks } from "./helpers/declared-checks";

const PAGES = ["https://e.com/", "https://e.com/about", "https://e.com/pricing"];

function run(data: DesignReviewResult | undefined, skipped = false) {
  const store: CloudResultStore = new Map();
  if (data || skipped) {
    store.set(
      "design-review",
      new Map([
        ["site", skipped ? { status: "skipped", skipReason: "insufficient-credits" } : { status: "ok", data }],
      ]),
    );
  }
  const out = designReviewRule.run({ cloudResults: store } as unknown as RuleContext) as {
    checks: import("@squirrelscan/core-contracts").CheckResult[];
  };
  expectDeclaredChecks(designReviewRule, out.checks);
  return out.checks;
}

const concrete = {
  page: PAGES[2]!,
  element: "primary CTA button",
  deviation: "padding is 24px, 8px off the 16px the other pages use",
  siteNorm: "CTA padding is 16px",
  referencePages: [PAGES[0]!, PAGES[1]!],
};

describe("ai/design-review (repo#1382)", () => {
  test("consistent fixture: a model that finds nothing passes", () => {
    const checks = run({ sampledPages: PAGES, findings: [] });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("pass");
  });

  test("deliberate cross-page inconsistency produces a finding naming page and element", () => {
    const checks = run({ sampledPages: PAGES, findings: [concrete] });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("warn");
    expect(checks[0]!.message).toContain("primary CTA button");
    expect(checks[0]!.message).toContain("https://e.com/pricing");
    expect(checks[0]!.message).toContain("8px");
  });

  test("generic advice is dropped: no number, no norm, or unsampled/self reference", () => {
    const checks = run({
      sampledPages: PAGES,
      findings: [
        { ...concrete, deviation: "the layout feels cluttered" },
        { ...concrete, siteNorm: "" },
        { ...concrete, referencePages: ["https://other.com/x"] },
        { ...concrete, referencePages: [concrete.page] },
        { ...concrete, page: "https://e.com/not-sampled" },
      ],
    });
    expect(checks[0]!.status).toBe("pass");
  });

  test("findings are capped", () => {
    const checks = run({
      sampledPages: PAGES,
      findings: Array.from({ length: 25 }, () => concrete),
    });
    expect(checks).toHaveLength(DESIGN_REVIEW_MAX_FINDINGS);
  });

  test("absent or skipped result skips with a hint, never fails", () => {
    expect(run(undefined)[0]!.status).toBe("skipped");
    const s = run(undefined, true)[0]!;
    expect(s.status).toBe("skipped");
    expect(s.skipReason).toContain("out of credits");
  });

  test("declares the opt-in LLM feature and a site-scoped cloud service", () => {
    expect(designReviewRule.meta.cloud).toEqual({
      service: "design-review",
      unit: "site",
      creditFeature: "llm_rules_page",
    });
  });
});
