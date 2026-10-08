// #280: a cloud prefetch cut off by its deadline keeps every result that had
// already returned (and reports the spend for exactly those calls) instead of
// discarding the lot.

import { describe, expect, test } from "bun:test";

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { CloudConfig } from "@squirrelscan/config";
import { getDefaultConfig } from "@squirrelscan/config";
import type {
  CloudPagePayload,
  RenderResultResponse,
  SiteMetadataResponse,
} from "@squirrelscan/core-contracts";
import { CLOUD_SITE_KEY } from "@squirrelscan/rules";

import {
  CloudPrefetchAccumulator,
  PREFETCH_DEADLINE_DETAIL,
  prefetchCloudData,
  prefetchCloudDataWithDeadline,
  type CloudPrefetchInput,
} from "../src/cloud-prefetch";
import { runContainerCloudPrefetchFromPayloads } from "../src/cloud-prefetch-run";

const config: CloudConfig = {
  enabled: true,
  max_credits_per_audit: 0,
  confirm_threshold: 1_000_000,
  batch_size: 1,
};

const pages: CloudPagePayload[] = Array.from({ length: 6 }, (_, i) => ({
  url: `https://example.com/p${i}`,
  textExcerpt: `page ${i}`,
}));

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

/** keyword-gaps (25cr, site) runs before render (2cr/page), both after Stage 0. */
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
    id: "ax/content-without-js",
    cloud: { service: "render", unit: "page", creditFeature: "render" },
  },
];

function input(client: CloudServicesClient): Omit<CloudPrefetchInput, "accumulator"> {
  return {
    client,
    config,
    rules: RULES,
    pages,
    siteUrl: "https://example.com",
    sitePayloads: { "keyword-gaps": { domain: "example.com" } },
    metadataPages: [{ url: "https://example.com/", title: "Home" }],
    auditId: "audit-1",
  };
}

/** A promise that never settles: a hung provider. */
const hang = <T>(): Promise<T> => new Promise<T>(() => {});

/** Settle every pending microtask and zero-delay timer. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Render batches (one page each, batch_size 1, four in flight at once):
 * p0 submits and finishes (freeing its slot for p4), p1 submits (charged on
 * submit) but its job never finishes, p2, p3 and p4 never get a submit
 * response. p5 waits for a slot that only frees after the deadline.
 */
function partialClient(submitted: string[], release: { p2?: () => void } = {}) {
  const client: CloudServicesClient = {
    getBalance: async () => BALANCE,
    siteMetadata: async () => METADATA,
    keywordGaps: async () => ({ gaps: [], summary: "" }),
    render: (req) => {
      const url = req.urls[0];
      submitted.push(url);
      if (url.endsWith("/p0")) return Promise.resolve({ jobId: "done", status: "queued" });
      if (url.endsWith("/p1")) return Promise.resolve({ jobId: "stuck", status: "queued" });
      if (url.endsWith("/p2")) {
        return new Promise((resolve) => {
          release.p2 = () => resolve({ jobId: "done", status: "queued" });
        });
      }
      return hang();
    },
    renderResult: async (jobId): Promise<RenderResultResponse> =>
      jobId === "done"
        ? {
            jobId,
            status: "done",
            results: [{ url: "https://example.com/p0", status: 200, html: "<html>p0</html>" }],
          }
        : { jobId, status: "running" },
  } as CloudServicesClient;
  return client;
}

