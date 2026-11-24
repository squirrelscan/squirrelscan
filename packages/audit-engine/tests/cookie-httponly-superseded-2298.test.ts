// pub#2298: `cookie-httponly-third-party-scripts` supersedes `cookie-httponly`, keyed by cookie name.

import type {
  CheckResult,
  PageFindingRecord,
} from "@squirrelscan/core-contracts";
import type { ParsedPage } from "@squirrelscan/rules/types";

import { buildSupersededIndex } from "@squirrelscan/core-contracts/resolution";
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
    supersededChecks: buildSupersededIndex([rule.meta]),
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
  const row = (check: string, locator: string) =>
    merged.persisted.find(
      (f) =>
        findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator) ===
        findingKey(URL, RULE, check, locator)
    );
  return { row };
}

describe("cookie-httponly is superseded by cookie-httponly-third-party-scripts (#2298)", () => {
  test("the rule declares the link", () => {
    expect(rule.meta.supersededChecks?.["cookie-httponly"]).toEqual([
      "cookie-httponly-third-party-scripts",
    ]);
  });

  test("a cookie that moved warn -> fail: old row retires, same finding worse, keeps first-seen", () => {
    const { row } = merge(
      checks("PHPSESSID=abc; Path=/; Secure", WITH_SCRIPT),
      [prior("PHPSESSID")]
    );
    expect(row("cookie-httponly", "PHPSESSID")?.state).toBe("stale");
    const next = row("cookie-httponly-third-party-scripts", "PHPSESSID")!;
    expect(next.state).toBe("open");
    expect(next.status).toBe("fail");
    expect(next.firstSeenAt).toBe(FIRST);
  });

  test("a cookie still failing cookie-httponly keeps its finding unchanged", () => {
    // `theme` is not session-like, so it stays a warning even with third-party scripts.
    const { row } = merge(checks("theme=dark; Path=/; Secure", WITH_SCRIPT), [
      prior("theme"),
    ]);
    const kept = row("cookie-httponly", "theme")!;
    expect(kept.state).toBe("open");
    expect(kept.status).toBe("warn");
    expect(kept.firstSeenAt).toBe(FIRST);
    expect(row("cookie-httponly-third-party-scripts", "theme")).toBeUndefined();
  });

  test("a fixed cookie resolves the old finding", () => {
    const { row } = merge(
      checks("PHPSESSID=abc; Path=/; Secure; HttpOnly", WITH_SCRIPT),
      [prior("PHPSESSID")]
    );
    expect(row("cookie-httponly", "PHPSESSID")?.state).toBe("resolved");
    expect(
      row("cookie-httponly-third-party-scripts", "PHPSESSID")
    ).toBeUndefined();
  });
});
