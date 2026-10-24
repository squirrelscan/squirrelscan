// The console report prints the label of a page-URL item (#2307): `links/no-contextual-inbound`
// says where the links to a flagged page sit in the item's label, and the item carries no
// sourcePages, so the label is the only place that sentence appears.

import { describe, expect, spyOn, test } from "bun:test";

import type { AuditReport } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function capture(report: AuditReport): string {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    generateConsoleReport(report);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n").replace(ANSI, "");
}

describe("console report page-URL items (#2307)", () => {
  test("an item whose id is a page URL prints its label", () => {
    const report = createMinimalReport();
    const label =
      "https://example.com/blog, linked only from the footer and the navigation";
    report.ruleResults = {
      "links/no-contextual-inbound": {
        meta: {
          id: "links/no-contextual-inbound",
          name: "No Contextual Inbound Links",
          description: "desc",
          category: "links",
          scope: "site",
          severity: "warning",
          weight: 4,
        },
        checks: [
          {
            name: "no-contextual-inbound",
            status: "warn",
            message: "1 page(s) are linked only from sitewide chrome",
            items: [{ id: "https://example.com/blog", label }],
          },
        ],
      },
    };

    expect(capture(report)).toContain(`→ ${label}`);
  });
});
