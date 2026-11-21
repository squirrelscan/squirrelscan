// crawl/home-page-unreachable: the entry URL failed to load, per failure class; clean only when
// this audit fetched the home page; otherwise not checked (pub#2035).

import {
  classifyRuleOutcome,
  NOT_CHECKED_SKIP_REASONS,
  type AuditFailureDetail,
} from "@squirrelscan/core-contracts";
import { ENTRY_NOT_FETCHED_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import { homePageUnreachableRule } from "../src/crawl/home-page-unreachable";
import { buildResolutionSignal } from "../src/resolution";

type Page = {
  url: string;
  finalUrl?: string;
  statusCode: number;
  redirectSource?: boolean;
};

const HOME: Page = { url: "https://example.com/", statusCode: 200 };
const OTHER: Page = { url: "https://example.com/about", statusCode: 200 };

const ctxFor = (
  entryFailure?: AuditFailureDetail,
  pages: Page[] = [HOME, OTHER]
): RuleContext =>
  ({
    site: {
      baseUrl: "https://example.com",
      entryUrls: ["https://example.com/"],
      pages,
      robotsTxt: null,
      sitemaps: null,
      entryFailure,
    },
  }) as unknown as RuleContext;

const run = async (failure?: AuditFailureDetail, pages?: Page[]) =>
  (await homePageUnreachableRule.run(ctxFor(failure, pages))).checks;

const RULE = homePageUnreachableRule.meta.id;
const KEY = `${RULE}|home-page-unreachable`;

describe("crawl/home-page-unreachable", () => {
  test.each([
    [{ code: "dns", host: "example.com" }, "DNS"],
    [
      { code: "tls", host: "example.com", detail: "certificate expired" },
      "TLS",
    ],
    [{ code: "connection", host: "example.com" }, "connection"],
    [{ code: "timeout", host: "example.com" }, "in time"],
    [{ code: "http_5xx", host: "example.com", status: 503 }, "503"],
  ] as Array<[AuditFailureDetail, string]>)(
    "reports %o",
    async (failure, text) => {
      const checks = await run(failure, []);
      expect(checks).toHaveLength(1);
      expect(checks[0]!.name).toBe("home-page-unreachable");
      expect(checks[0]!.status).toBe("fail");
      expect(checks[0]!.message).toContain("example.com");
      expect(checks[0]!.message).toContain(text);
      expect(checks[0]!.pageUrl).toBe("https://example.com/");
      expect(checks[0]!.details?.reason).toBe(failure.code);
    }
  );

  test("a home page this audit fetched with a 200 reports one clean pass", async () => {
    const checks = await run(undefined);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.name).toBe("home-page-unreachable");
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.pageUrl).toBe("https://example.com/");
  });

  test("a home page that redirected passes on its redirect target's record", async () => {
    const ctx = ctxFor(undefined, [
      {
        url: "https://example.com/",
        finalUrl: "https://example.com/en/",
        statusCode: 301,
        redirectSource: true,
      },
      { url: "https://example.com/en/", statusCode: 200 },
    ]);
    (ctx.site as { entryUrls: string[] }).entryUrls = [
      "https://example.com/en/",
      "https://example.com/",
    ];
    const checks = (await homePageUnreachableRule.run(ctx)).checks;
    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test.each(["http_4xx", "robots", "redirect"] as const)(
    "%s is an answer, not an outage: no finding",
    async (code) => {
      expect(await run({ code, host: "example.com" }, [])).toEqual([]);
    }
  );

  test("a sitemap-sourced failure is not the home page", async () => {
    expect(
      await run({ code: "dns", host: "example.com", source: "sitemap" }, [])
    ).toEqual([]);
  });

  // A partial re-audit or stored data without crawl stats: no failure recorded, and no home page fetched.
  test.each([
    ["not among the fetched pages", [OTHER]],
    [
      "fetched with an error status",
      [{ url: "https://example.com/", statusCode: 500 }, OTHER],
    ],
    [
      "only a redirect hop, its target not fetched",
      [
        {
          url: "https://example.com/",
          finalUrl: "https://example.com/en/",
          statusCode: 301,
          redirectSource: true,
        },
      ],
    ],
  ] as Array<[string, Page[]]>)(
    "home page %s: not checked, not a pass",
    async (_label, pages) => {
      const checks = await run(undefined, pages);
      expect(checks).toHaveLength(1);
      const check = checks[0]!;
      expect(check.status).toBe("skipped");
      expect(check.skipReason).toBe(ENTRY_NOT_FETCHED_SKIP_REASON);
      expect(check.pageUrl).toBe("https://example.com/");
      // What the report and the merge read: a coverage gap, listed as not checked.
      expect(classifyRuleOutcome(check)).toBe("coverage_gap");
      expect(NOT_CHECKED_SKIP_REASONS.has(check.skipReason!)).toBe(true);
    }
  );

  test("an unknown failure code is not checked: not a finding, not a pass", async () => {
    const checks = await run({ code: "unknown", host: "example.com" }, [HOME]);
    expect(checks.map((c) => [c.status, c.skipReason])).toEqual([
      ["skipped", ENTRY_NOT_FETCHED_SKIP_REASON],
    ]);
    expect(checks[0]!.message).toContain("could not classify");
  });

  // The stored finding stays open: the resolution signal names the home page as not evaluated for the
  // check (the merge carries it), where a pass would leave it absent from both failing and notEvaluated.
  test("a skip keeps a stored finding on the home page open in the resolution signal", async () => {
    const crawled = [HOME.url, OTHER.url];
    const skipped = {
      [RULE]: {
        checks: await run(undefined, [
          { url: HOME.url, statusCode: 500 },
          OTHER,
        ]),
      },
    };
    const signal = buildResolutionSignal(skipped, crawled)!;
    expect(signal.failing[KEY]).toEqual([]);
    expect(signal.notEvaluated?.[KEY]).toHaveLength(2);
    expect(signal.truncated ?? []).not.toContain(KEY);

    const passed = { [RULE]: { checks: await run(undefined) } };
    const clean = buildResolutionSignal(passed, crawled)!;
    expect(clean.failing[KEY]).toEqual([]);
    expect(clean.notEvaluated?.[KEY]).toHaveLength(1); // /about only: the home page was evaluated, so it resolves
  });
});
