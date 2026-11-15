// #801: SlimJsonReport (renderJson) must carry status/statusReason. Without
// them a 0-page failed/blocked audit serializes with zero issues and no
// failure signal — a programmatic consumer reads it as a clean pass (the same
// gap #792 closed for html/markdown/text/llm).

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderJson } from "../src/output/json";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 0,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

describe("renderJson failed/blocked status (#801)", () => {
  test("issue checks keep observation metadata for downstream filtering", () => {
    const parsed = JSON.parse(
      renderJson(
        baseReport({
          totalPages: 1,
          warnings: 1,
          ruleResults: {
            "security/form-captcha": {
              meta: {
                id: "security/form-captcha",
                name: "Form CAPTCHA",
                description: "Static client-side form check",
                category: "security",
                scope: "page",
                severity: "warning",
                weight: 4,
              },
              checks: [
                {
                  name: "form-captcha",
                  status: "warn",
                  message: "Client-side markup not observed",
                  observation: {
                    mode: "static",
                    applicability: "applicable",
                    uncertainty: "Server-side controls are not observable.",
                  },
                },
                {
                  name: "no-public-form",
                  status: "info",
                  message: "No public forms were observed",
                  observation: { mode: "static", applicability: "not-applicable" },
                },
              ],
            },
            "links/orphan-pages": {
              meta: {
                id: "links/orphan-pages",
                name: "Orphan Pages",
                description: "Inbound link coverage",
                category: "links",
                scope: "site",
                severity: "warning",
                weight: 5,
              },
              checks: [
                {
                  name: "orphan-pages",
                  status: "skipped",
                  message: "The crawl graph is incomplete",
                  skipReason: "Crawl capped before the frontier was exhausted",
                  observation: {
                    mode: "crawl",
                    applicability: "unknown",
                    uncertainty: "Missing inbound links cannot be established.",
                  },
                },
              ],
            },
          },
        }),
      ),
    );
    expect(parsed.issues[0].checks[0].observation).toEqual({
      mode: "static",
      applicability: "applicable",
      uncertainty: "Server-side controls are not observable.",
    });
    expect(parsed.infoChecks[0].observation).toEqual({
      mode: "static",
      applicability: "not-applicable",
    });
    expect(parsed.notChecked[0].observation).toEqual({
      mode: "crawl",
      applicability: "unknown",
      uncertainty: "Missing inbound links cannot be established.",
    });
  });

  test("blocked report serializes status + statusReason", () => {
    const parsed = JSON.parse(
      renderJson(
        baseReport({
          status: "blocked",
          statusReason: "Site blocked the crawler (bot protection / auth / rate limit)",
        }),
      ),
    );
    expect(parsed.status).toBe("blocked");
    expect(parsed.statusReason).toBe(
      "Site blocked the crawler (bot protection / auth / rate limit)",
    );
    // A blocked run must not masquerade as a scored clean pass.
    expect(parsed.score.overall).toBeNull();
    expect(parsed.issues).toEqual([]);
  });

  test("failed (unreachable) report serializes status + statusReason", () => {
    const parsed = JSON.parse(
      renderJson(baseReport({ status: "failed", statusReason: "No pages were crawled" })),
    );
    expect(parsed.status).toBe("failed");
    expect(parsed.statusReason).toBe("No pages were crawled");
  });

  test("completed report: explicit status, no statusReason, shape otherwise unchanged", () => {
    const parsed = JSON.parse(renderJson(baseReport({ totalPages: 5, passed: 10 })));
    // status absent on the core report ⇒ explicit "completed" for consumers.
    expect(parsed.status).toBe("completed");
    expect("statusReason" in parsed).toBe(false);
    // Additive: the pre-#801 top-level keys are all still present.
    expect(Object.keys(parsed)).toEqual(["meta", "status", "score", "summary", "issues"]);
    // #518: `summary` gains `skipped` (0 with no skips); the rest keep their names.
    expect(parsed.summary).toEqual({ passed: 10, warnings: 0, failed: 0, skipped: 0 });
  });
});
