// Report detail (#2307): the console report ends with a REPORT DETAIL section that holds what
// the audit did not check, the page structure, then the scope and coverage notes. The header
// under the title keeps the URL, the page count and the score only.

import { describe, expect, spyOn, test } from "bun:test";

import type { AuditReport } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

function capture(report: AuditReport): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    generateConsoleReport(report);
  } finally {
    spy.mockRestore();
  }
  return lines;
}

const NOT_CHECKED =
  "External link checking was off for this audit, so 3 external link(s) on the audited pages were not checked";

function fullReport(): AuditReport {
  const base = createMinimalReport();
  return {
    ...base,
    scanScope: {
      origin: "cli",
      maxPages: 100,
      pagesCrawled: 100,
      capped: true,
    },
    rateLimited: { pages: 7, hosts: ["example.com"] },
    structure: {
      pages: 1,
      sections: [{ section: "footer", pages: 1, links: 6 }],
      unknownLinks: 0,
      totalLinks: 6,
      chrome: { links: 6, contentLinks: 0, share: 1 },
      pageTypes: {
        counts: [{ label: "homepage", pages: 1 }],
        notClassified: 0,
        byModel: 1,
        degraded: 0,
      },
    },
    ruleResults: {
      "core/meta-title": {
        meta: {
          id: "core/meta-title",
          name: "Meta title",
          description: "d",
          category: "core",
          scope: "page",
          severity: "error",
          weight: 5,
        },
        checks: [
          {
            name: "title",
            status: "fail",
            message: "Missing title",
            pageUrl: "https://example.com/",
          },
        ],
      },
      "links/broken-external-links": {
        meta: {
          id: "links/broken-external-links",
          name: "Broken External Links",
          description: "d",
          category: "links",
          scope: "site",
          severity: "warning",
          weight: 5,
        },
        checks: [
          {
            name: "broken-external-links",
            status: "skipped",
            message: NOT_CHECKED,
            skipReason: "external-links-not-checked",
          },
        ],
      },
    },
  } as AuditReport;
}

describe("console report detail (#2307)", () => {
  const lines = capture(fullReport());
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));

  test("the header keeps the URL, the page count and the score only", () => {
    const header = at("/100");
    const detail = lines.indexOf("REPORT DETAIL");
    expect(header).toBeGreaterThan(-1);
    // Nothing between the title block and the first section mentions any of it.
    const top = lines
      .slice(0, at("EDITOR") > 0 ? at("EDITOR") : header + 6)
      .join("\n");
    for (const text of [
      "Rate limited",
      "Not checked",
      "Page structure",
      "Scan:",
    ]) {
      expect(top).not.toContain(text);
    }
    expect(detail).toBeGreaterThan(header);
  });

  test("REPORT DETAIL comes after the issues, before the footer, in order", () => {
    const order = [
      at("ISSUES"),
      lines.indexOf("REPORT DETAIL"),
      lines.indexOf("Not checked"),
      lines.indexOf("Page structure"),
      lines.indexOf("Scan details"),
      lines.findLastIndex((l) => l.includes(" passed • ")),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("not checked notices are plain list items without the lead-in", () => {
    expect(lines).toContain(
      `  - Broken External Links. ${NOT_CHECKED}. Turn external link checks on to check them: in the CLI pass --external-links (or drop --no-external-links, --offline, or external_links.enabled = false); in the cloud they are a website setting.`
    );
    expect(lines.join("\n")).not.toContain("Not checked:");
  });

  test("a report with none of it has no REPORT DETAIL", () => {
    expect(capture(createMinimalReport())).not.toContain("REPORT DETAIL");
  });
});
