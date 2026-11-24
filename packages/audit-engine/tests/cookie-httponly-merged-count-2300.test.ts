// pub#2300: pages that each list different cookies can agree on the per-page count ("1 cookie(s)") while the
// merged check lists more items. The merged message must not state fewer cookies than the items it lists.

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { ParsedPage } from "@squirrelscan/rules/types";

import { parsePage } from "@squirrelscan/parser";
import { loadAllRules } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import { groupIssuesByCategory } from "../../report/src/grouping";

const rule = loadAllRules().get("security/cookie-flags")!;
const SCRIPT = "<script src='https://cdn.thirdparty.net/a.js'></script>";

function pageChecks(
  url: string,
  names: string[],
  scripts: string
): CheckResult[] {
  const html = `<!doctype html><html><head><title>t</title>${scripts}</head><body>x</body></html>`;
  const setCookie = names.map((n) => `${n}=1; Secure; SameSite=Lax`).join("\n");
  const out = rule.run({
    page: {
      url,
      html,
      statusCode: 200,
      loadTime: 0,
      headers: { "set-cookie": setCookie },
    },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  }) as { checks: CheckResult[] };
  return out.checks.map((c) => ({ ...c, pageUrl: url }));
}

function merged(pages: [string, string[], string][]) {
  const checks = pages.flatMap(([url, names, scripts]) =>
    pageChecks(url, names, scripts)
  );
  const grouped = groupIssuesByCategory({
    "security/cookie-flags": {
      meta: rule.meta as unknown as Record<string, unknown>,
      checks: checks as unknown as Record<string, unknown>[],
    },
  } as never);
  const out = grouped[0]!.rules[0]!.checks.filter(
    (c) => c.name === "cookie-httponly"
  );
  const byStatus = (s: string) => out.find((c) => c.status === s)!;
  return { warn: byStatus("warn"), fail: byStatus("fail") };
}

/** The leading count of a merged message: `N` or `A to B`; returns the largest. */
const leadingMax = (message: string): number => {
  const m = /^(\d+)(?: to (\d+))?/.exec(message)!;
  return Number(m[2] ?? m[1]);
};

describe("#2300 merged cookie-httponly message count", () => {
  test("pages with equal counts and different cookies: count covers the merged items, WARN and FAIL", () => {
    const { warn, fail } = merged([
      ["https://shop.test/", ["sid", "a"], SCRIPT],
      ["https://shop.test/b", ["connect.sid", "b"], SCRIPT],
    ]);
    for (const check of [warn, fail]) {
      expect(check.items!.length).toBe(2);
      expect(leadingMax(check.message)).toBe(check.items!.length);
      expect(check.message).toMatch(/^1 to 2 /);
    }
    // The FAIL host list is the one both pages agree on.
    expect(fail.message).toContain("cdn.thirdparty.net");
  });

  test("pages with different counts per page: range covers the merged items, WARN and FAIL", () => {
    const { warn, fail } = merged([
      ["https://shop.test/", ["sid", "PHPSESSID", "a", "c"], SCRIPT],
      ["https://shop.test/b", ["connect.sid", "b"], SCRIPT],
    ]);
    expect(fail.items!.length).toBe(3);
    expect(warn.items!.length).toBe(3);
    for (const check of [warn, fail]) {
      expect(leadingMax(check.message)).toBe(check.items!.length);
    }
  });

  test("a message whose count already covers its items is left as the page wrote it", () => {
    const { warn } = merged([
      ["https://shop.test/", ["a", "b"], ""],
      ["https://shop.test/b", ["a", "b"], ""],
    ]);
    expect(warn.items!.length).toBe(2);
    expect(warn.message).toMatch(/^2 cookie\(s\) missing/);
  });
});
