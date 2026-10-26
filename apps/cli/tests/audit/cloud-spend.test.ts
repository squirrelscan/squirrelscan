// Dead-links bulk checker spend accounting: every SUCCESSFUL bulk call must
// report (units, credits) via onSpend; failed calls (server refunds on total
// provider failure) must report nothing.

import type { PageRecord } from "@squirrelscan/core-contracts/storage";

import { createCloudClient } from "@squirrelscan/cloud-client";
import { computeCost } from "@squirrelscan/core-contracts";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { AuditReport } from "../../src/types";

import { buildSiteContext } from "../../src/audit/adapter";
import {
  resolveDeadLinksBulkChecker,
  runCloudEditorSummary,
} from "../../src/audit/cloud";
import { getDefaultConfig } from "../../src/config";

function pageRecord(html: string): PageRecord {
  return {
    url: "https://example.com/",
    normalizedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "hash",
    html,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  };
}

const HTML = `<html><body>
  <a href="https://external-one.com/a">one</a>
  <a href="https://external-two.com/b">two</a>
  <a href="/internal">internal</a>
</body></html>`;

function deadLinksClient(opts: {
  fail?: boolean;
  calls: string[][];
  runIds?: Array<string | undefined>;
  charged?: number;
}) {
  return {
    deadLinks: async (req: { urls: string[]; runId?: string }) => {
      opts.calls.push(req.urls);
      opts.runIds?.push(req.runId);
      if (opts.fail) throw new Error("service_unavailable");
      return {
        results: req.urls.map((url) => ({
          url,
          status: 200,
          error: null,
          redirectUrl: null,
          fromCache: false,
        })),
        ...(opts.charged !== undefined ? { charged: opts.charged } : {}),
      };
    },
  } as never;
}

async function makeChecker(opts: {
  fail?: boolean;
  calls: string[][];
  onSpend: (units: number, credits: number) => void;
  runIds?: Array<string | undefined>;
  charged?: number;
  runId?: string | null;
}) {
  const config = getDefaultConfig();
  config.cloud.enabled = true;
  const siteContext = await Effect.runPromise(
    buildSiteContext([pageRecord(HTML)])
  );
  return resolveDeadLinksBulkChecker({
    client: deadLinksClient(opts),
    config,
    auditId: "audit-1",
    siteContext,
    onSpend: opts.onSpend,
    getRunId: async () => (opts.runId === undefined ? "run-1" : opts.runId),
  });
}

