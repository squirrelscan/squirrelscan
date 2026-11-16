// gaps/recommendations: generative content recommendations (cloud, site-scope).

import { describe, expect, test } from "bun:test";

import type {
  ContentRecommendationItem,
  ContentRecommendationsResponse,
} from "@squirrelscan/core-contracts";

import { CLOUD_SITE_KEY, type CloudResultEnvelope, type CloudResultStore } from "../src/cloud";
import { contentRecommendationsRule } from "../src/gaps/recommendations";
import type { CheckResult, RuleContext } from "../src/types";

function makeCtx(envelope?: CloudResultEnvelope<ContentRecommendationsResponse>): RuleContext {
  const cloudResults: CloudResultStore | undefined = envelope
    ? new Map([
        ["content-recommendations", new Map([[CLOUD_SITE_KEY, envelope as CloudResultEnvelope]])],
      ])
    : undefined;
  return { cloudResults, options: {} } as RuleContext;
}

function ok(
  recommendations: ContentRecommendationItem[],
): CloudResultEnvelope<ContentRecommendationsResponse> {
  return {
    status: "ok",
    data: { recommendations, summary: "s" },
  } as CloudResultEnvelope<ContentRecommendationsResponse>;
}

async function run(ctx: RuleContext): Promise<CheckResult[]> {
  return ((await contentRecommendationsRule.run(ctx)) as { checks: CheckResult[] }).checks;
}

const item = (over: Partial<ContentRecommendationItem>): ContentRecommendationItem => ({
  category: "net-new-topic",
  title: "Topic",
  rationale: "Because.",
  priority: "medium",
  ...over,
});

describe("gaps/recommendations", () => {
  test("is opt-in and cloud-backed with its own credit feature", () => {
    expect(contentRecommendationsRule.meta.optIn).toBe(true);
    expect(contentRecommendationsRule.meta.cloud).toEqual({
      service: "content-recommendations",
      unit: "site",
      creditFeature: "content_recommendations",
    });
  });

  test("skips with no cloud result (free plan / local-only)", async () => {
    const checks = await run(makeCtx());
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("passes the skip reason through", async () => {
    const checks = await run(
      makeCtx({
        status: "skipped",
        skipReason: "not-authenticated",
      } as CloudResultEnvelope<ContentRecommendationsResponse>),
    );
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBeTruthy();
  });

  test("passes when there are no recommendations", async () => {
    const checks = await run(makeCtx(ok([])));
    expect(checks[0]?.status).toBe("pass");
  });

  test("emits one info check per category present, high priority first", async () => {
    const checks = await run(
      makeCtx(
        ok([
          item({ title: "low", priority: "low" }),
          item({ title: "high", priority: "high" }),
          item({ category: "format", title: "FAQ" }),
          item({ category: "cluster-completion", title: "Cluster" }),
          item({ category: "funnel-coverage", title: "BOFU", funnelStage: "bofu" }),
          item({
            category: "content-refresh",
            title: "Refresh pricing",
            pages: ["https://example.com/pricing"],
            signal: "thin",
          }),
        ]),
      ),
    );
    expect(checks.map((c) => c.name)).toEqual([
      "recommendations-net-new-topics",
      "recommendations-content-refresh",
      "recommendations-cluster-completion",
      "recommendations-formats",
      "recommendations-funnel-coverage",
    ]);
    expect(checks.every((c) => c.status === "info")).toBe(true);
    expect(checks[0]?.items?.map((i) => i.label)).toEqual(["high", "low"]);
  });

  test("a refresh suggestion names its page and cites the triggering signal", async () => {
    const checks = await run(
      makeCtx(
        ok([
          item({
            category: "content-refresh",
            title: "Refresh pricing",
            pages: ["https://example.com/pricing"],
            signal: "stale",
          }),
        ]),
      ),
    );
    const refresh = checks.find((c) => c.name === "recommendations-content-refresh");
    expect(refresh?.items?.[0]?.id).toBe("https://example.com/pricing");
    expect(refresh?.items?.[0]?.snippet).toContain("stale content");
    expect(refresh?.items?.[0]?.snippet).toContain("https://example.com/pricing");
  });
});
