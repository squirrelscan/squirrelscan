// pub#837: the console lists each page that carries a broken link once, with how many links it
// has to the target and where they sit, and the summary keeps the links and the pages apart.

import { describe, expect, spyOn, test } from "bun:test";

import type { AuditReport } from "@/types";

import { generateConsoleReport } from "@/reports/output/console";

import { createMinimalReport } from "../fixtures";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const SITE = "https://example.com";

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

function brokenLinks(
  sources: { page: string; links: number; sections?: Record<string, number> }[]
): AuditReport {
  const report = createMinimalReport();
  report.ruleResults = {
    "links/broken-links": {
      meta: {
        id: "links/broken-links",
        name: "Broken Links",
        description: "Detects links returning 404 or 5xx errors",
        category: "links",
        scope: "site",
        severity: "error",
        weight: 7,
      },
      checks: [
        {
          name: "broken-links",
          status: "fail",
          message: "1 broken internal link(s) (4xx/5xx)",
          items: [
            {
              id: `${SITE}/gone`,
              label: `${SITE}/gone (404)`,
              sourcePages: sources.map((s) => s.page),
              sources,
            },
          ],
        },
      ],
    },
  };
  return report;
}

describe("console broken link sources (pub#837)", () => {
  test("each page once, with its link count and the sections it links from", () => {
    const out = capture(
      brokenLinks([
        { page: `${SITE}/a`, links: 2, sections: { content: 1, footer: 1 } },
        { page: `${SITE}/b`, links: 1, sections: { footer: 1 } },
        { page: `${SITE}/c`, links: 1 },
      ])
    );
    expect(out).toContain(
      "broken-links: 1 broken internal link(s) (4xx/5xx), found on 3 pages"
    );
    expect(out).toContain(
      "from /a (2 links, in the page content and the footer)"
    );
    expect(out).toContain("from /b (in the footer)");
    expect(out.split("from /a").length - 1).toBe(1);
    expect(out).toMatch(/from \/c\s/);
  });

  test("a long list says how many pages it leaves out", () => {
    const out = capture(
      brokenLinks(
        Array.from({ length: 5 }, (_, k) => ({
          page: `${SITE}/p${k}`,
          links: 1,
        }))
      )
    );
    expect(out).toContain("from /p2");
    expect(out).not.toContain("from /p3");
    expect(out).toContain("... +2 more pages");
  });

  test("an a11y item found on several pages lists them once, with no section", () => {
    const report = createMinimalReport();
    report.ruleResults = {
      "a11y/link-text": {
        meta: {
          id: "a11y/link-text",
          name: "Link Text",
          description: "Links need descriptive text",
          category: "a11y",
          scope: "page",
          severity: "warning",
          weight: 4,
        },
        checks: Array.from({ length: 5 }, (_, k) => ({
          name: "link-text-generic",
          status: "warn" as const,
          message: "1 link(s) with generic text",
          pageUrl: `${SITE}/p${k}`,
          items: [{ id: "read more" }],
        })),
      },
    };
    const out = capture(report);
    expect(out).toMatch(/from \/p0\s/);
    expect(out.split("from /p0").length - 1).toBe(1);
    expect(out).toContain("... +2 more pages");
    expect(out).not.toContain("see full list");
  });

  test("a link in the footer of most pages names the region, not the pages (pub#846)", () => {
    const sources = Array.from({ length: 12 }, (_, k) => ({
      page: `${SITE}/p${k}`,
      links: 1,
      sections: { footer: 1 },
    }));
    const report = brokenLinks(sources);
    const item =
      report.ruleResults["links/broken-links"]!.checks[0]!.items![0]!;
    item.regions = { footer: 12 };
    item.label = `${SITE}/gone (404), linked in the footer`;
    item.meta = { statusCode: 404, sections: { footer: 12 } };
    report.structure = {
      pages: 13,
      sections: [{ section: "footer", pages: 13, links: 40 }],
      unknownLinks: 0,
      totalLinks: 40,
      chrome: { links: 40, contentLinks: 0, share: 1 },
      pageTypes: { counts: [], notClassified: 13, byModel: 0, degraded: 0 },
    } as unknown as NonNullable<AuditReport["structure"]>;
    const out = capture(report);
    expect(out).toContain("In the site footer, on 12 of 13 pages");
    expect(out).not.toContain("from /p0");
    // The region line says where it is, so the label drops its section phrase.
    expect(out).toContain(`→ ${SITE}/gone (404)`);
    expect(out).not.toContain("linked in the footer");
  });

  test("a finding that carries pages from an earlier audit keeps its page rows (pub#860)", () => {
    const sources = Array.from({ length: 12 }, (_, k) => ({
      page: `${SITE}/p${k}`,
      links: 1,
      sections: { footer: 1 },
    }));
    const report = brokenLinks(sources);
    const check = report.ruleResults["links/broken-links"]!.checks[0]!;
    const item = check.items![0]!;
    item.regions = { footer: 12 };
    report.structure = {
      pages: 13,
      sections: [{ section: "footer", pages: 13, links: 40 }],
      unknownLinks: 0,
      totalLinks: 40,
      chrome: { links: 40, contentLinks: 0, share: 1 },
      pageTypes: { counts: [], notClassified: 13, byModel: 0, degraded: 0 },
    } as unknown as NonNullable<AuditReport["structure"]>;
    // Fresh control: the region line.
    expect(capture(report)).toContain("In the site footer, on 12 of 13 pages");
    // Three of the pages are carried from an earlier audit: no share of this audit's region.
    check.provenance = "carried";
    check.lastSeenAt = 1;
    const out = capture(report);
    expect(out).not.toContain("In the site footer, on");
    expect(out).toContain("from /p0");
  });
});
