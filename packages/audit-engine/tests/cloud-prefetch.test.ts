import { describe, expect, test } from "bun:test";

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import { CloudClientError } from "@squirrelscan/cloud-client";
import type { CloudConfig } from "@squirrelscan/config";
import type {
  CloudPagePayload,
  CloudServiceId,
  SiteMetadata,
  SiteMetadataPagePayload,
  SiteMetadataResponse,
} from "@squirrelscan/core-contracts";
import { CLOUD_SITE_KEY } from "@squirrelscan/rules";

import {
  BATCH_BYTE_BUDGET,
  BATCH_CONCURRENCY,
  chunkPagesBySize,
  prefetchCloudData,
  type CloudPrefetchInput,
} from "../src/cloud-prefetch";

const config: CloudConfig = {
  enabled: true,
  max_credits_per_audit: 200,
  confirm_threshold: 50,
  batch_size: 20,
};

const pages: CloudPagePayload[] = Array.from({ length: 5 }, (_, i) => ({
  url: `https://example.com/p${i}`,
  textExcerpt: `page ${i}`,
}));

const RULES: CloudPrefetchInput["rules"] = [
  {
    id: "ai/llm-parsability",
    cloud: { service: "ai-parse", unit: "page", creditFeature: "ai_parse" },
  },
  {
    id: "eeat/authority-signals",
    cloud: { service: "authority-signals", unit: "page", creditFeature: "authority_signals" },
  },
  {
    id: "adblock/blocked-links",
    cloud: { service: "blocklist-check", unit: "site", creditFeature: "adblock_detect" },
  },
];

/** Site payload so the site-unit blocklist-check actually dispatches. */
const SITE_PAYLOADS = {
  "blocklist-check": { urls: ["https://example.com/ad.js"] },
} as const;

const BALANCE = {
  balance: { monthly: 0, pack: 1000, total: 1000, periodEnd: null },
  plan: {} as never,
  pricing: {} as never,
  pricingVersion: 1,
};

function okClient(overrides: Partial<CloudServicesClient> = {}): CloudServicesClient {
  return {
    getBalance: async () => BALANCE,
    aiParse: async (req) => ({
      results: req.pages.map((p) => ({
        url: p.url,
        pageType: "article" as const,
        parsabilityScore: 90,
        confidence: 0.9,
      })),
    }),
    authoritySignals: async (req) => ({
      results: req.pages.map((p) => ({
        url: p.url,
        authorPresent: true,
        citationCount: 1,
        outboundLinkCount: 2,
        signals: [],
      })),
    }),
    blocklistCheck: async () => ({ matches: [], listsVersion: "test" }),
    siteMetadata: async () => METADATA_RESPONSE,
    // Gaps are the only audit-scoped PAID services under pricing v10 (25cr each),
    // so cap/confirm/truncation coverage uses them where a folded service can't.
    keywordGaps: async () => ({ gaps: [], summary: "" }),
    contentGaps: async () => ({ gaps: [], summary: "" }),
    ...overrides,
  };
}

/** A resolved Stage-0 profile the metadata stub returns. */
const METADATA_RESPONSE: SiteMetadataResponse = {
  siteType: "blog",
  isYMYL: false,
  isLocalBusiness: false,
  hasOwnershipVerified: false,
  confidence: "high",
};

/** Sample page payload for the Stage-0 metadata call. */
const METADATA_PAGES: SiteMetadataPagePayload[] = [{ url: "https://example.com/", title: "Home" }];

/** Rule set that triggers Stage-0 (`site-metadata`) plus two gateable services. */
const META_RULES: CloudPrefetchInput["rules"] = [
  {
    id: "ai/site-metadata",
    cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" },
  },
  {
    id: "seo/keyword-gaps",
    cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
  },
  {
    id: "ai/llm-parsability",
    cloud: { service: "ai-parse", unit: "page", creditFeature: "ai_parse" },
  },
];

/** Site payload so keyword-gaps actually dispatches when not gated out. */
const META_SITE_PAYLOADS = {
  "keyword-gaps": { domain: "example.com" },
} as const;

function input(partial: Partial<CloudPrefetchInput>): CloudPrefetchInput {
  return {
    client: okClient(),
    config,
    rules: RULES,
    pages,
    siteUrl: "https://example.com",
    sitePayloads: SITE_PAYLOADS,
    auditId: "audit-1",
    ...partial,
  };
}

