// #1396: `executedRules` (the rules that produced at least one non-skipped check) and the rows `--include-pages`
// adds for URLs the crawl requested but stored no page for.

import { describe, expect, test } from "bun:test";

import { JSON_REPORT_PAGES } from "@squirrelscan/core-contracts/limits";

import type { AuditReport } from "../src/types";
import { collectExecutedRules, renderJson, type JsonPageRow } from "../src/output/json";
import { unstoredPageRow } from "../src/unstored-pages";

const check = (status: string, extra: Record<string, unknown> = {}) => ({ name: "c", status, message: "m", ...extra });
const result = (id: string, checks: Array<ReturnType<typeof check>>) => ({
  meta: { id, name: id, description: "d", solution: "s", category: "core", scope: "page", severity: "warning", weight: 5 },
  checks,
});

const ruleResults = {
  "core/passes": result("core/passes", [check("pass", { pageUrl: "https://example.com/" })]),
  "core/warns": result("core/warns", [check("warn", { pageUrl: "https://example.com/" })]),
  "core/info": result("core/info", [check("info")]),
  "core/fully-skipped": result("core/fully-skipped", [check("skipped", { skipReason: "scan-limit" }), check("skipped", { skipReason: "scan-limit" })]),
  "core/mixed": result("core/mixed", [check("skipped", { skipReason: "scan-limit" }), check("pass")]),
  "core/empty": result("core/empty", []),
};

const report = {
  baseUrl: "https://example.com",
  timestamp: "2026-10-30T00:00:00.000Z",
  totalPages: 1,
  passed: 1,
  warnings: 1,
  failed: 0,
  ruleResults,
} as unknown as AuditReport;

const parse = (options?: Parameters<typeof renderJson>[1]) => JSON.parse(renderJson(report, options)) as Record<string, any>;

describe("executedRules", () => {
  test("lists a rule with at least one non-skipped check, sorted, and not a fully skipped, empty or absent one", () => {
    expect(collectExecutedRules(ruleResults)).toEqual(["core/info", "core/mixed", "core/passes", "core/warns"]);
  });

  test("is in the JSON report, and every rule id in issues is in it", () => {
    const json = parse();
    expect(json.executedRules).toEqual(["core/info", "core/mixed", "core/passes", "core/warns"]);
    for (const issue of json.issues as Array<{ ruleId: string }>) expect(json.executedRules).toContain(issue.ruleId);
    expect(json.executedRules).not.toContain("core/fully-skipped");
  });

  test("passedRules, with --include-passed, are all executed rules", () => {
    const json = parse({ includePassed: true });
    for (const rule of (json.passedRules ?? []) as Array<{ ruleId: string }>) expect(json.executedRules).toContain(rule.ruleId);
  });

  test("a check carried over from an earlier audit does not make a rule executed in this one", () => {
    const smart = {
      "core/carried-only": result("core/carried-only", [check("warn", { provenance: "carried", pageUrl: "https://example.com/old" })]),
      "core/fresh-and-carried": result("core/fresh-and-carried", [check("warn", { provenance: "carried" }), check("pass", { provenance: "fresh" })]),
      "core/fresh": result("core/fresh", [check("pass")]),
    };
    expect(collectExecutedRules(smart)).toEqual(["core/fresh", "core/fresh-and-carried"]);
  });

  test("a report with no rule results omits it (a report read back with --input carries none)", () => {
    const bare = JSON.parse(renderJson({ ...report, ruleResults: {} } as unknown as AuditReport)) as Record<string, unknown>;
    expect(bare).not.toHaveProperty("executedRules");
  });
});

describe("unstored page rows", () => {
  const unstored: JsonPageRow[] = [
    { url: "https://example.com/gone", finalUrl: "https://example.com/gone", status: 0, outcome: "error", ruleCount: 0, reason: "rate-limited" },
    { url: "https://example.com/admin", finalUrl: "https://example.com/admin", status: 0, outcome: "skipped", ruleCount: 0, reason: "excluded" },
  ];
  const crawled: JsonPageRow = { url: "https://example.com/", finalUrl: "https://example.com/", status: 200, outcome: "ok", ruleCount: 2 };

  test("rows carry outcome error or skipped and a reason; a crawled row has no reason key", () => {
    const json = parse({ pages: [crawled, ...unstored] });
    expect(json.pages[0]).not.toHaveProperty("reason");
    expect(json.pages[1]).toMatchObject({ outcome: "error", reason: "rate-limited", status: 0, ruleCount: 0 });
    expect(json.pages[2]).toMatchObject({ outcome: "skipped", reason: "excluded" });
    expect(json.pagesTotal).toBe(3);
  });

  test("pagesTotal is the real count when only some unstored rows were loaded, and the list stays within the cap", () => {
    const many: JsonPageRow[] = Array.from({ length: JSON_REPORT_PAGES.maxEntries + 5 }, (_, i) => ({
      url: `https://example.com/x/${i}`, finalUrl: `https://example.com/x/${i}`, status: 0, outcome: "skipped" as const, ruleCount: 0, reason: "excluded",
    }));
    const json = parse({ pages: many, pagesTotal: many.length + 1_000 });
    expect(json.pages).toHaveLength(JSON_REPORT_PAGES.maxEntries);
    expect(json.pagesTotal).toBe(many.length + 1_000);
    expect(json.pagesTruncated).toBe(true);
  });
});

