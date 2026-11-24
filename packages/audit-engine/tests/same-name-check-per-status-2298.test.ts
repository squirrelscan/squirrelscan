// #2298: a rule may emit two checks under ONE name on a page, one per severity
// (security/cookie-flags emits `cookie-httponly` as a fail for session-like
// cookies on a page with third-party scripts and as a warn for the rest).
// Reconstruct must rebuild both, each with its own status, items and message,
// rather than merging them into one check with the first row's status.

import type {
  CheckResult,
  PageFindingRecord,
} from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";

import { fingerprint, flattenChecks } from "../src/merge";
import { reconstructPageRuleChecks } from "../src/reconstruct";

const URL = "https://x/a";
const RULE = "security/cookie-flags";

function toRecord(
  f: ReturnType<typeof flattenChecks>[number]
): PageFindingRecord {
  return {
    siteKey: "SITE",
    normalizedUrl: f.normalizedUrl,
    ruleId: f.ruleId,
    checkName: f.checkName,
    locator: f.locator,
    status: f.status as PageFindingRecord["status"],
    severity: f.status === "fail" ? "error" : "warning",
    message: f.message,
    value: f.value,
    expected: f.expected,
    payload: f.payload,
    fingerprint: fingerprint(f.status, f.message, f.value, f.expected),
    firstSeenAt: 1,
    lastSeenCrawlId: "crawl-1",
    lastSeenAt: 1,
    provenance: "fresh",
    state: "open",
  };
}

const failing: CheckResult = {
  name: "cookie-httponly",
  status: "fail",
  message:
    "1 session-like cookie(s) missing the HttpOnly flag on a page that loads scripts from 1 third-party host(s): cdn.vendor.net. Any script on the page can read these cookies",
  items: [{ id: "laravel_session" }],
  details: { thirdPartyScriptHosts: ["cdn.vendor.net"] },
};
const warning: CheckResult = {
  name: "cookie-httponly",
  status: "warn",
  message: "2 cookie(s) missing the HttpOnly flag",
  items: [{ id: "theme" }, { id: "locale" }],
};

/** Rebuild the rule's checks from stored rows, keyed for order-free compare. */
function rebuild(rows: PageFindingRecord[]): Map<string, CheckResult> {
  const checks = reconstructPageRuleChecks(rows).get(RULE) ?? [];
  return new Map(checks.map((c) => [c.status, c]));
}

describe("#2298 two checks with one name and different statuses", () => {
  test("each status rebuilds as its own check with its own items", () => {
    const rows = flattenChecks(URL, RULE, [failing, warning]).map(toRecord);
    const rebuilt = rebuild(rows);
    expect(rebuilt.size).toBe(2);
    for (const source of [failing, warning]) {
      const got = rebuilt.get(source.status);
      expect(got?.name).toBe(source.name);
      expect(got?.message).toBe(source.message);
      expect(got?.items?.map((i) => i.id)).toEqual(
        source.items!.map((i) => i.id)
      );
    }
    expect(rebuilt.get("fail")?.details).toEqual(failing.details!);
  });

  test("the rebuild does not depend on row order (warn rows loaded first, interleaved)", () => {
    const rows = flattenChecks(URL, RULE, [failing, warning]).map(toRecord);
    // Loader order is not emission order: put a warn row first and the fail
    // row between the two warn rows.
    const at = (id: string) => rows.find((r) => r.locator === id)!;
    const sorted = [at("locale"), at("laravel_session"), at("theme")];
    expect(sorted.map((r) => r.status)).toEqual(["warn", "fail", "warn"]);
    const rebuilt = rebuild(sorted);
    expect(rebuilt.get("fail")?.items?.map((i) => i.id)).toEqual(
      failing.items!.map((i) => i.id)
    );
    expect(rebuilt.get("warn")?.items?.map((i) => i.id)).toEqual(
      warning.items!.map((i) => i.id)
    );
  });
});
