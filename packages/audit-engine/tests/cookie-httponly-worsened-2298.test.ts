// pub#2298: one `cookie-httponly` check. A session-like cookie that goes from warn to fail (third-party scripts
// appear on the page) keeps its finding key, so the merge carries one finding getting worse.

import type {
  CheckResult,
  PageFindingRecord,
} from "@squirrelscan/core-contracts";
import type { ParsedPage } from "@squirrelscan/rules/types";

import { parsePage } from "@squirrelscan/parser";
import { loadAllRules } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import { computeMerge, findingKey, flattenChecks } from "../src/merge-core";

const rule = loadAllRules().get("security/cookie-flags")!;
const RULE = "security/cookie-flags";
const URL = "https://shop.test/";
const SITE = "web_2298";
const NOW = 1_780_000_000_000;
const FIRST = NOW - 86_400_000;
const WITH_SCRIPT = "<script src='https://cdn.thirdparty.net/a.js'></script>";

function checks(setCookie: string, scripts: string): CheckResult[] {
  const html = `<!doctype html><html><head><title>t</title>${scripts}</head><body>x</body></html>`;
  const out = rule.run({
    page: {
      url: URL,
      html,
      statusCode: 200,
      loadTime: 0,
      headers: { "set-cookie": setCookie },
    },
    parsed: parsePage(html, URL) as ParsedPage,
    options: {},
  }) as { checks: CheckResult[] };
  return out.checks.map((c) => ({ ...c, pageUrl: URL }));
}

const prior = (cookie: string): PageFindingRecord => ({
  siteKey: SITE,
  normalizedUrl: URL,
  ruleId: RULE,
  checkName: "cookie-httponly",
  locator: cookie,
  status: "warn",
  severity: "warning",
  message: "1 cookie(s) missing the HttpOnly flag",
  value: null,
  expected: null,
  payload: null,
  fingerprint: "fp-old",
  firstSeenAt: FIRST,
  lastSeenCrawlId: "a0",
  lastSeenAt: FIRST,
  provenance: "fresh",
  state: "open",
});

function merge(cookieChecks: CheckResult[], priors: PageFindingRecord[]) {
  const merged = computeMerge({
    siteKey: SITE,
    crawlId: "a1",
    crawledUrls: new Set([URL]),
    freshFindings: flattenChecks(URL, RULE, cookieChecks),
    removedUrls: new Set(),
    severityByRule: new Map([[RULE, "warning"]]),
    statusByUrl: new Map([[URL, 200]]),
    priorFindings: priors,
    priorPages: [
      {
        siteKey: SITE,
        normalizedUrl: URL,
        lastStatus: 200,
        state: "active",
        lastSeenCrawlId: "a0",
        lastSeenAt: FIRST,
      },
    ],
    now: NOW,
  });
  const rows = (check: string, locator: string) =>
    merged.persisted.filter(
      (f) =>
        findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator) ===
        findingKey(URL, RULE, check, locator)
    );
  return { rows, all: merged.persisted };
}

describe("cookie-httponly keeps one finding key across warn and fail (#2298)", () => {
  test("the rule declares no superseded checks", () => {
    expect(rule.meta.supersededChecks).toBeUndefined();
  });

  test("a prior warn becomes the same key at fail: worsened in place, first-seen kept", () => {
    const { rows, all } = merge(
      checks("PHPSESSID=abc; Path=/; Secure", WITH_SCRIPT),
      [prior("PHPSESSID")]
    );
    const found = rows("cookie-httponly", "PHPSESSID");
    expect(found).toHaveLength(1);
    expect(found[0]?.state).toBe("open");
    expect(found[0]?.status).toBe("fail");
    expect(found[0]?.firstSeenAt).toBe(FIRST);
    expect(
      all.some((f) => f.checkName === "cookie-httponly-third-party-scripts")
    ).toBe(false);
  });

  test("a cookie still without third-party scripts stays warn with its first-seen date", () => {
    const { rows } = merge(checks("PHPSESSID=abc; Path=/; Secure", ""), [
      prior("PHPSESSID"),
    ]);
    const found = rows("cookie-httponly", "PHPSESSID");
    expect(found).toHaveLength(1);
    expect(found[0]?.status).toBe("warn");
    expect(found[0]?.firstSeenAt).toBe(FIRST);
  });

  test("a fixed cookie resolves the prior finding", () => {
    const { rows } = merge(
      checks("PHPSESSID=abc; Path=/; Secure; HttpOnly", WITH_SCRIPT),
      [prior("PHPSESSID")]
    );
    expect(rows("cookie-httponly", "PHPSESSID")[0]?.state).toBe("resolved");
  });
});
