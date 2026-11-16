// repo#2129: the cloud prefetch at its budget.
//
//  - every rule reading a service the budget cut off reports "not checked", with a reason;
//  - one call event per prefetch call, with its duration, including the cut-off;
//  - page batches overlap up to the plan's renderConcurrency, never wider, with the same calls;
//  - a prefetch that finishes inside its budget returns exactly what it did before.

import { describe, expect, test } from "bun:test";

import { CloudClientError, type CloudServicesClient } from "@squirrelscan/cloud-client";
import type { CloudConfig } from "@squirrelscan/config";
import {
  CLOUD_PREFETCH_OUT_OF_TIME_SKIP_REASON,
  type CloudPagePayload,
  type CloudServiceId,
  classifyRuleOutcome,
  PLANS,
  skipReasonClass,
} from "@squirrelscan/core-contracts";
import {
  CLOUD_SITE_KEY,
  humanizeCloudSkip,
  loadAllRules,
  type CheckResult,
  type RuleContext,
} from "@squirrelscan/rules";

import {
  BATCH_CONCURRENCY,
  type CloudPrefetchCallEvent,
  type CloudPrefetchInput,
  PREFETCH_DEADLINE_DETAIL,
  prefetchBatchConcurrency,
  prefetchCloudData,
  prefetchCloudDataWithDeadline,
  SUPPORTED_SERVICES,
} from "../src/cloud-prefetch";

const BALANCE = {
  balance: { monthly: 0, pack: 1000, total: 1000, periodEnd: null },
  plan: {} as never,
  pricing: {} as never,
  pricingVersion: 1,
};

const METADATA = {
  siteType: "blog",
  isYMYL: false,
  isLocalBusiness: false,
  hasOwnershipVerified: false,
  confidence: "high",
} as const;

const config = {
  enabled: true,
  max_credits_per_audit: 0,
  confirm_threshold: 1_000_000,
  batch_size: 1,
} as unknown as CloudConfig;