describe("dead-links bulk checker spend accounting", () => {
  test("successful bulk call reports units + server-debited credits", async () => {
    const calls: string[][] = [];
    const spend: Array<[number, number]> = [];
    const checker = await makeChecker({
      calls,
      onSpend: (units, credits) => spend.push([units, credits]),
    });
    expect(checker).not.toBeNull();

    const urls = ["https://external-one.com/a", "https://external-two.com/b"];
    const results = await checker!(urls);
    expect(results.size).toBe(2);
    // An older server sends no `charged`: nothing is counted.
    expect(spend).toEqual([[2, 0]]);
  });

  test("#801: each call carries the run, and the server's charge is what is counted", async () => {
    const calls: string[][] = [];
    const runIds: Array<string | undefined> = [];
    const spend: Array<[number, number]> = [];
    const checker = await makeChecker({
      calls,
      runIds,
      charged: 2,
      onSpend: (units, credits) => spend.push([units, credits]),
    });
    await checker!([
      "https://external-one.com/a",
      "https://external-two.com/b",
    ]);
    expect(runIds).toEqual(["run-1"]);
    expect(spend).toEqual([[2, 2]]);
  });

  test("#801: units are the links the cloud answered; the rest are checked here, free", async () => {
    const spend: Array<[number, number]> = [];
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    const siteContext = await Effect.runPromise(
      buildSiteContext([pageRecord(HTML)])
    );
    const checker = await resolveDeadLinksBulkChecker({
      client: {
        // Answers only the first url, as the server does past its deadline.
        deadLinks: async (req: { urls: string[] }) => ({
          results: req.urls.slice(0, 1).map((url) => ({
            url,
            status: 200,
            error: null,
            redirectUrl: null,
            fromCache: false,
          })),
          charged: 1,
        }),
      } as never,
      config,
      auditId: "audit-1",
      siteContext,
      getRunId: () => "run-1",
      onSpend: (units, credits) => spend.push([units, credits]),
    });
    await checker!([
      "https://external-one.com/a",
      "https://external-two.com/b",
    ]);
    expect(spend).toEqual([[1, 1]]);
  });

  test("#801: no registered run (an API key, a failed register) means no cloud checks", async () => {
    const calls: string[][] = [];
    const checker = await makeChecker({
      calls,
      runId: null,
      onSpend: () => {},
    });
    expect(checker).toBeNull();
    expect(calls).toEqual([]);
  });

  test("#801: the spend confirm prices 1 credit per link, at most 1 per page of the cap", async () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    config.cloud.confirm_threshold = 0;
    const siteContext = await Effect.runPromise(
      buildSiteContext([pageRecord(HTML)])
    );
    const asked: number[] = [];
    const resolve = (maxPages?: number) =>
      resolveDeadLinksBulkChecker({
        client: deadLinksClient({ calls: [] }),
        config,
        auditId: "audit-1",
        siteContext,
        getRunId: () => "run-1",
        ...(maxPages !== undefined ? { maxPages } : {}),
        getBalance: async () => 1000,
        confirm: async (estimate) => {
          asked.push(estimate);
          return true;
        },
      });
    await resolve(10);
    await resolve(1);
    // Two external links on the page; one page of cap bills one.
    expect(asked).toEqual([2, 1]);
  });

  test("each successful call is accounted separately (per-call ceil)", async () => {
    const calls: string[][] = [];
    let units = 0;
    let credits = 0;
    const checker = await makeChecker({
      calls,
      onSpend: (u, c) => {
        units += u;
        credits += c;
      },
    });

    await checker!(["https://external-one.com/a"]);
    await checker!(["https://external-two.com/b"]);
    // Two calls of 1 url each: 2 units; this server sends no `charged`.
    expect(units).toBe(2);
    expect(credits).toBe(0);
  });

  test("failed bulk call reports no spend", async () => {
    const calls: string[][] = [];
    let reported = false;
    const checker = await makeChecker({
      fail: true,
      calls,
      onSpend: () => {
        reported = true;
      },
    });

    await expect(checker!(["https://external-one.com/a"])).rejects.toThrow();
    expect(reported).toBe(false);
  });
});

// Editor-summary spend accounting: a server-side digest-cache hit (#1012,
// res.cached === true) is served free — it must not be billed via onSpend nor
// reported in the result's credits, mirroring the domain-stats 30-day cache.

function makeSummaryReport(): AuditReport {
  return {
    baseUrl: "https://example.com",
    totalPages: 3,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    healthScore: {
      overall: 100,
      categories: [],
      errorCount: 0,
      warningCount: 0,
      passedCount: 1,
    },
  } as unknown as AuditReport;
}

function editorSummaryClient(opts: { cached?: boolean }) {
  return {
    editorSummary: async () => ({
      prose: "All good.",
      bigTicket: [],
      verdict: "ship it",
      model: "test-model",
      generatedAt: "2026-07-17T00:00:00.000Z",
      ...(opts.cached ? { cached: true } : {}),
    }),
  } as never;
}

describe("editor-summary spend accounting", () => {
  test("fresh result reports the flat estimate as spend", async () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    const spend: number[] = [];
    const result = await runCloudEditorSummary({
      client: editorSummaryClient({}),
      config,
      auditId: "audit-1",
      report: makeSummaryReport(),
      onSpend: (credits) => spend.push(credits),
    });
    const estimate = computeCost("editor_summary", 1);
    expect(result?.credits).toBe(estimate);
    // Folded pricing may make the estimate 0 — onSpend only fires when > 0.
    expect(spend).toEqual(estimate > 0 ? [estimate] : []);
  });

  test("digest-cache hit reports no spend and zero credits", async () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    let reported = false;
    const result = await runCloudEditorSummary({
      client: editorSummaryClient({ cached: true }),
      config,
      auditId: "audit-1",
      report: makeSummaryReport(),
      onSpend: () => {
        reported = true;
      },
    });
    expect(result?.credits).toBe(0);
    expect(result?.editorSummary.prose).toBe("All good.");
    expect(reported).toBe(false);
  });
});

/**
 * A 2xx is not proof of a usable body. The cloud client casts its JSON to the
 * response type without validating it, so a partial rollout / proxy JSON
 * envelope / truncated body arrives typed as valid while missing `prose`. That
 * used to sail past the try/catch here and throw far away, in a renderer
 * ("undefined is not an object (evaluating 'es.prose.split')") — after the crawl
 * had already been paid for, discarding the whole audit. It must degrade exactly
 * like a 5xx: no summary, no spend, no throw.
 */