describe("abandoned cloud prefetch (#280)", () => {
  test("a deadline with some services returned keeps their results and reports exactly their spend", async () => {
    const submitted: string[] = [];
    const res = await prefetchCloudDataWithDeadline(input(partialClient(submitted)), 50);

    expect(res.abandoned).toBe(true);

    // Kept: Stage 0, the site-unit service, and the render batch that returned.
    expect(res.siteMetadata).toEqual(METADATA);
    expect(res.store.get("site-metadata")?.get(CLOUD_SITE_KEY)?.status).toBe("ok");
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)).toEqual({
      status: "ok",
      data: { gaps: [], summary: "" },
      creditsSpent: 25,
    });
    const render = res.store.get("render");
    expect(render?.get("https://example.com/p0")?.status).toBe("ok");
    expect(render?.get("https://example.com/p0")?.data).toEqual({
      url: "https://example.com/p0",
      status: 200,
      html: "<html>p0</html>",
    });
    // Not returned: every other page still has an envelope, so rules skip visibly.
    for (const p of pages.slice(1)) {
      expect(render?.get(p.url)).toEqual({ status: "skipped", skipReason: "service-unavailable" });
    }

    // Spend: keyword-gaps (25) + render p0 (returned, 2) + render p1 (charged on
    // submit, its job never finished, 2). p2 to p4 never acknowledged a submit
    // and p5 was never sent, so none of them is reported.
    expect(res.spend).toEqual([
      { service: "keyword-gaps", feature: "keyword_gaps", units: 1, credits: 25 },
      { service: "render", feature: "render", units: 2, credits: 4 },
    ]);
    expect(res.totalSpent).toBe(29);
    expect(res.balanceAfter).toBe(1000 - 29);
    // An in-flight call may still be charged, so the estimate is flagged.
    expect(res.balanceAfterApproximate).toBe(true);
    expect(res.failures).toEqual([
      {
        service: "render",
        failedUnits: 5,
        attemptedUnits: 6,
        failedBatches: 5,
        reason: "service-unavailable",
        detail: PREFETCH_DEADLINE_DETAIL,
      },
    ]);
    expect(submitted).toEqual(pages.slice(0, 5).map((p) => p.url));
  });

  test("an abandoned run dispatches nothing more, and late results never reach the result", async () => {
    const submitted: string[] = [];
    const release: { p2?: () => void } = {};
    const accumulator = new CloudPrefetchAccumulator();
    void prefetchCloudData({ ...input(partialClient(submitted, release)), accumulator });
    await new Promise((r) => setTimeout(r, 50));

    const first = accumulator.abandon();
    const spendBefore = JSON.stringify(first.spend);
    const storeBefore = JSON.stringify([...first.store.get("render")!]);

    // p2's submit lands after the deadline: it frees a slot, but p5 must not
    // be sent, and nothing it brings back may change the held result.
    release.p2?.();
    await flush();
    await flush();

    expect(submitted).toEqual(pages.slice(0, 5).map((p) => p.url));
    expect(accumulator.abandon()).toBe(first);
    expect(JSON.stringify(first.spend)).toBe(spendBefore);
    expect(JSON.stringify([...first.store.get("render")!])).toBe(storeBefore);
  });

  test("abandoned before preflight returns: every planned key skips, no spend, no balance", async () => {
    const accumulator = new CloudPrefetchAccumulator();
    const client = { getBalance: () => hang() } as unknown as CloudServicesClient;
    void prefetchCloudData({ ...input(client), accumulator });
    await flush();
    const res = accumulator.abandon();
    expect(res.spend).toEqual([]);
    expect(res.totalSpent).toBe(0);
    expect(res.balanceAfter).toBeNull();
    // Nothing to qualify when there is no balance figure.
    expect("balanceAfterApproximate" in res).toBe(false);
    expect(res.siteMetadata).toBeNull();
    for (const p of pages) {
      expect(res.store.get("render")?.get(p.url)?.skipReason).toBe("service-unavailable");
    }
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)?.skipReason).toBe(
      "service-unavailable",
    );
    expect(res.failures.map((f) => [f.service, f.failedUnits])).toEqual([
      ["site-metadata", 1],
      ["keyword-gaps", 1],
      ["render", 6],
    ]);
  });

  test("a prefetch that finishes in time returns exactly what an unbounded one does", async () => {
    const complete = (): CloudServicesClient =>
      ({
        getBalance: async () => BALANCE,
        siteMetadata: async () => METADATA,
        keywordGaps: async () => ({ gaps: [], summary: "" }),
        render: async (req) => ({ jobId: req.urls[0], status: "queued" }),
        renderResult: async (jobId: string) => ({
          jobId,
          status: "done",
          results: [{ url: jobId, status: 200, html: `<html>${jobId}</html>` }],
        }),
      }) as CloudServicesClient;

    const plain = await prefetchCloudData(input(complete()));
    const bounded = await prefetchCloudDataWithDeadline(input(complete()), 60_000);
    expect("abandoned" in bounded).toBe(false);
    expect("balanceAfterApproximate" in bounded).toBe(false);
    expect(bounded).toEqual(plain);
    const serialize = (r: typeof plain) =>
      JSON.stringify({ ...r, store: [...r.store].map(([s, m]) => [s, [...m]]) });
    expect(serialize(bounded)).toBe(serialize(plain));

    // abandon() after completion hands back the completed result itself.
    const accumulator = new CloudPrefetchAccumulator();
    const done = await prefetchCloudData({ ...input(complete()), accumulator });
    expect(accumulator.abandon()).toBe(done);
    expect(accumulator.abandoned).toBe(false);
  });

  test("container path: deadlineMs keeps what returned instead of rejecting", async () => {
    const appConfig = getDefaultConfig();
    appConfig.cloud = { ...appConfig.cloud, enabled: true };
    // Every service answers except ai-parse (first in plan order), which hangs.
    const client = {
      getBalance: async () => BALANCE,
      siteMetadata: async () => METADATA,
      aiParse: () => hang(),
    } as unknown as CloudServicesClient;

    const res = await runContainerCloudPrefetchFromPayloads(
      {
        client,
        config: appConfig,
        siteUrl: "https://example.com",
        auditId: "audit-1",
        remainingBudget: 500,
        crawlRendered: true,
        deadlineMs: 50,
      },
      {
        pages,
        metadataPages: [{ url: "https://example.com/", title: "Home" }],
        blocklist: null,
        gapsSeeds: [],
        renderedPageUrls: new Set(),
      },
    );

    expect(res?.abandoned).toBe(true);
    expect(res?.siteMetadata).toEqual(METADATA);
    expect(res?.store.get("ai-parse")?.get(pages[0].url)?.skipReason).toBe("service-unavailable");
    expect(res?.spend).toEqual([]);
  });
});
