// #1253: a WAF or bot manager that serves the audited page a challenge fails the
// audit and the console says who, why, the code and what to do; blocked pages
// that did not stop the audit are counted and listed. Our own colour codes are
// stripped before asserting.
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { generateConsoleReport } from "../../src/reports/output/console";

function capture(run: () => void): string {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")
    );
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  // eslint-disable-next-line no-control-regex
  return chunks.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const base = {
  baseUrl: "https://example.com",
  timestamp: "2026-10-29T00:00:00.000Z",
  passed: 0,
  warnings: 0,
  failed: 0,
  ruleResults: {},
} as unknown as AuditReport;

describe("console report for blocked pages", () => {
  test("a blocked seed prints the reason, code and remedies, and no score", () => {
    const out = capture(() =>
      generateConsoleReport({
        ...base,
        totalPages: 0,
        status: "blocked",
        statusReason:
          "Site blocked the crawler (bot protection / auth / rate limit): blocked_by_datadome: DataDome served a challenge or block page (DataDome challenge on a near-empty page), HTTP 200, for example.com",
        wafBlocked: {
          total: 1,
          providers: ["DataDome"],
          pages: [],
          seed: {
            url: "https://example.com/",
            status: 200,
            provider: "DataDome",
            providerId: "datadome",
            signal: "DataDome challenge on a near-empty page",
            code: "blocked_by_datadome",
          },
        },
      })
    );
    expect(out).toContain("AUDIT BLOCKED");
    expect(out).toContain("blocked_by_datadome");
    expect(out).toContain("HTTP 200");
    expect(out).toContain("Allowlist the `SquirrelScan` user agent");
    expect(out).not.toContain("/100");
  });

  test("other blocked pages are counted and listed above the findings", () => {
    const out = capture(() =>
      generateConsoleReport({
        ...base,
        totalPages: 4,
        healthScore: {
          overall: 90,
          categories: [],
          groups: [],
          errorCount: 0,
          warningCount: 0,
          passedCount: 1,
        },
        wafBlocked: {
          total: 1,
          providers: ["Cloudflare"],
          pages: [
            {
              url: "https://example.com/cart",
              status: 403,
              provider: "Cloudflare",
              providerId: "cloudflare",
              signal: "cf-mitigated: challenge header",
              code: "blocked_by_cloudflare",
            },
          ],
        },
      } as unknown as AuditReport)
    );
    expect(out).toContain("1 of 5 pages blocked by Cloudflare");
    expect(out).toContain("https://example.com/cart: Cloudflare, HTTP 403");
  });
});