describe("unstoredPageRow", () => {
  test("skipped entries become codes", () => {
    expect(unstoredPageRow({ url: "u", status: "skipped", reason: "robots_disallowed" })).toEqual({ url: "u", outcome: "skipped", reason: "robots-disallowed" });
    expect(unstoredPageRow({ url: "u", status: "skipped", reason: "excluded" }).reason).toBe("excluded");
    expect(unstoredPageRow({ url: "u", status: "skipped", reason: "cross_domain" }).reason).toBe("other-site");
    expect(unstoredPageRow({ url: "u", status: "skipped", reason: null })).toMatchObject({ outcome: "skipped", reason: "skipped" });
  });

  test("a failed request is one of a fixed set of codes, never the message", () => {
    const reason = (message: string | null) => unstoredPageRow({ url: "u", status: "failed", reason: message }).reason;
    expect(reason("Rate limited by example.com")).toBe("rate-limited");
    expect(reason("HTTP 503")).toBe("http-503");
    // What the crawl writes for a server error that survived retries, and for a WAF refusal.
    expect(reason("Server error: 500")).toBe("http-500");
    expect(reason("Request blocked by server")).toBe("blocked");
    expect(reason("Off-site redirect to https://other.example/cb?x=1")).toBe("off-site-redirect");
    expect(reason("Crawl request timed out")).toBe("timeout");
    expect(reason("TLS/connection error: unable to verify the first certificate")).toBe("tls");
    expect(reason("Could not decode response body from https://e.test/a (content-encoding: gzip): incorrect header check")).toBe("unreadable-body");
    expect(reason("connect ECONNREFUSED 10.0.0.1:443")).toBe("connection-refused");
    expect(reason("read ECONNRESET")).toBe("connection-reset");
    expect(reason("getaddrinfo ENOTFOUND shop.example")).toBe("dns");
    expect(reason("Too many redirects")).toBe("too-many-redirects");
    expect(reason("something unexpected")).toBe("request-failed");
    expect(reason(null)).toBe("request-failed");
  });

  test("a path that spells a cause in a URL is not a cause", () => {
    const reason = (message: string) => unstoredPageRow({ url: "u", status: "failed", reason: message }).reason;
    // A decode error names the page: `/timeout`, `/ssl` and `/ECONNREFUSED` in the URL must not become the reason.
    expect(reason("Could not decode response body from https://e.test/timeout (content-encoding: gzip): bad")).toBe("unreadable-body");
    expect(reason("Fetch failed for https://e.test/ssl/ECONNREFUSED/timeout")).toBe("request-failed");
    expect(reason("Fetch failed for //e.test/tls?x=timeout")).toBe("request-failed");
  });

  test("a url-too-long row is cut and every reason is of the fixed type", () => {
    const row = unstoredPageRow({ url: `https://e.test/${"a".repeat(10_000)}`, status: "skipped", reason: "url_too_long" });
    expect(row.reason).toBe("url-too-long");
    expect(row.url.length).toBeLessThanOrEqual(2_051);
    expect(unstoredPageRow({ url: "u", status: "skipped", reason: "invalid_url" }).reason).toBe("skipped");
    expect(unstoredPageRow({ url: "u", status: "skipped", reason: "some new reason" }).reason).toBe("skipped");
  });

  test("the reason carries no URL, query string, token, address or response text", () => {
    const secrets = [
      "Off-site redirect to https://evil.example/cb?token=sk_live_ABCDEF123456&next=/x#frag",
      "fetch failed for https://user:pw@shop.example/a?session=deadbeefdeadbeef",
      "HTTP 500 body: <html>Internal error: DB password=hunter2 at 10.1.2.3</html>",
      "unexpected response: {\"error\":\"invalid api key AKIAIOSFODNN7EXAMPLE\"}",
      `bad\u001b[2J\u202e line\n${"x".repeat(500)} https://t.example/?k=v`,
    ];
    for (const message of secrets) {
      const { reason } = unstoredPageRow({ url: "u", status: "failed", reason: message });
      expect(reason, message).toMatch(/^[a-z0-9-]{1,40}$/);
      for (const leak of ["//", "token", "sk_live", "session", "deadbeef", "hunter2", "10.1.2.3", "AKIA", "evil", "shop.example", "?", "#", "@", "<", "\u001b", "\u202e"]) {
        expect(reason.toLowerCase().includes(leak.toLowerCase()), `${leak} in ${reason}`).toBe(false);
      }
    }
    // A skipped entry's reason is a code too, whatever the stored text was.
    expect(unstoredPageRow({ url: "u", status: "skipped", reason: "weird https://x.example/?a=b" }).reason).toBe("skipped");
  });
});
