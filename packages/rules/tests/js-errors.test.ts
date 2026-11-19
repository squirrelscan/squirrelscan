// reliability/js-errors - JavaScript errors and failed runtime requests on rendered pages (#704).
// Render results are hand-built: the cloud renderer does not record runtime data yet (tracked privately).

import { describe, expect, test } from "bun:test";

import { RUNTIME_NOT_RECORDED_SKIP_REASON } from "@squirrelscan/core-contracts";
import { UNREAD_PAGE_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import { classifyRuleOutcome } from "@squirrelscan/core-contracts/rule-outcome";
import type {
  CheckResult,
  RenderResultItem,
  RenderRuntimeDiagnostics,
} from "@squirrelscan/core-contracts";

import type { CloudResultEnvelope, CloudResultStore } from "../src/cloud";
import { loadAllRules } from "../src/loader";
import { jsErrorsRule } from "../src/reliability/js-errors";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const SITE = "https://example.com";

function render(
  runtime: RenderRuntimeDiagnostics | undefined,
  extra: Partial<RenderResultItem> = {}
): CloudResultEnvelope<RenderResultItem> {
  return {
    status: "ok",
    data: {
      url: "",
      status: 200,
      html: "<html></html>",
      ...(runtime ? { runtime } : {}),
      ...extra,
    },
  };
}

function ctxOf(
  pages: Record<string, CloudResultEnvelope<RenderResultItem>> | undefined
): RuleContext {
  const site: SiteData = {
    baseUrl: SITE,
    pages: [],
    robotsTxt: null,
    sitemaps: null,
  };
  const store: CloudResultStore | undefined = pages
    ? new Map([
        [
          "render",
          new Map(Object.entries(pages)) as Map<string, CloudResultEnvelope>,
        ],
      ])
    : undefined;
  return {
    page: {
      url: `${SITE}/`,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as ParsedPage,
    site,
    options: {},
    ...(store ? { cloudResults: store } : {}),
  };
}

async function run(
  pages: Record<string, CloudResultEnvelope<RenderResultItem>> | undefined
) {
  return (await jsErrorsRule.run(ctxOf(pages))).checks as CheckResult[];
}

const named = (checks: CheckResult[], name: string) =>
  checks.find((c) => c.name === name);

describe("reliability/js-errors", () => {
  test("an inline TypeError on load is an error with message and source location", async () => {
    const checks = await run({
      [`${SITE}/`]: render({
        pageErrors: [
          {
            message:
              "TypeError: Cannot read properties of undefined (reading 'x')",
            sourceUrl: `${SITE}/assets/app.js`,
            line: 14,
          },
        ],
      }),
    });
    const c = named(checks, "js-errors");
    expect(c?.status).toBe("fail");
    expect(c?.items?.[0]?.label).toContain(
      "TypeError: Cannot read properties of undefined"
    );
    expect(c?.items?.[0]?.label).toContain("/assets/app.js:14");
  });

  test("an inline script with no source URL is first-party", async () => {
    const checks = await run({
      [`${SITE}/`]: render({
        pageErrors: [{ message: "TypeError: boom", line: 3 }],
      }),
    });
    expect(named(checks, "js-errors")?.status).toBe("fail");
  });

  test("the same exception on 5 pages is one grouped finding with a page count of 5", async () => {
    const pages: Record<string, CloudResultEnvelope<RenderResultItem>> = {};
    for (let i = 1; i <= 5; i++) {
      pages[`${SITE}/p${i}`] = render({
        pageErrors: [
          {
            message: `TypeError: x is not a function (id ${i})`,
            sourceUrl: `${SITE}/assets/app.js?v=${i}`,
            line: 9,
          },
        ],
      });
    }
    const c = named(await run(pages), "js-errors");
    expect(c?.items).toHaveLength(1);
    expect(c?.items?.[0]?.pageCount).toBe(5);
    expect(c?.items?.[0]?.sourcePages).toHaveLength(5);
    expect(c?.items?.[0]?.label).toContain("5 pages");
  });

  test("a React hydration mismatch is identified as a hydration error", async () => {
    for (const message of [
      "Hydration failed because the initial UI does not match what was rendered on the server.",
      "Minified React error #418; visit https://react.dev/errors/418 for the full message",
      "Minified React error #423",
      "[Vue warn]: Hydration node mismatch",
    ]) {
      const checks = await run({
        [`${SITE}/`]: render({
          pageErrors: [{ message, sourceUrl: `${SITE}/assets/app.js` }],
        }),
      });
      expect(named(checks, "hydration-errors")?.status).toBe("warn");
      expect(named(checks, "js-errors")).toBeUndefined();
    }
  });

  test("a first-party fetch answering 500 is reported; 401 is not", async () => {
    const checks = await run({
      [`${SITE}/`]: render({
        failedRequests: [
          { url: `${SITE}/api/data`, resourceType: "fetch", status: 500 },
          { url: `${SITE}/api/me`, resourceType: "fetch", status: 401 },
        ],
      }),
    });
    const c = named(checks, "failed-runtime-requests");
    expect(c?.status).toBe("warn");
    expect(c?.items).toHaveLength(1);
    expect(c?.items?.[0]?.label).toContain("/api/data");
    expect(JSON.stringify(checks)).not.toContain("/api/me");
  });

  test("a first-party 404 warns, a third-party failure warns", async () => {
    const checks = await run({
      [`${SITE}/`]: render({
        failedRequests: [
          { url: `${SITE}/api/gone`, resourceType: "fetch", status: 404 },
          {
            url: "https://cdn.other.net/w.js",
            resourceType: "script",
            status: 502,
          },
        ],
      }),
    });
    expect(named(checks, "failed-runtime-requests")?.items).toHaveLength(1);
    expect(named(checks, "third-party-js-errors")?.status).toBe("warn");
  });

  test("an exception thrown 2s after load is reported when the renderer recorded it", async () => {
    const checks = await run({
      [`${SITE}/`]: render({
        pageErrors: [
          { message: "Error: late timer", sourceUrl: `${SITE}/late.js` },
        ],
      }),
    });
    expect(named(checks, "js-errors")?.status).toBe("fail");
  });

  test("third-party exceptions and first-party console.error are warnings", async () => {
    const checks = await run({
      [`${SITE}/`]: render({
        pageErrors: [
          { message: "TypeError: t", sourceUrl: "https://tags.vendor.io/t.js" },
        ],
        consoleErrors: [
          { message: "Something went wrong", sourceUrl: `${SITE}/app.js` },
        ],
      }),
    });
    expect(named(checks, "third-party-js-errors")?.status).toBe("warn");
    expect(named(checks, "console-errors")?.status).toBe("warn");
    expect(named(checks, "js-errors")).toBeUndefined();
  });

  test("renderer-blocked requests, aborts, ResizeObserver and CSP violations produce no finding", async () => {
    const checks = await run({
      [`${SITE}/`]: render({
        pageErrors: [
          {
            message:
              "ResizeObserver loop completed with undelivered notifications.",
          },
        ],
        consoleErrors: [
          { message: "ResizeObserver loop limit exceeded" },
          {
            message:
              "Refused to load the script 'https://x.com/a.js' because it violates the following Content Security Policy directive: \"script-src 'self'\"",
          },
          {
            message:
              "Failed to load resource: the server responded with a status of 500 ()",
          },
        ],
        failedRequests: [
          { url: `${SITE}/api/x`, status: 500, blockedByRenderer: true },
          {
            url: `${SITE}/beacon`,
            resourceType: "ping",
            error: "net::ERR_ABORTED",
          },
        ],
      }),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("a page detected as a WAF challenge is left out, and is no gap: the other pages still pass", async () => {
    const checks = await run({
      [`${SITE}/a`]: render(
        { pageErrors: [{ message: "TypeError: c" }] },
        { status: 403 }
      ),
      [`${SITE}/b`]: render({}),
    });
    expect(named(checks, "js-errors")?.status).toBe("pass");
    const note = named(checks, "unchecked-pages");
    expect(note?.status).toBe("info");
    expect(note?.skipReason).toBeUndefined();
  });

  test("no runtime data from the renderer is a coded gap, never a pass", async () => {
    const checks = await run({ [`${SITE}/`]: render(undefined) });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBe(RUNTIME_NOT_RECORDED_SKIP_REASON);
  });

  test("a run where every rendered page was a WAF or bot challenge is a coded gap (unread-page), not a does-not-apply skip", async () => {
    const checks = await run({
      [`${SITE}/a`]: render({ pageErrors: [{ message: "TypeError: c" }] }, { status: 403 }),
      [`${SITE}/b`]: render({}, { headers: { "cf-mitigated": "challenge" } }),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBe(UNREAD_PAGE_SKIP_REASON);
    expect(classifyRuleOutcome(checks[0]!)).toBe("coverage_gap");
  });

  // #704: a pass covers the whole site, so a stored finding would resolve on it. With any page the rule had to
  // judge lacking runtime data, the error may be on that page: a coded gap, not a pass plus an info.
  test("a partial run (some pages without runtime data) is a coded gap, not a pass", async () => {
    const checks = await run({
      [`${SITE}/a`]: render({}),
      [`${SITE}/b`]: render(undefined),
    });
    expect(checks.find((c) => c.status === "pass")).toBeUndefined();
    const gap = named(checks, "unchecked-pages");
    expect(gap?.status).toBe("skipped");
    expect(gap?.skipReason).toBe(RUNTIME_NOT_RECORDED_SKIP_REASON);
    expect(gap?.details).toMatchObject({ unmeasured: 1, unrendered: 0 });
  });

  test("a page with no render result beside measured pages is a coded gap too", async () => {
    const checks = await run({
      [`${SITE}/a`]: render({}),
      [`${SITE}/b`]: { status: "skipped", skipReason: "render-failed" },
    });
    expect(checks.find((c) => c.status === "pass")).toBeUndefined();
    const gap = named(checks, "unchecked-pages");
    expect(gap?.skipReason).toBe(RUNTIME_NOT_RECORDED_SKIP_REASON);
    expect(gap?.details).toMatchObject({ unmeasured: 0, unrendered: 1 });
  });

  test("a partial run still reports the errors it saw, beside the gap", async () => {
    const checks = await run({
      [`${SITE}/a`]: render({
        pageErrors: [{ message: "TypeError: x is undefined", sourceUrl: `${SITE}/app.js`, line: 3 }],
      }),
      [`${SITE}/b`]: render(undefined),
      [`${SITE}/c`]: render({}, { status: 403 }),
    });
    expect(named(checks, "js-errors")?.status).toBe("fail");
    const gap = named(checks, "unchecked-pages");
    expect(gap?.status).toBe("skipped");
    expect(gap?.skipReason).toBe(RUNTIME_NOT_RECORDED_SKIP_REASON);
    expect(gap?.message).toBe(
      "Partial check: 1 page(s) had no runtime data from the renderer; 1 page(s) were a WAF or bot challenge and were left out"
    );
  });

  test("no render results (local or --http audit) is skipped with a reason", async () => {
    const checks = await run(undefined);
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBeTruthy();
  });
});

describe("reliability/js-errors wiring", () => {
  test("loaded by the loader and declared cloud", () => {
    const rule = loadAllRules().get("reliability/js-errors");
    expect(rule).toBeDefined();
    expect(rule?.meta.cloud).toEqual({
      service: "render",
      unit: "page",
      creditFeature: "audit_page",
    });
  });
});