describe("prefetchCloudData", () => {
  test("happy path: envelopes for every page + site, spend totals match", async () => {
    const res = await prefetchCloudData(input({}));
    // Pricing v10: ai_parse, authority_signals, adblock_detect are all folded
    // (0cr). Every service still DISPATCHES (ok envelopes) but spends nothing.
    expect(res.totalSpent).toBe(0);
    expect(res.balanceAfter).toBe(1000);
    expect(res.failures).toEqual([]);
    const aiParse = res.store.get("ai-parse");
    expect(aiParse?.size).toBe(5);
    expect(aiParse?.get(pages[0].url)?.status).toBe("ok");
    // Folded services record a 0-credit envelope and push no spend line.
    expect(aiParse?.get(pages[0].url)?.creditsSpent).toBe(0);
    expect(res.spend).toEqual([]);
    expect(res.store.get("blocklist-check")?.get(CLOUD_SITE_KEY)?.status).toBe("ok");
  });

  test("regression: an all-folded plan (no priced services) still dispatches every service at 0 credits", async () => {
    // Guards the v10 fold-to-0 dispatch bug: when EVERY planned service is folded,
    // the total estimate is 0 — which must NOT short-circuit dispatch. The audit
    // base the user already paid covers these, so each service still runs and
    // returns data; folded work writes ok envelopes with creditsSpent 0, pushes no
    // spend line, and leaves the balance untouched. RULES carry no gaps service.
    const res = await prefetchCloudData(input({}));
    const aiParse = res.store.get("ai-parse");
    expect(aiParse?.size).toBe(5);
    for (const p of pages) {
      expect(aiParse?.get(p.url)?.status).toBe("ok");
      expect(aiParse?.get(p.url)?.creditsSpent).toBe(0);
    }
    const authority = res.store.get("authority-signals");
    expect(authority?.size).toBe(5);
    expect(authority?.get(pages[0].url)?.status).toBe("ok");
    expect(authority?.get(pages[0].url)?.creditsSpent).toBe(0);
    const blocklist = res.store.get("blocklist-check")?.get(CLOUD_SITE_KEY);
    expect(blocklist?.status).toBe("ok");
    expect(blocklist?.creditsSpent).toBe(0);
    // Nothing priced ran → no spend lines, no charge, balance unchanged.
    expect(res.spend).toEqual([]);
    expect(res.totalSpent).toBe(0);
    expect(res.balanceAfter).toBe(1000);
    expect(res.failures).toEqual([]);
  });

  test("null client: every service skips not-authenticated, zero spend", async () => {
    const res = await prefetchCloudData(input({ client: null }));
    expect(res.totalSpent).toBe(0);
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.skipReason).toBe("not-authenticated");
    expect(res.store.get("blocklist-check")?.get(CLOUD_SITE_KEY)?.skipReason).toBe(
      "not-authenticated",
    );
  });

  test("cloud disabled: skips not-prefetched without calling the client", async () => {
    let called = false;
    const client = okClient({
      getBalance: async () => {
        called = true;
        return BALANCE;
      },
    });
    const res = await prefetchCloudData(input({ client, config: { ...config, enabled: false } }));
    expect(called).toBe(false);
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.skipReason).toBe("not-prefetched");
  });

  test("cap truncates deterministically: a paid service past the cap reads credit-cap-reached", async () => {
    // Folded services (0cr) never consume the cap, so truncation is exercised
    // with the only priced audit services — gaps (25cr each). Cap 25 fits the
    // first (service-id-sorted: content-gaps), leaving 0 for keyword-gaps →
    // cap-reached. Folded ai-parse (0cr) always fits and still runs.
    const res = await prefetchCloudData(
      input({
        rules: [
          {
            id: "seo/content-gaps",
            cloud: { service: "content-gaps", unit: "site", creditFeature: "content_gaps" },
          },
          {
            id: "seo/keyword-gaps",
            cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
          },
          {
            id: "ai/llm-parsability",
            cloud: { service: "ai-parse", unit: "page", creditFeature: "ai_parse" },
          },
        ],
        sitePayloads: {
          "keyword-gaps": { domain: "example.com" },
          "content-gaps": { domain: "example.com" },
        },
        config: { ...config, max_credits_per_audit: 25 },
      }),
    );
    expect(res.totalSpent).toBe(25);
    expect(res.store.get("content-gaps")?.get(CLOUD_SITE_KEY)?.status).toBe("ok");
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)?.skipReason).toBe(
      "credit-cap-reached",
    );
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.status).toBe("ok");
  });

  test("declined confirm: everything skips not-prefetched", async () => {
    // A paid gaps service (25cr) crosses the threshold so the confirm actually
    // fires (folded services alone estimate 0 and never prompt); declining leaves
    // everything not-prefetched — nothing dispatched.
    const res = await prefetchCloudData(
      input({
        rules: [
          {
            id: "seo/keyword-gaps",
            cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
          },
        ],
        sitePayloads: { "keyword-gaps": { domain: "example.com" } },
        config: { ...config, confirm_threshold: 1 },
        confirm: async () => false,
      }),
    );
    expect(res.totalSpent).toBe(0);
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)?.skipReason).toBe("not-prefetched");
  });

  test("estimate at/below threshold does not prompt", async () => {
    let prompted = false;
    // keyword-gaps estimate (25) == threshold (25): `estimate > threshold` is
    // false → no prompt; the service runs and charges its 25.
    const res = await prefetchCloudData(
      input({
        rules: [
          {
            id: "seo/keyword-gaps",
            cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
          },
        ],
        sitePayloads: { "keyword-gaps": { domain: "example.com" } },
        config: { ...config, confirm_threshold: 25 },
        confirm: async () => {
          prompted = true;
          return false;
        },
      }),
    );
    expect(prompted).toBe(false);
    expect(res.totalSpent).toBe(25);
  });

  test("402 mid-run short-circuits all remaining work as insufficient-credits", async () => {
    const client = okClient({
      aiParse: async () => {
        throw new CloudClientError("insufficient_credits", 402, "out", { required: 5 });
      },
    });
    const res = await prefetchCloudData(input({ client }));
    expect(res.totalSpent).toBe(0);
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.skipReason).toBe("insufficient-credits");
    // Later services never attempted.
    expect(res.store.get("authority-signals")?.get(pages[0].url)?.skipReason).toBe(
      "insufficient-credits",
    );
    expect(res.store.get("blocklist-check")?.get(CLOUD_SITE_KEY)?.skipReason).toBe(
      "insufficient-credits",
    );
  });

  test("run_inactive (reaped mid-run) short-circuits remaining work without wasted dispatch (#475)", async () => {
    let authorityCalls = 0;
    let blocklistCalls = 0;
    const client = okClient({
      aiParse: async () => {
        throw new CloudClientError("run_inactive", 409, "Run is no longer active");
      },
      authoritySignals: async (req) => {
        authorityCalls += 1;
        return {
          results: req.pages.map((p) => ({
            url: p.url,
            authorPresent: true,
            citationCount: 1,
            outboundLinkCount: 2,
            signals: [],
          })),
        };
      },
      blocklistCheck: async () => {
        blocklistCalls += 1;
        return { matches: [], listsVersion: "test" };
      },
    });
    const res = await prefetchCloudData(input({ client }));
    expect(res.totalSpent).toBe(0);
    // A reaped run bails out — later services are NOT dispatched (the whole point).
    expect(authorityCalls).toBe(0);
    expect(blocklistCalls).toBe(0);
    // Remaining work is stamped service-unavailable (a dead run, NOT insufficient-credits).
    expect(res.store.get("authority-signals")?.get(pages[0].url)?.skipReason).toBe(
      "service-unavailable",
    );
    expect(res.store.get("blocklist-check")?.get(CLOUD_SITE_KEY)?.skipReason).toBe(
      "service-unavailable",
    );
    // The stop detail reflects the real cause, not "out of credits".
    expect(res.failures.some((f) => f.detail === "run no longer active")).toBe(true);
  });

  test("a failed chunk loses only that chunk; other services still run", async () => {
    const client = okClient({
      authoritySignals: async () => {
        throw new CloudClientError("service_unavailable", 502, "down");
      },
    });
    const res = await prefetchCloudData(input({ client }));
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.status).toBe("ok");
    expect(res.store.get("authority-signals")?.get(pages[0].url)?.skipReason).toBe(
      "service-unavailable",
    );
    expect(res.store.get("blocklist-check")?.get(CLOUD_SITE_KEY)?.status).toBe("ok");
    // All three are folded (0cr) in v10, so nothing is spent regardless.
    expect(res.totalSpent).toBe(0);
    // The failure is reported, not silently swallowed.
    expect(res.failures).toEqual([
      {
        service: "authority-signals",
        failedUnits: 5,
        attemptedUnits: 5,
        failedBatches: 1,
        reason: "service-unavailable",
        detail: "service error (502)",
      },
    ]);
  });

  test("413 marks the batch payload-too-large and reports the failure", async () => {
    const calls: number[] = [];
    const client = okClient({
      aiParse: async (req) => {
        calls.push(req.pages.length);
        if (calls.length === 2) {
          throw new CloudClientError("payload_too_large", 413, "too big");
        }
        return {
          results: req.pages.map((p) => ({
            url: p.url,
            pageType: "article" as const,
            parsabilityScore: 90,
            confidence: 0.9,
          })),
        };
      },
    });
    const res = await prefetchCloudData(
      input({ rules: [RULES[0]], client, config: { ...config, batch_size: 3 } }),
    );
    // ai-parse is folded (0cr): batch 1 ran, batch 2 413'd — either way, 0 spent.
    // The 413 failure/skip bookkeeping is unchanged by the price fold.
    expect(res.totalSpent).toBe(0);
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.status).toBe("ok");
    expect(res.store.get("ai-parse")?.get(pages[4].url)?.skipReason).toBe("payload-too-large");
    expect(res.failures).toEqual([
      {
        service: "ai-parse",
        failedUnits: 2,
        attemptedUnits: 5,
        failedBatches: 1,
        reason: "payload-too-large",
        detail: "payload too large",
      },
    ]);
  });

  test("site-unit failure is reported", async () => {
    const client = okClient({
      blocklistCheck: async () => {
        throw new CloudClientError("service_unavailable", 0, "boom");
      },
    });
    const res = await prefetchCloudData(input({ rules: [RULES[2]], client }));
    expect(res.failures).toEqual([
      {
        service: "blocklist-check",
        failedUnits: 1,
        attemptedUnits: 1,
        failedBatches: 1,
        reason: "service-unavailable",
        detail: "service error",
      },
    ]);
  });

  test("partial batch: pages missing from results are skipped, batch still billed", async () => {
    const client = okClient({
      aiParse: async (req) => ({
        results: req.pages
          .slice(1)
          .map((p) => ({
            url: p.url,
            pageType: "article" as const,
            parsabilityScore: 50,
            confidence: 0.5,
          })),
      }),
    });
    const res = await prefetchCloudData(input({ rules: [RULES[0]], client }));
    const aiParse = res.store.get("ai-parse");
    expect(aiParse?.get(pages[0].url)?.skipReason).toBe("service-unavailable");
    expect(aiParse?.get(pages[1].url)?.status).toBe("ok");
    // ai-parse folded (0cr): the batch billed nothing even though it ran.
    expect(res.totalSpent).toBe(0);
  });

  test("getBalance failure skips everything service-unavailable", async () => {
    const client = okClient({
      getBalance: async () => {
        throw new CloudClientError("network_error", 0, "dns");
      },
    });
    const res = await prefetchCloudData(input({ client }));
    expect(res.totalSpent).toBe(0);
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.skipReason).toBe("service-unavailable");
  });

  test("batch_size chunks requests", async () => {
    const sizes: number[] = [];
    const client = okClient({
      aiParse: async (req) => {
        sizes.push(req.pages.length);
        return {
          results: req.pages.map((p) => ({
            url: p.url,
            pageType: "other" as const,
            parsabilityScore: 0,
            confidence: 0,
          })),
        };
      },
    });
    await prefetchCloudData(
      input({ rules: [RULES[0]], client, config: { ...config, batch_size: 2 } }),
    );
    expect(sizes).toEqual([2, 2, 1]);
  });

  test("page-unit batches overlap (bounded by BATCH_CONCURRENCY), merge stays ordered", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const manyPages: CloudPagePayload[] = Array.from({ length: 12 }, (_, i) => ({
      url: `https://example.com/c${i}`,
      textExcerpt: `page ${i}`,
    }));
    const client = okClient({
      aiParse: async (req) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return {
          results: req.pages.map((p) => ({
            url: p.url,
            pageType: "other" as const,
            parsabilityScore: 0,
            confidence: 0,
          })),
        };
      },
    });
    // batch_size 2 → 6 batches; they overlap up to BATCH_CONCURRENCY at once.
    const res = await prefetchCloudData(
      input({
        rules: [RULES[0]],
        client,
        pages: manyPages,
        config: { ...config, batch_size: 2, max_credits_per_audit: 0 },
      }),
    );
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(BATCH_CONCURRENCY);
    // ai-parse folded (0cr): all 12 pages dispatched across overlapping batches,
    // 0 spent. Concurrency + ordered merge are unaffected by the price fold.
    expect(res.totalSpent).toBe(0);
    // Every page resolved, and store insertion order matches input order (deterministic merge).
    const aiParse = res.store.get("ai-parse");
    expect([...(aiParse?.keys() ?? [])]).toEqual(manyPages.map((p) => p.url));
    expect([...(aiParse?.values() ?? [])].every((e) => e.status === "ok")).toBe(true);
  });

  test("parallel batches: a 402 in the first wave short-circuits later batches without dispatching", async () => {
    let callCount = 0;
    const tenPages: CloudPagePayload[] = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/x${i}`,
      textExcerpt: `page ${i}`,
    }));
    const client = okClient({
      aiParse: async () => {
        callCount++;
        throw new CloudClientError("insufficient_credits", 402, "out", { required: 5 });
      },
    });
    // batch_size 2 → 5 batches; BATCH_CONCURRENCY = 4 caps the first wave at 4,
    // outOfCredits flips, so the 5th batch must never call the client.
    const res = await prefetchCloudData(
      input({
        rules: [RULES[0]],
        client,
        pages: tenPages,
        config: { ...config, batch_size: 2, max_credits_per_audit: 0 },
      }),
    );
    expect(callCount).toBeLessThanOrEqual(BATCH_CONCURRENCY);
    expect(callCount).toBeLessThan(5); // at least one batch skipped without dispatch
    expect(res.totalSpent).toBe(0);
    // Every page is marked insufficient-credits (dispatched-and-failed or skipped).
    const aiParse = res.store.get("ai-parse");
    expect(
      [...(aiParse?.values() ?? [])].every((e) => e.skipReason === "insufficient-credits"),
    ).toBe(true);
    expect(res.failures[0]?.reason).toBe("insufficient-credits");
    expect(res.failures[0]?.failedUnits).toBe(10);
  });

  test("no cloud rules → empty result, no client calls", async () => {
    const res = await prefetchCloudData(input({ rules: [] }));
    expect(res.store.size).toBe(0);
    expect(res.totalSpent).toBe(0);
  });

  test("result always carries siteMetadata (null when no metadata service runs)", async () => {
    const res = await prefetchCloudData(input({}));
    expect(res.siteMetadata).toBeNull();
  });
});

describe("prefetchCloudData Stage 0 + Stage 1", () => {
  test("Stage 0: metadata resolves FIRST, charges 12cr, and seeds result.siteMetadata", async () => {
    const callOrder: CloudServiceId[] = [];
    const client = okClient({
      siteMetadata: async () => {
        callOrder.push("site-metadata");
        return METADATA_RESPONSE;
      },
      keywordGaps: async () => {
        callOrder.push("keyword-gaps");
        return { gaps: [], summary: "" };
      },
      aiParse: async (req) => {
        callOrder.push("ai-parse");
        return {
          results: req.pages.map((p) => ({
            url: p.url,
            pageType: "article" as const,
            parsabilityScore: 90,
            confidence: 0.9,
          })),
        };
      },
    });
    const res = await prefetchCloudData(
      input({
        client,
        rules: META_RULES,
        metadataPages: METADATA_PAGES,
        sitePayloads: META_SITE_PAYLOADS,
        // No gate → both downstream services run.
      }),
    );
    // Metadata is the FIRST cloud call.
    expect(callOrder[0]).toBe("site-metadata");
    expect(res.siteMetadata).toEqual(METADATA_RESPONSE);
    expect(res.store.get("site-metadata")?.get(CLOUD_SITE_KEY)?.status).toBe("ok");
    // v10: metadata folded (0cr) + ai-parse folded (0cr) + keyword-gaps 25 = 25.
    expect(res.totalSpent).toBe(25);
    // site-metadata still dispatches (siteMetadata resolved) but at 0 credits —
    // a folded service writes an ok envelope and pushes NO spend line.
    expect(res.spend.find((l) => l.service === "site-metadata")).toBeUndefined();
    expect(res.store.get("site-metadata")?.get(CLOUD_SITE_KEY)?.creditsSpent).toBe(0);
    expect(res.spend.find((l) => l.service === "keyword-gaps")?.credits).toBe(25);
  });

  test("Stage 0: a cached (0-credit) metadata hit charges nothing and leaves the full cap for downstream", async () => {
    const client = okClient({
      siteMetadata: async () => ({ ...METADATA_RESPONSE, cached: true }),
      keywordGaps: async () => ({ gaps: [], summary: "" }),
    });
    // Cap = 30. metadata is folded (0cr) so it never eats the cap; the cached
    // flag just proves the 0-credit envelope + no spend line. keyword-gaps (25)
    // + ai-parse (folded, 0) both fit and run.
    const res = await prefetchCloudData(
      input({
        client,
        rules: META_RULES,
        metadataPages: METADATA_PAGES,
        sitePayloads: META_SITE_PAYLOADS,
        config: { ...config, max_credits_per_audit: 30 },
      }),
    );
    expect(res.siteMetadata).toEqual({ ...METADATA_RESPONSE, cached: true });
    // No spend line, and the envelope records 0 credits for the cached call.
    expect(res.spend.some((l) => l.service === "site-metadata")).toBe(false);
    expect(res.store.get("site-metadata")?.get(CLOUD_SITE_KEY)?.creditsSpent).toBe(0);
    // keyword-gaps (25) ran; ai-parse folded (0). Total 25.
    expect(res.spend.some((l) => l.service === "keyword-gaps")).toBe(true);
    expect(res.totalSpent).toBe(25);
  });

  test("Stage 0: confirm runs BEFORE any charge and includes the full estimate", async () => {
    // Metadata is folded (0cr) in v10, so a paid keyword-gaps (25) drives the
    // estimate over threshold 10. The confirm MUST fire before Stage-0 runs;
    // declining leaves nothing charged and no metadata resolved (the call never
    // happens — even though metadata itself is free, it runs only after confirm).
    let promptedWith = -1;
    const client = okClient({
      siteMetadata: async () => {
        throw new Error("siteMetadata must not be called when the user declines");
      },
    });
    const res = await prefetchCloudData(
      input({
        client,
        rules: [
          {
            id: "ai/site-metadata",
            cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" },
          },
          {
            id: "seo/keyword-gaps",
            cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
          },
        ],
        metadataPages: METADATA_PAGES,
        sitePayloads: { "keyword-gaps": { domain: "example.com" } },
        config: { ...config, confirm_threshold: 10 },
        confirm: async (estimate) => {
          promptedWith = estimate;
          return false;
        },
      }),
    );
    expect(promptedWith).toBe(25); // metadata (folded, 0) + keyword-gaps (25)
    expect(res.totalSpent).toBe(0);
    expect(res.siteMetadata).toBeNull();
    expect(res.store.get("site-metadata")?.get(CLOUD_SITE_KEY)?.skipReason).toBe("not-prefetched");
  });

  test("Stage 0: confirm accepted → services resolve and charge", async () => {
    let prompted = false;
    // keyword-gaps (25) crosses threshold 10 → prompt; accepting runs everything
    // (folded metadata included).
    const res = await prefetchCloudData(
      input({
        rules: [
          {
            id: "ai/site-metadata",
            cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" },
          },
          {
            id: "seo/keyword-gaps",
            cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
          },
        ],
        metadataPages: METADATA_PAGES,
        sitePayloads: { "keyword-gaps": { domain: "example.com" } },
        config: { ...config, confirm_threshold: 10 },
        confirm: async () => {
          prompted = true;
          return true;
        },
      }),
    );
    expect(prompted).toBe(true);
    expect(res.siteMetadata).toEqual(METADATA_RESPONSE);
    // metadata folded (0) + keyword-gaps (25) = 25.
    expect(res.totalSpent).toBe(25);
  });

  test("Stage 1: gate removes a non-applicable service BEFORE the cap and frees its budget", async () => {
    let keywordGapsCalled = false;
    const client = okClient({
      keywordGaps: async () => {
        keywordGapsCalled = true;
        return { gaps: [], summary: "" };
      },
    });
    // Gate kills keyword-gaps; ai-parse still runs.
    const gate = (_meta: SiteMetadata, service: CloudServiceId) => service !== "keyword-gaps";
    const res = await prefetchCloudData(
      input({
        client,
        rules: META_RULES,
        metadataPages: METADATA_PAGES,
        sitePayloads: META_SITE_PAYLOADS,
        gate,
      }),
    );
    // keyword-gaps never dispatched and reads not-applicable.
    expect(keywordGapsCalled).toBe(false);
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)?.skipReason).toBe("not-applicable");
    // Nothing charged: metadata (folded 0) + ai-parse (folded 0) = 0; the gated
    // keyword-gaps (the only priced service) was removed before it could run.
    expect(res.totalSpent).toBe(0);
    expect(res.spend.some((l) => l.service === "keyword-gaps")).toBe(false);
    // ai-parse still ran (gating removed keyword-gaps, not ai-parse).
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.status).toBe("ok");
  });

  test("gated budget frees up: a service the cap would have excluded now fits", async () => {
    // Cap = 25 fits exactly ONE paid gaps service. Ungated, content-gaps
    // (service-id-sorted first) would take the whole cap and keyword-gaps would
    // be credit-cap-reached. Gate content-gaps OUT → its 25cr budget frees up and
    // keyword-gaps now fits and runs. Folded metadata/ai-parse cost nothing.
    const gate = (_meta: SiteMetadata, service: CloudServiceId) => service !== "content-gaps";
    const res = await prefetchCloudData(
      input({
        rules: [
          {
            id: "ai/site-metadata",
            cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" },
          },
          {
            id: "seo/content-gaps",
            cloud: { service: "content-gaps", unit: "site", creditFeature: "content_gaps" },
          },
          {
            id: "seo/keyword-gaps",
            cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
          },
        ],
        metadataPages: METADATA_PAGES,
        sitePayloads: {
          "keyword-gaps": { domain: "example.com" },
          "content-gaps": { domain: "example.com" },
        },
        gate,
        config: { ...config, max_credits_per_audit: 25 },
      }),
    );
    // content-gaps is not-applicable (gated), NOT credit-cap-reached.
    expect(res.store.get("content-gaps")?.get(CLOUD_SITE_KEY)?.skipReason).toBe("not-applicable");
    // Freed budget: keyword-gaps (25) now fits under the 25 cap and runs.
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)?.status).toBe("ok");
    expect(res.totalSpent).toBe(25);
  });

  test("metadata error → siteMetadata null, NO gating happens (degrades to today)", async () => {
    let keywordGapsCalled = false;
    const client = okClient({
      siteMetadata: async () => {
        throw new CloudClientError("service_unavailable", 502, "down");
      },
      keywordGaps: async () => {
        keywordGapsCalled = true;
        return { gaps: [], summary: "" };
      },
    });
    // Gate would skip keyword-gaps, but with no metadata it must NOT be consulted.
    const gate = (_meta: SiteMetadata, service: CloudServiceId) => service !== "keyword-gaps";
    const res = await prefetchCloudData(
      input({
        client,
        rules: META_RULES,
        metadataPages: METADATA_PAGES,
        sitePayloads: META_SITE_PAYLOADS,
        gate,
      }),
    );
    expect(res.siteMetadata).toBeNull();
    expect(res.store.get("site-metadata")?.get(CLOUD_SITE_KEY)?.skipReason).toBe(
      "service-unavailable",
    );
    // No gating: keyword-gaps still ran (it is NOT not-applicable).
    expect(keywordGapsCalled).toBe(true);
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)?.status).toBe("ok");
    // Only keyword-gaps charged (25); ai-parse is folded (0) and metadata failed.
    expect(res.totalSpent).toBe(25);
    expect(res.failures.some((f) => f.service === "site-metadata")).toBe(true);
  });

  test("folded Stage-0 metadata runs under any cap; the cap bites the paid downstream", async () => {
    // Pre-v10 a cap below the 12cr metadata cost made Stage-0 cap-reached and
    // skipped gating. Metadata is folded (0cr) now: it runs under ANY cap and
    // never eats it. Cap 5 then cap-reaches the paid keyword-gaps (25) while the
    // folded ai-parse still fits. (No gate — the cap alone truncates.)
    let keywordGapsCalled = false;
    const client = okClient({
      keywordGaps: async () => {
        keywordGapsCalled = true;
        return { gaps: [], summary: "" };
      },
    });
    const res = await prefetchCloudData(
      input({
        client,
        rules: META_RULES,
        metadataPages: METADATA_PAGES,
        sitePayloads: META_SITE_PAYLOADS,
        config: { ...config, max_credits_per_audit: 5 },
      }),
    );
    // Metadata resolved (folded, uncharged) even under the 5cr cap.
    expect(res.siteMetadata).toEqual(METADATA_RESPONSE);
    expect(res.store.get("site-metadata")?.get(CLOUD_SITE_KEY)?.status).toBe("ok");
    // The paid keyword-gaps (25) exceeds the 5cr cap → credit-cap-reached, never called.
    expect(res.store.get("keyword-gaps")?.get(CLOUD_SITE_KEY)?.skipReason).toBe(
      "credit-cap-reached",
    );
    expect(keywordGapsCalled).toBe(false);
    // Folded ai-parse (a page service) still DISPATCHES under any cap, at 0 credits.
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.status).toBe("ok");
    expect(res.store.get("ai-parse")?.get(pages[0].url)?.creditsSpent).toBe(0);
    expect(res.totalSpent).toBe(0);
  });

  test("absent metadata payload → skips not-prefetched, no charge, no gating", async () => {
    let keywordGapsCalled = false;
    const client = okClient({
      keywordGaps: async () => {
        keywordGapsCalled = true;
        return { gaps: [], summary: "" };
      },
    });
    const gate = (_meta: SiteMetadata, service: CloudServiceId) => service !== "keyword-gaps";
    const res = await prefetchCloudData(
      input({
        client,
        rules: META_RULES,
        // metadataPages omitted → nothing to extract from.
        sitePayloads: META_SITE_PAYLOADS,
        gate,
      }),
    );
    expect(res.siteMetadata).toBeNull();
    expect(res.store.get("site-metadata")?.get(CLOUD_SITE_KEY)?.skipReason).toBe("not-prefetched");
    // No gating → keyword-gaps ran.
    expect(keywordGapsCalled).toBe(true);
    // keyword-gaps 25; ai-parse folded (0); metadata uncharged. Total 25.
    expect(res.totalSpent).toBe(25);
  });

  test("oversized pages split into byte-budgeted batches during prefetch", async () => {
    // ~1MB of text per page → a 5-page batch would exceed the 4MB budget.
    const bigPages: CloudPagePayload[] = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/big${i}`,
      textExcerpt: "x".repeat(1024 * 1024),
    }));
    const sizes: number[] = [];
    const client = okClient({
      aiParse: async (req) => {
        sizes.push(req.pages.length);
        return {
          results: req.pages.map((p) => ({
            url: p.url,
            pageType: "other" as const,
            parsabilityScore: 0,
            confidence: 0,
          })),
        };
      },
    });
    const res = await prefetchCloudData(
      input({
        rules: [RULES[0]],
        client,
        pages: bigPages,
        config: { ...config, max_credits_per_audit: 0 },
      }),
    );
    // 4MB budget fits 3 × ~1MB pages per batch.
    expect(sizes).toEqual([3, 2]);
    expect(res.failures).toEqual([]);
  });
});