const pagesOf = (n: number): CloudPagePayload[] =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/p${i}`,
    textExcerpt: `page ${i}`,
  }));

/** A promise that never settles: a hung provider. */
const hang = <T>(): Promise<T> => new Promise<T>(() => {});
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("rules behind a prefetch cut off by its budget (repo#2129)", () => {
  test("every rule reading a cut-off service reports not checked with the out-of-time reason", async () => {
    const pages = pagesOf(3);
    const all = loadAllRules({ includeOptIn: true });
    // Every rule, opt-in included, that reads a service the prefetch calls.
    const cloudRules = [...all]
      .filter(([, rule]) => rule.meta.cloud && SUPPORTED_SERVICES.has(rule.meta.cloud.service))
      .map(([id, rule]) => ({ id, cloud: rule.meta.cloud! }));
    expect(new Set(cloudRules.map((r) => r.cloud.service))).toEqual(
      new Set<CloudServiceId>(SUPPORTED_SERVICES),
    );

    // Preflight answers, then Stage 0 hangs: the budget cuts off every service.
    const client = {
      getBalance: async () => BALANCE,
      siteMetadata: () => hang(),
    } as unknown as CloudServicesClient;
    const res = await prefetchCloudDataWithDeadline(
      {
        client,
        config,
        rules: cloudRules,
        pages,
        siteUrl: "https://example.com",
        metadataPages: [{ url: "https://example.com/", title: "Home" }],
        auditId: "audit-2129",
      },
      30,
    );
    expect(res.abandoned).toBe(true);
    expect(res.spend).toEqual([]);

    for (const { id, cloud } of cloudRules) {
      const key = cloud.unit === "site" ? CLOUD_SITE_KEY : pages[0].url;
      expect(res.store.get(cloud.service)?.get(key), id).toEqual({
        status: "skipped",
        skipReason: "prefetch-out-of-time",
      });

      const rule = all.get(id)!;
      const ctx = {
        cloudResults: res.store,
        page: { url: pages[0].url, rendered: false },
        options: {},
      } as unknown as RuleContext;
      const out = (await rule.run(ctx)) as { checks: CheckResult[] };
      expect(out.checks.length, id).toBeGreaterThan(0);
      for (const check of out.checks) {
        // Never passed, never silently missing: skipped, with the coded not-checked reason.
        expect(check.status, id).toBe("skipped");
        expect(check.skipReason, id).toBe(CLOUD_PREFETCH_OUT_OF_TIME_SKIP_REASON);
        expect(classifyRuleOutcome(check), id).toBe("coverage_gap");
        expect(skipReasonClass(check.skipReason)?.notChecked, id).toBe(true);
      }
    }
  });

  test("the rules' sentence is the coded not-checked reason", () => {
    expect(humanizeCloudSkip("prefetch-out-of-time")).toBe(CLOUD_PREFETCH_OUT_OF_TIME_SKIP_REASON);
    expect(skipReasonClass(CLOUD_PREFETCH_OUT_OF_TIME_SKIP_REASON)).toEqual({
      outcome: "coverage_gap",
      scope: "check",
      notChecked: true,
    });
  });
});

describe("one call event per prefetch call (repo#2129)", () => {
  const RULES: CloudPrefetchInput["rules"] = [
    {
      id: "ai/site-metadata",
      cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" },
    },
    {
      id: "gaps/keywords",
      cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
    },
    {
      id: "ai/llm-parsability",
      cloud: { service: "ai-parse", unit: "page", creditFeature: "ai_parse" },
    },
  ];

  function input(
    client: CloudServicesClient,
    events: CloudPrefetchCallEvent[],
    pages = pagesOf(4),
  ): CloudPrefetchInput {
    return {
      client,
      config,
      rules: RULES,
      pages,
      siteUrl: "https://example.com",
      sitePayloads: { "keyword-gaps": { domain: "example.com" } },
      metadataPages: [{ url: "https://example.com/", title: "Home" }],
      auditId: "audit-2129",
      onCall: (e) => events.push(e),
    };
  }

  test("completed and failed calls each report once, with a duration", async () => {
    const events: CloudPrefetchCallEvent[] = [];
    const client = {
      getBalance: async () => BALANCE,
      siteMetadata: async () => METADATA,
      keywordGaps: async () => {
        throw new CloudClientError("service_unavailable", 502, "boom");
      },
      aiParse: async (req: { pages: CloudPagePayload[] }) => ({
        results: req.pages.map((p) => ({ url: p.url })),
      }),
    } as unknown as CloudServicesClient;

    await prefetchCloudData(input(client, events));

    expect(events.map((e) => [e.service, e.status, e.batch ?? null, e.units])).toEqual([
      ["site-metadata", "completed", null, 1],
      ["ai-parse", "completed", { index: 1, of: 4 }, 1],
      ["ai-parse", "completed", { index: 2, of: 4 }, 1],
      ["ai-parse", "completed", { index: 3, of: 4 }, 1],
      ["ai-parse", "completed", { index: 4, of: 4 }, 1],
      ["keyword-gaps", "failed", null, 1],
    ]);
    expect(events[5]?.detail).toBeString();
    for (const e of events) {
      expect(e.durationMs).toBeNumber();
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("the budget cut-off reports a timeout for every call still in flight, and nothing after", async () => {
    const events: CloudPrefetchCallEvent[] = [];
    const release: Array<() => void> = [];
    const client = {
      getBalance: async () => BALANCE,
      siteMetadata: async () => METADATA,
      keywordGaps: async () => ({ gaps: [], summary: "" }),
      // p0 answers; the rest hang until released after the deadline.
      aiParse: (req: { pages: CloudPagePayload[] }) =>
        req.pages[0].url.endsWith("/p0")
          ? Promise.resolve({ results: req.pages.map((p) => ({ url: p.url })) })
          : new Promise((resolve) => {
              release.push(() => resolve({ results: req.pages.map((p) => ({ url: p.url })) }));
            }),
    } as unknown as CloudServicesClient;

    const started = Date.now();
    const res = await prefetchCloudDataWithDeadline(input(client, events, pagesOf(4)), 40);
    const elapsed = Date.now() - started;
    expect(res.abandoned).toBe(true);

    // Four in flight at once: p0 returned, so p1, p2, p3 were in flight at the cut-off,
    // and keyword-gaps (after ai-parse in run order) was never called, so it has no event.
    expect(events.map((e) => [e.service, e.status, e.batch?.index ?? null])).toEqual([
      ["site-metadata", "completed", null],
      ["ai-parse", "completed", 1],
      ["ai-parse", "timeout", 2],
      ["ai-parse", "timeout", 3],
      ["ai-parse", "timeout", 4],
    ]);
    for (const e of events.filter((x) => x.status === "timeout")) {
      expect(e.detail).toBe(PREFETCH_DEADLINE_DETAIL);
      // Measured to the cut-off: most of the budget, never more than the wait.
      expect(e.durationMs).toBeGreaterThanOrEqual(20);
      expect(e.durationMs).toBeLessThanOrEqual(elapsed + 5);
    }
    // Every key the cut-off reached reads out of time.
    for (const p of pagesOf(4).slice(1)) {
      expect(res.store.get("ai-parse")?.get(p.url)?.skipReason).toBe("prefetch-out-of-time");
    }

    // Calls that return after the cut-off add no second event.
    for (const r of release) r();
    await flush();
    await flush();
    expect(events).toHaveLength(5);
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)?.skipReason).toBe(
      "prefetch-out-of-time",
    );
  });

  test("a throwing listener never fails the prefetch", async () => {
    const client = {
      getBalance: async () => BALANCE,
      siteMetadata: async () => METADATA,
      keywordGaps: async () => ({ gaps: [], summary: "" }),
      aiParse: async (req: { pages: CloudPagePayload[] }) => ({
        results: req.pages.map((p) => ({ url: p.url })),
      }),
    } as unknown as CloudServicesClient;
    const res = await prefetchCloudData({
      ...input(client, []),
      onCall: () => {
        throw new Error("listener");
      },
    });
    expect(res.store.get("ai-parse")?.get("https://example.com/p0")?.status).toBe("ok");
  });
});

describe("page batches overlap within the plan's renderConcurrency (repo#2129)", () => {
  const RULES: CloudPrefetchInput["rules"] = [
    {
      id: "ai/llm-parsability",
      cloud: { service: "ai-parse", unit: "page", creditFeature: "ai_parse" },
    },
  ];

  /** Runs ai-parse over `n` pages, one per batch, and reports the widest overlap and the call count. */
  async function measure(n: number, planRenderConcurrency?: number) {
    let inFlight = 0;
    let widest = 0;
    let calls = 0;
    const client = {
      getBalance: async () => BALANCE,
      aiParse: async (req: { pages: CloudPagePayload[] }) => {
        calls += 1;
        inFlight += 1;
        widest = Math.max(widest, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return { results: req.pages.map((p) => ({ url: p.url })) };
      },
    } as unknown as CloudServicesClient;
    const res = await prefetchCloudData({
      client,
      config,
      rules: RULES,
      pages: pagesOf(n),
      siteUrl: "https://example.com",
      auditId: "audit-2129",
      ...(planRenderConcurrency !== undefined ? { planRenderConcurrency } : {}),
    });
    return { widest, calls, res };
  }

  test.each([
    ["free", PLANS.free.renderConcurrency],
    ["starter", PLANS.starter.renderConcurrency],
    ["team", PLANS.team.renderConcurrency],
    ["enterprise", PLANS.enterprise.renderConcurrency],
  ] as const)("%s runs exactly its renderConcurrency (%d) wide", async (_plan, width) => {
    const { widest, calls } = await measure(24, width);
    expect(widest).toBe(width);
    // The same calls as the default width: overlap changes, spend does not.
    expect(calls).toBe(24);
  });

  test("the plan values are the ones planning approved, unchanged", () => {
    expect(
      [PLANS.free, PLANS.starter, PLANS.team, PLANS.enterprise].map((p) => p.renderConcurrency),
    ).toEqual([2, 5, 10, 10]);
  });

  test("no plan width keeps the old fixed width", async () => {
    expect(prefetchBatchConcurrency(undefined)).toBe(BATCH_CONCURRENCY);
    expect(prefetchBatchConcurrency(Number.NaN)).toBe(BATCH_CONCURRENCY);
    expect(prefetchBatchConcurrency(0)).toBe(1);
    expect(prefetchBatchConcurrency(5.9)).toBe(5);
    const { widest, calls } = await measure(24);
    expect(widest).toBe(BATCH_CONCURRENCY);
    expect(calls).toBe(24);
  });

  test("width and call events never change the result of a prefetch that finishes in time", async () => {
    const serialize = (r: Awaited<ReturnType<typeof measure>>["res"]) =>
      JSON.stringify({ ...r, store: [...r.store].map(([s, m]) => [s, [...m]]) });
    const plain = (await measure(24)).res;
    const wide = (await measure(24, PLANS.team.renderConcurrency)).res;
    expect(serialize(wide)).toBe(serialize(plain));
  });
});
