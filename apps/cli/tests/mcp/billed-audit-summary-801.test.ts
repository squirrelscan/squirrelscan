import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import {
  billedAuditSummary,
  type BilledAudit,
} from "../../src/mcp/billed-audit";

const billed = {
  run: { runId: "run-801" },
  notices: [],
} as unknown as BilledAudit;

function report(linkCredits: number): AuditReport {
  return {
    status: "completed",
    pages: Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/${i}`,
    })),
    totalPages: 4,
    ...(linkCredits > 0
      ? {
          cloudSpend: {
            lines: [
              {
                service: "external links",
                feature: "external_link",
                units: linkCredits,
                credits: linkCredits,
              },
            ],
            totalSpent: linkCredits,
            balanceAfter: null,
          },
        }
      : {}),
  } as unknown as AuditReport;
}

describe("billedAuditSummary counts the link checks the cloud billed (#801)", () => {
  test("pages only, when no links were billed", () => {
    expect(billedAuditSummary(billed, report(0))).toContain(
      "4 audited pages, about 58 credits (50 base"
    );
  });

  test("the link credits the server reported are added and named", () => {
    const line = billedAuditSummary(billed, report(3));
    // 50 base + 4 × 2 pages + 3 links.
    expect(line).toContain(
      "about 61 credits (3 of them for external link checks)"
    );
    expect(line).toContain(
      "1 per external link the cloud verifies, at most 1 per page of the page limit"
    );
  });
});
