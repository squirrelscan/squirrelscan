// #2129: the cloud prefetch no longer holds the rules phase. It runs in the
// background, rules attach to its live store, and each cloud rule waits for only
// the envelope it reads. Spend-neutral: the same render calls at the same
// concurrency as the awaited prefetch, only the waiting moves.

import { describe, expect, test } from "bun:test";

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { CloudConfig } from "@squirrelscan/config";
import type {
  CloudPagePayload,
  RenderResultResponse,
  SiteMetadataResponse,
} from "@squirrelscan/core-contracts";
import {
  RuleRunner,
  type PageData,
  type Rule,
  type RuleResult,
  type RulesConfig,
  type SiteData,
} from "@squirrelscan/rules";
import { readCloudResult } from "@squirrelscan/rules";

import {
  prefetchCloudData,
  startCloudPrefetch,
  type CloudPrefetchCallEvent,
  type CloudPrefetchInput,
} from "../src/cloud-prefetch";

const config = {
  enabled: true,
  max_credits_per_audit: 0,
  confirm_threshold: 1_000_000,
  batch_size: 10,
} as unknown as CloudConfig;

const makePages = (n: number): CloudPagePayload[] =>
  Array.from({ length: n }, (_, i) => ({ url: `https://example.com/p${i}`, textExcerpt: `p${i}` }));

const BALANCE = {
  balance: { monthly: 0, pack: 1000, total: 1000, periodEnd: null },
  plan: {} as never,
  pricing: {} as never,
  pricingVersion: 1,
};
const METADATA: SiteMetadataResponse = {
  siteType: "blog",
  isYMYL: false,
  isLocalBusiness: false,
  hasOwnershipVerified: false,
  confidence: "high",
};
const RULES: CloudPrefetchInput["rules"] = [
  {
    id: "ai/site-metadata",
    cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" },
  },
  { id: "ax/content-without-js", cloud: { service: "render", unit: "page", creditFeature: "render" } },
];

function input(client: CloudServicesClient, pages: CloudPagePayload[]) {
  return {
    client,
    config,
    rules: RULES,
    pages,
    siteUrl: "https://example.com",
    metadataPages: [{ url: "https://example.com/", title: "Home" }],
    auditId: "audit-1",
  } satisfies Omit<CloudPrefetchInput, "accumulator">;
}

/** Stub render service counting submits and the most renders open at once. */
function renderStub(opts: { latencyMs?: number; gate?: (firstUrl: string) => Promise<void> } = {}) {
  const stats = { renderCalls: 0, inFlight: 0, maxInFlight: 0 };
  const jobs = new Map<string, string[]>();
  const client = {
    getBalance: async () => BALANCE,
    siteMetadata: async () => METADATA,
    render: async (req: { urls: string[] }) => {
      stats.renderCalls++;
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      const jobId = `job-${stats.renderCalls}`;
      jobs.set(jobId, req.urls);
      await opts.gate?.(req.urls[0]);
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      return { jobId, status: "queued" };
    },
    renderResult: async (jobId: string): Promise<RenderResultResponse> => {
      stats.inFlight--;
      return {
        jobId,
        status: "done",
        results: jobs.get(jobId)!.map((url) => ({ url, status: 200, html: "<html></html>" })),
      };
    },
  } as unknown as CloudServicesClient;
  return { client, stats };
}

describe("spend parity (#2129)", () => {
  test("the background prefetch makes the same render calls at the same concurrency as the awaited one", async () => {
    const pages = makePages(45); // 5 render batches of 10 urls, BATCH_CONCURRENCY 4

    const before = renderStub({ latencyMs: 15 });
    const awaited = await prefetchCloudData(input(before.client, pages));

    const after = renderStub({ latencyMs: 15 });
    const started = startCloudPrefetch(input(after.client, pages), 30_000);
    const overlapped = await started.settled;

    console.log(
      `render calls before=${before.stats.renderCalls} after=${after.stats.renderCalls}; ` +
        `max in-flight before=${before.stats.maxInFlight} after=${after.stats.maxInFlight}`,
    );
    expect(before.stats.renderCalls).toBe(5);
    expect(after.stats.renderCalls).toBe(before.stats.renderCalls);
    expect(before.stats.maxInFlight).toBe(4);
    expect(after.stats.maxInFlight).toBe(before.stats.maxInFlight);
    expect(overlapped.abandoned).toBeUndefined();
    expect(overlapped.spend).toEqual(awaited.spend);
    expect(overlapped.totalSpent).toBe(awaited.totalSpent);
    expect([...overlapped.store.get("render")!.keys()]).toEqual([
      ...awaited.store.get("render")!.keys(),
    ]);
  });
});