describe("editor-summary malformed 2xx", () => {
  test("a real 200 whose body is missing prose degrades like a 5xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    try {
      const config = getDefaultConfig();
      config.cloud.enabled = true;
      let reported = false;
      const result = await runCloudEditorSummary({
        client: createCloudClient({
          apiUrl: server.url.origin,
          token: "sqcli_x",
          maxAttempts: 1,
        }),
        config,
        auditId: "audit-1",
        report: makeSummaryReport(),
        onSpend: () => {
          reported = true;
        },
      });
      expect(result).toBeNull();
      expect(reported).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a 200 whose prose is the wrong type degrades the same way", async () => {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    let reported = false;
    const result = await runCloudEditorSummary({
      client: {
        editorSummary: async () => ({
          prose: 42,
          bigTicket: null,
          verdict: "",
          model: "",
        }),
      } as never,
      config,
      auditId: "audit-1",
      report: makeSummaryReport(),
      onSpend: () => {
        reported = true;
      },
    });
    expect(result).toBeNull();
    expect(reported).toBe(false);
  });
});

// squirrelscan/repo#2818: a link the service could not verify reaches the rules
// as unverifiable (the WAF-blocked bucket), never as broken.
describe("dead-links results the service could not verify", () => {
  async function checkerAnswering(results: Array<Record<string, unknown>>) {
    const config = getDefaultConfig();
    config.cloud.enabled = true;
    const siteContext = await Effect.runPromise(
      buildSiteContext([pageRecord(HTML)])
    );
    return resolveDeadLinksBulkChecker({
      client: {
        deadLinks: async () => ({ results, charged: 0 }),
      } as never,
      config,
      auditId: "audit-1",
      siteContext,
      onSpend: () => {},
      getRunId: () => "run-1",
    });
  }

  test("a wafBlocked result keeps its flag and a known vendor; any other vendor reads unknown", async () => {
    const base = {
      ok: false,
      status: null,
      error: null,
      redirectUrl: null,
      fromCache: true,
    };
    const checker = await checkerAnswering([
      {
        ...base,
        url: "https://external-one.com/a",
        wafBlocked: true,
        wafProvider: "akamai",
      },
      {
        ...base,
        url: "https://external-two.com/b",
        wafBlocked: true,
        wafProvider: "<script>",
      },
    ]);
    const results = await checker!([
      "https://external-one.com/a",
      "https://external-two.com/b",
    ]);
    expect(results.get("https://external-one.com/a")).toMatchObject({
      status: null,
      error: null,
      wafBlocked: true,
      wafProvider: "akamai",
    });
    expect(results.get("https://external-two.com/b")).toMatchObject({
      wafBlocked: true,
      wafProvider: "unknown",
    });
  });

  test("pub#821: the reason a result is unverifiable is kept when known and dropped otherwise", async () => {
    const base = {
      ok: false,
      status: null,
      error: null,
      redirectUrl: null,
      fromCache: false,
      wafBlocked: true,
      wafProvider: "unknown",
    };
    const checker = await checkerAnswering([
      {
        ...base,
        url: "https://external-one.com/a",
        unverifiedReason: "awaiting-confirmation",
      },
      {
        ...base,
        url: "https://external-two.com/b",
        unverifiedReason: "<script>",
      },
      { ...base, url: "https://external-three.com/c" },
    ]);
    const results = await checker!([
      "https://external-one.com/a",
      "https://external-two.com/b",
      "https://external-three.com/c",
    ]);
    expect(results.get("https://external-one.com/a")?.unverifiedReason).toBe(
      "awaiting-confirmation"
    );
    expect(
      results.get("https://external-two.com/b")?.unverifiedReason
    ).toBeUndefined();
    expect(results.get("https://external-two.com/b")?.wafBlocked).toBe(true);
    expect(
      results.get("https://external-three.com/c")?.unverifiedReason
    ).toBeUndefined();
  });

  test("a result without the flag, from this or an older service, carries none", async () => {
    const checker = await checkerAnswering([
      {
        url: "https://external-one.com/a",
        ok: true,
        status: 200,
        error: null,
        redirectUrl: null,
        fromCache: false,
      },
    ]);
    const result = (await checker!(["https://external-one.com/a"])).get(
      "https://external-one.com/a"
    );
    expect(result?.wafBlocked).toBeUndefined();
    expect(result?.wafProvider).toBeUndefined();
  });
});
