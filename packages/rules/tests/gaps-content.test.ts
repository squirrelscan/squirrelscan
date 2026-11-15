// gaps/content: clustered, scored topic opportunities (cloud, site-scope).
//
// Verifies: skip passthrough, pass with no gaps, ranking by opportunity score,
// documented defaults for missing fields, warn status under a recommendation
// rule, and the high-volume warning.

import { describe, expect, test } from "bun:test";

import {
  contentGapOpportunityScore,
  rankContentGaps,
  type ContentGapItem,
  type ContentGapsResponse,
} from "@squirrelscan/core-contracts";

import { CLOUD_SITE_KEY, type CloudResultEnvelope, type CloudResultStore } from "../src/cloud";
import { contentGapsRule } from "../src/gaps/content";
import type { CheckResult, RuleContext } from "../src/types";

function makeCtx(envelope?: CloudResultEnvelope<ContentGapsResponse>): RuleContext {
  const cloudResults: CloudResultStore | undefined = envelope
    ? new Map([["content-gaps", new Map([[CLOUD_SITE_KEY, envelope as CloudResultEnvelope]])]])
    : undefined;
  return { cloudResults, options: {} } as RuleContext;
}

function ok(gaps: ContentGapItem[]): CloudResultEnvelope<ContentGapsResponse> {
  return { status: "ok", data: { gaps, summary: "summary text" } };
}

async function run(ctx: RuleContext): Promise<CheckResult[]> {
  return ((await contentGapsRule.run(ctx)) as { checks: CheckResult[] }).checks;
}

describe("gaps/content", () => {
  test("is a recommendation rule", () => {
    expect(contentGapsRule.meta.severity).toBe("recommendation");
  });

  test("skips gracefully with no cloud result", async () => {
    const checks = await run(makeCtx());
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("passes a skip envelope through with its reason", async () => {
    const checks = await run(makeCtx({ status: "skipped", skipReason: "not-authenticated" }));
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBeTruthy();
  });

  test("passes when no gaps are found", async () => {
    const checks = await run(makeCtx(ok([])));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
    expect(checks[0]?.message).toBe("No content gaps found");
  });

  test("warns with ranked items, ordered by score not raw volume", async () => {
    const checks = await run(
      makeCtx(
        ok([
          { topic: "hard head term", volume: 10000, difficulty: 95, relevance: 1, reason: "big", keywords: ["a"] },
          { topic: "easy long tail", volume: 2000, difficulty: 10, relevance: 1, reason: "easy", keywords: ["b", "c"] },
        ]),
      ),
    );
    const gap = checks.find((c) => c.name === "content-gaps");
    expect(gap?.status).toBe("warn");
    expect(gap?.message).toBe("2 content gap topics found");
    expect(gap?.value).toBe(2);
    expect(gap?.items?.map((i) => i.id)).toEqual(["easy long tail", "hard head term"]);
    expect(gap?.items?.[0]?.label).toBe("easy long tail (score 200, vol 2000, difficulty 10)");
    expect(gap?.items?.[0]?.snippet).toBe("easy (keywords: b, c)");
    const details = gap?.details as { summary: string; opportunities: Array<{ topic: string; score: number }> };
    expect(details.summary).toBe("summary text");
    expect(details.opportunities.map((o) => o.topic)).toEqual(["easy long tail", "hard head term"]);
    expect(details.opportunities[0]?.score).toBe(200);
  });

  test("singular message and known-only label parts", async () => {
    const checks = await run(makeCtx(ok([{ topic: "solo", volume: null, reason: "r" }])));
    const gap = checks[0];
    expect(gap?.message).toBe("1 content gap topic found");
    expect(gap?.items?.[0]?.label).toBe("solo (score 0)");
    expect(gap?.items?.[0]?.snippet).toBe("r");
  });

  test("caps snippet keywords at 5", async () => {
    const keywords = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"];
    const checks = await run(makeCtx(ok([{ topic: "t", volume: 100, reason: "r", keywords }])));
    expect(checks[0]?.items?.[0]?.snippet).toBe("r (keywords: k1, k2, k3, k4, k5)");
  });

  test("warns on high-volume gaps above the threshold", async () => {
    const gaps: ContentGapItem[] = Array.from({ length: 21 }, (_, i) => ({
      topic: `topic ${i}`,
      volume: 600,
      reason: "r",
    }));
    const checks = await run(makeCtx(ok(gaps)));
    const hv = checks.find((c) => c.name === "content-gaps-high-volume");
    expect(hv?.status).toBe("warn");
    expect(hv?.message).toBe(
      "21 high-volume content gap topics (≥500 combined searches/mo): significant uncovered demand",
    );
    expect(hv?.message).not.toContain("—");
    expect(checks.find((c) => c.name === "content-gaps")?.items).toHaveLength(21);
  });

  test("no high-volume check at or below the threshold", async () => {
    const gaps: ContentGapItem[] = Array.from({ length: 20 }, (_, i) => ({
      topic: `topic ${i}`,
      volume: 600,
      reason: "r",
    }));
    const checks = await run(makeCtx(ok(gaps)));
    expect(checks.find((c) => c.name === "content-gaps-high-volume")).toBeUndefined();
  });
});

describe("contentGapOpportunityScore", () => {
  test("volume x relevance / difficulty", () => {
    expect(contentGapOpportunityScore({ volume: 1000, relevance: 0.5, difficulty: 25 })).toBe(20);
  });

  test("defaults: volume 0, relevance 1, difficulty 50", () => {
    expect(contentGapOpportunityScore({ volume: null })).toBe(0);
    expect(contentGapOpportunityScore({ volume: 1000 })).toBe(20);
    expect(contentGapOpportunityScore({ volume: 1000, relevance: null, difficulty: null })).toBe(20);
  });

  test("difficulty is clamped to a minimum of 1", () => {
    expect(contentGapOpportunityScore({ volume: 100, difficulty: 0 })).toBe(100);
    expect(contentGapOpportunityScore({ volume: 100, difficulty: -5 })).toBe(100);
  });

  test("rounds to 2 decimals", () => {
    expect(contentGapOpportunityScore({ volume: 10, difficulty: 3 })).toBe(3.33);
  });
});

describe("rankContentGaps", () => {
  test("ties break on volume desc, then topic asc", () => {
    const ranked = rankContentGaps([
      { topic: "b", volume: 100, difficulty: 10, reason: "" },
      { topic: "a", volume: 100, difficulty: 10, reason: "" },
      { topic: "c", volume: 200, difficulty: 20, reason: "" },
      { topic: "z", volume: 50, difficulty: 1, reason: "" },
    ]);
    expect(ranked.map((g) => g.topic)).toEqual(["z", "c", "a", "b"]);
  });

  test("does not mutate its input", () => {
    const input: ContentGapItem[] = [
      { topic: "low", volume: 1, reason: "" },
      { topic: "high", volume: 1000, reason: "" },
    ];
    rankContentGaps(input);
    expect(input.map((g) => g.topic)).toEqual(["low", "high"]);
  });
});