describe("chunkPagesBySize", () => {
  const page = (url: string, bytes: number): CloudPagePayload => ({
    url,
    textExcerpt: "x".repeat(bytes),
  });

  test("respects the page-count cap when bytes are small", () => {
    const pages = Array.from({ length: 5 }, (_, i) => page(`u${i}`, 10));
    expect(chunkPagesBySize(pages, 2).map((b) => b.length)).toEqual([2, 2, 1]);
  });

  test("splits when the byte budget would be exceeded", () => {
    const pages = Array.from({ length: 4 }, (_, i) => page(`u${i}`, 100));
    // Each page serializes to a bit over 100 bytes; budget of 250 fits 2.
    expect(chunkPagesBySize(pages, 20, 350).map((b) => b.length)).toEqual([2, 2]);
  });

  test("a single page over the budget ships alone", () => {
    const pages = [page("small1", 10), page("huge", 5000), page("small2", 10)];
    const batches = chunkPagesBySize(pages, 20, 1000);
    expect(batches.map((b) => b.map((p) => p.url))).toEqual([["small1"], ["huge"], ["small2"]]);
  });

  test("default budget stays under the API body limit", () => {
    expect(BATCH_BYTE_BUDGET).toBeLessThan(5 * 1024 * 1024);
    // 20 pages of ~512KB each (~10MB total) must split.
    const pages = Array.from({ length: 20 }, (_, i) => page(`u${i}`, 512 * 1024));
    const batches = chunkPagesBySize(pages, 20);
    expect(batches.length).toBeGreaterThan(1);
    const encoder = new TextEncoder();
    for (const batch of batches) {
      expect(encoder.encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(BATCH_BYTE_BUDGET);
    }
  });

  test("preserves order and loses no pages", () => {
    const pages = Array.from({ length: 7 }, (_, i) => page(`u${i}`, 50));
    const batches = chunkPagesBySize(pages, 3, 10_000);
    expect(batches.flat().map((p) => p.url)).toEqual(pages.map((p) => p.url));
  });
});

// ── render service (#673): job-based (submit → poll), gated off on rendered crawls ──
const RENDER_RULES: CloudPrefetchInput["rules"] = [
  { id: "ax/content-without-js", cloud: { service: "render", unit: "page", creditFeature: "render" } },
];

/** okClient + a render job that resolves `done` immediately, returning HTML for the requested urls. */
function renderClient(overrides: Partial<CloudServicesClient> = {}): CloudServicesClient {
  let submitted: string[] = [];
  return okClient({
    render: async (req) => {
      submitted = req.urls;
      return { jobId: "job-1", status: "queued" };
    },
    renderResult: async () => ({
      jobId: "job-1",
      status: "done",
      results: submitted.map((url) => ({ url, status: 200, html: `<html><body>${url}</body></html>` })),
    }),
    ...overrides,
  });
}

describe("prefetchCloudData — render service (#673)", () => {
  test("wired path: submits + polls, stamps an ok render envelope per page", async () => {
    let renderCalls = 0;
    const client = renderClient({
      render: async (req) => {
        renderCalls++;
        return { jobId: "j", status: "queued", results: undefined } as never;
      },
      renderResult: async () => ({
        jobId: "j",
        status: "done",
        results: pages.map((p) => ({ url: p.url, status: 200, html: `<html>${p.url}</html>` })),
      }),
    });
    const res = await prefetchCloudData(input({ client, rules: RENDER_RULES }));
    const render = res.store.get("render");
    expect(render?.size).toBe(5);
    for (const p of pages) {
      const env = render?.get(p.url);
      expect(env?.status).toBe("ok");
      expect((env?.data as { html?: string })?.html).toContain(p.url);
    }
    expect(renderCalls).toBe(1); // one submit for the single batch (5 pages < batch_size 20)
    expect(res.failures).toEqual([]);
  });

  test("crawlRendered: render is skipped not-applicable and never submitted (no self-identical re-render)", async () => {
    let submitted = false;
    const client = renderClient({
      render: async (req) => {
        submitted = true;
        return { jobId: "j", status: "queued" };
      },
    });
    const res = await prefetchCloudData(input({ client, rules: RENDER_RULES, crawlRendered: true }));
    expect(submitted).toBe(false);
    const render = res.store.get("render");
    expect(render?.get(pages[0].url)?.status).toBe("skipped");
    expect(render?.get(pages[0].url)?.skipReason).toBe("not-applicable");
    expect(res.spend).toEqual([]);
  });

  test("partial render result: a page omitted from results is skipped service-unavailable, not lost", async () => {
    const client = renderClient({
      renderResult: async () => ({
        jobId: "j",
        status: "done",
        // Only the first 3 of 5 pages came back.
        results: pages.slice(0, 3).map((p) => ({ url: p.url, status: 200, html: `<html>${p.url}</html>` })),
      }),
    });
    const res = await prefetchCloudData(input({ client, rules: RENDER_RULES }));
    const render = res.store.get("render");
    expect(render?.size).toBe(5);
    expect(render?.get(pages[0].url)?.status).toBe("ok");
    expect(render?.get(pages[4].url)?.status).toBe("skipped");
    expect(render?.get(pages[4].url)?.skipReason).toBe("service-unavailable");
  });

  test("render submit failure: pages skip + a failure is recorded (uncharged)", async () => {
    const client = renderClient({
      render: async () => {
        throw new CloudClientError("service_unavailable", 503, "boom");
      },
    });
    const res = await prefetchCloudData(input({ client, rules: RENDER_RULES }));
    const render = res.store.get("render");
    expect(render?.get(pages[0].url)?.status).toBe("skipped");
    expect(res.failures.some((f) => f.service === "render")).toBe(true);
    expect(res.totalSpent).toBe(0);
  });

  test("caps render batches at SERVICE_LIMITS.renderBatchUrls (server per-job limit < batch_size)", async () => {
    // batch_size defaults to 20, but the render endpoint's per-job cap is 10 — submitting 20 would be
    // rejected server-side. 15 pages must therefore split into 2 jobs of ≤10 urls each.
    const manyPages: CloudPagePayload[] = Array.from({ length: 15 }, (_, i) => ({
      url: `https://example.com/r${i}`,
      textExcerpt: `p${i}`,
    }));
    const submits: number[] = [];
    const client = renderClient({
      render: async (req) => {
        submits.push(req.urls.length);
        return { jobId: `j${submits.length}`, status: "queued" };
      },
      renderResult: async (jobId) => ({
        jobId,
        status: "done",
        results: manyPages.map((p) => ({ url: p.url, status: 200, html: `<html>${p.url}</html>` })),
      }),
    });
    const res = await prefetchCloudData(input({ client, rules: RENDER_RULES, pages: manyPages }));
    expect(submits.length).toBe(2); // 15 urls / 10 cap → 2 jobs
    for (const n of submits) expect(n).toBeLessThanOrEqual(10);
    expect(res.store.get("render")?.size).toBe(15);
  });

  test("auto crawl: renders only crawl-raw pages; already-rendered pages skip not-applicable (no re-render charge, #964)", async () => {
    // The hybrid crawl already rendered pages[0] and pages[2] — those are self-identical, so the render
    // service must NOT re-submit them (charge-on-submit waste the rule would discard). Only the 3 raw pages go.
    const renderedPageUrls = new Set([pages[0].url, pages[2].url]);
    const submitted: string[] = [];
    const client = renderClient({
      render: async (req) => {
        submitted.push(...req.urls);
        return { jobId: "j", status: "queued" };
      },
      renderResult: async () => ({
        jobId: "j",
        status: "done",
        results: pages.map((p) => ({ url: p.url, status: 200, html: `<html>${p.url}</html>` })),
      }),
    });
    const res = await prefetchCloudData(input({ client, rules: RENDER_RULES, renderedPageUrls }));
    expect(submitted.sort()).toEqual([pages[1].url, pages[3].url, pages[4].url].sort());
    const render = res.store.get("render");
    expect(render?.size).toBe(5); // 2 skipped-not-applicable + 3 rendered ok
    expect(render?.get(pages[0].url)?.status).toBe("skipped");
    expect(render?.get(pages[0].url)?.skipReason).toBe("not-applicable");
    expect(render?.get(pages[2].url)?.skipReason).toBe("not-applicable");
    expect(render?.get(pages[1].url)?.status).toBe("ok");
    expect(render?.get(pages[4].url)?.status).toBe("ok");
  });

  test("bot-walled render result (403/challenge) is dropped → that page skips service-unavailable", async () => {
    const client = renderClient({
      renderResult: async () => ({
        jobId: "j",
        status: "done",
        results: [
          { url: pages[0].url, status: 200, html: `<html>${pages[0].url}</html>` },
          { url: pages[1].url, status: 403, html: "<html>Access denied</html>" }, // bot wall
          ...pages.slice(2).map((p) => ({ url: p.url, status: 200, html: `<html>${p.url}</html>` })),
        ],
      }),
    });
    const res = await prefetchCloudData(input({ client, rules: RENDER_RULES }));
    const render = res.store.get("render");
    expect(render?.get(pages[0].url)?.status).toBe("ok");
    expect(render?.get(pages[1].url)?.status).toBe("skipped"); // 403 → isRenderBlocked → not fed to the rule
    expect(render?.get(pages[1].url)?.skipReason).toBe("service-unavailable");
  });
});
