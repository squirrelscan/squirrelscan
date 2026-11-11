// `meta.targeted` of the JSON report (#1777, schema 1.16): absent on an ordinary audit, and on a targeted run
// it says how many URLs were given and audited and lists each one that was not, with its reason.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderJson } from "../src/output/json";

const report = (targeted: unknown): AuditReport =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-11-12T00:00:00.000Z",
    totalPages: 2,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    scanScope: { origin: "cli", maxPages: 50, pagesCrawled: 2, capped: false, targeted },
  }) as unknown as AuditReport;

const meta = (r: AuditReport) =>
  (JSON.parse(renderJson(r)) as { meta: Record<string, unknown> }).meta;

describe("meta.targeted", () => {
  test("absent on an ordinary audit", () => {
    expect(meta(report(undefined))).not.toHaveProperty("targeted");
  });

  test("carries the counts and every URL not audited with its reason", () => {
    const m = meta(
      report({
        requested: 4,
        audited: 2,
        unaudited: [
          { url: "https://example.com/old", reason: "redirected", destination: "https://example.com/new" },
          { url: "https://example.com/private", reason: "robots_disallowed" },
        ],
      }),
    );
    expect(m.targeted).toEqual({
      requested: 4,
      audited: 2,
      unaudited: [
        { url: "https://example.com/old", reason: "redirected", destination: "https://example.com/new" },
        { url: "https://example.com/private", reason: "robots_disallowed" },
      ],
    });
  });

  test("a stored report of any origin is read defensively", () => {
    const m = meta(
      report({
        requested: 3,
        audited: 1,
        unaudited: [
          { url: 7, reason: "x" },
          { url: "https://example.com/a", reason: "a long free text reason with <script> and symbols!!" },
          ...Array.from({ length: 150 }, (_, i) => ({ url: `https://example.com/${i}`, reason: "over_max_pages" })),
        ],
      }),
    ) as { targeted: { unaudited: Array<{ url: string; reason: string }> } };
    expect(m.targeted.unaudited).toHaveLength(100);
    expect(m.targeted.unaudited[0]).toEqual({ url: "https://example.com/a", reason: "other" });
    expect(meta(report({ requested: "3", audited: 1 }))).not.toHaveProperty("targeted");
  });
});