describe("rules attach to a running prefetch (#2129)", () => {
  test("rules start before a slow prefetch finishes, and each cloud rule waits for only its own page", async () => {
    const pages = makePages(25); // render batches: p0-9, p10-19, p20-24
    const release: Record<string, () => void> = {};
    const { client } = renderStub({
      gate: (firstUrl) =>
        new Promise<void>((resolve) => {
          release[firstUrl] = resolve;
        }),
    });
    const started = startCloudPrefetch(input(client, pages), 30_000);
    const acc = started.accumulator;

    const seen: string[] = [];
    const rules: Rule[] = [
      {
        meta: { id: "test/plain", name: "p", description: "p", category: "core", scope: "page", severity: "warning", weight: 1 },
        run: (): RuleResult => {
          seen.push("plain");
          return { checks: [{ name: "plain", status: "pass", message: "ok" }] };
        },
      },
      {
        meta: {
          id: "test/cloudy",
          name: "c",
          description: "c",
          category: "core",
          scope: "page",
          severity: "warning",
          weight: 1,
          cloud: { service: "render", unit: "page", creditFeature: "render" },
        },
        run: (ctx): RuleResult => {
          const env = readCloudResult(ctx.cloudResults, "render", ctx.page.url);
          seen.push(`cloudy:${ctx.page.url.split("/").pop()}:${env?.status}`);
          return { checks: [{ name: "cloudy", status: "pass", message: String(env?.status) }] };
        },
      },
    ];
    const rulesConfig: RulesConfig = { rule_options: {}, rules: { enable: ["test/plain", "test/cloudy"] } };
    // The rules phase starts as soon as the site profile is decided.
    await acc.whenProfileReady();
    const runner = new RuleRunner({
      config: rulesConfig,
      additionalNamespaces: [{ name: "test", rules }],
      siteMetadata: acc.siteMetadata ?? undefined,
      cloudResults: acc.store,
      cloudReady: (service, key) => acc.whenReady(service, key),
    });
    const site: SiteData = { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null };
    const page = (n: number): PageData => ({
      url: `https://example.com/p${n}`,
      html: "<html><head><title>t</title></head><body>x</body></html>",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    });

    let settled = false;
    void started.settled.then(() => (settled = true));
    const p0 = runner.runPageRules(page(0), site);
    const p24 = runner.runPageRules(page(24), site);
    await new Promise((r) => setTimeout(r, 20));
    // Both pages' plain rules ran with the prefetch still unsettled; the cloud
    // rules are parked on their envelopes.
    expect(settled).toBe(false);
    expect(seen).toEqual(["plain", "plain"]);

    // p0's batch lands: p0's cloud rule runs, p24's still waits.
    release["https://example.com/p0"]!();
    const r0 = await p0;
    expect(settled).toBe(false);
    expect(seen).toContain("cloudy:p0:ok");
    expect(seen).not.toContain("cloudy:p24:ok");
    expect(r0.ruleResults.get("test/cloudy")!.checks[0].message).toBe("ok");

    release["https://example.com/p10"]!();
    release["https://example.com/p20"]!();
    await p24;
    await started.settled;
    expect(seen).toContain("cloudy:p24:ok");
  });

  test("the budget cuts the stage off: the run continues and waiting rules read a skip", async () => {
    const pages = makePages(25);
    const { client } = renderStub({ gate: () => new Promise<void>(() => {}) }); // render hangs
    const started = startCloudPrefetch(input(client, pages), 60);
    const waiter = started.accumulator.whenReady("render", "https://example.com/p3");
    expect(waiter).toBeDefined();

    const result = await started.settled;
    await waiter; // released by the cut-off, not hung
    expect(result.abandoned).toBe(true);
    expect(started.accumulator.store.get("render")?.get("https://example.com/p3")).toEqual({
      status: "skipped",
      skipReason: "service-unavailable",
    });
    expect(started.accumulator.whenReady("render", "https://example.com/p3")).toBeUndefined();
  });
});

describe("per-call stage events (#2129)", () => {
  test("one event per prefetch call with its duration; a throwing listener is ignored", async () => {
    const pages = makePages(25);
    const { client } = renderStub({ latencyMs: 12 });
    const events: CloudPrefetchCallEvent[] = [];
    let threw = false;
    const started = startCloudPrefetch(
      {
        ...input(client, pages),
        onCallEvent: (e) => {
          events.push(e);
          if (!threw) {
            threw = true;
            throw new Error("listener bug");
          }
        },
      },
      30_000,
    );
    const res = await started.settled;
    expect(res.abandoned).toBeUndefined();

    expect(events.filter((e) => e.service === "site-metadata")).toHaveLength(1);
    const batches = events.filter((e) => e.service === "render");
    expect(batches).toHaveLength(3);
    expect(batches.map((e) => e.units).sort((a, b) => a - b)).toEqual([5, 10, 10]);
    for (const e of batches) {
      expect(e.kind).toBe("batch");
      expect(e.batchCount).toBe(3);
      expect(e.ok).toBe(true);
      expect(e.durationMs).toBeGreaterThanOrEqual(10);
    }
    expect(events).toHaveLength(4);
  });
});
