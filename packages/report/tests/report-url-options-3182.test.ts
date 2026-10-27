// squirrelscan/repo#3182: a host serving published reports from its own domain
// tells the renderer the report's URL (og, agent links, canonical) and where the
// technology logos live, and can pin every inline script with a CSP hash.

import { describe, expect, test } from "bun:test";

import type { AuditReport, EntityMap } from "../src/types";
import { renderHtml, reportInlineScripts } from "../src/output/html";

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-28T10:00:00.000Z",
    totalPages: 200,
    passed: 3,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

const TECH = {
  firstScan: true,
  added: [],
  removed: [],
  items: [
    {
      id: "nextjs",
      name: "Next.js",
      category: "framework",
      version: null,
      confidence: "high",
      icon: "nextjs",
      detectedBy: "html",
    },
  ],
} as unknown as AuditReport["technologies"];

const MAP: EntityMap = {
  format: "squirrelscan/entity-map",
  version: 1,
  site: "https://example.com/",
  generatedAt: "2026-10-28T00:00:00.000Z",
  summary: {
    nodeCount: 1,
    edgeCount: 0,
    danglingCount: 0,
    pagesTotal: 1,
    pagesWithoutEntities: 0,
    nodesWithStableId: 1,
    stableIdShare: 1,
    pageLocalCount: 0,
    nodesWithoutIdCount: 0,
    conflictCount: 0,
    countsByType: { Organization: 1 },
  },
  nodes: [
    {
      key: "id:x",
      id: "https://example.com/#org",
      types: ["Organization"],
      name: "Example",
      properties: { name: "Example" },
      occurrences: 1,
      pages: ["https://example.com/"],
      morePages: 0,
      conflicts: [],
      danglingRefs: 0,
      pageLocal: false,
    },
  ],
  edges: [],
  pages: [],
} as unknown as EntityMap;

describe("reportUrl", () => {
  test("without it the report links to the reports host and has no canonical, as before", () => {
    const html = renderHtml(report(), { reportId: "01JREPORT" });
    expect(html).toContain('<meta property="og:url" content="https://reports.squirrelscan.com/01JREPORT"/>');
    expect(html).toContain('href="https://reports.squirrelscan.com/01JREPORT.md"');
    expect(html).not.toContain('rel="canonical"');
  });

  test("with it every link to the report uses it, plus a canonical link", () => {
    const url = "https://acme.squirrel.report/01JREPORT";
    const html = renderHtml(report(), { reportId: "01JREPORT", reportUrl: url });
    expect(html).toContain(`<link rel="canonical" href="${url}"/>`);
    expect(html).toContain(`<meta property="og:url" content="${url}"/>`);
    expect(html).toContain(`<meta property="og:image" content="${url}/og.png"/>`);
    expect(html).toContain(`href="${url}.md"`);
    expect(html).toContain(`href="${url}.json"`);
    expect(html).not.toContain("reports.squirrelscan.com");
  });
});

describe("techIconBaseUrl", () => {
  test("technology logos load from the given host", () => {
    const html = renderHtml(report({ technologies: TECH }), {
      offline: false,
      techIconBaseUrl: "https://assets.squirrel.report/tech-icons/",
    });
    expect(html).toContain('src="https://assets.squirrel.report/tech-icons/nextjs.png"');
    expect(html).not.toContain("squirrelscan.com/tech-icons");
  });

  test("the default is unchanged", () => {
    const html = renderHtml(report({ technologies: TECH }), { offline: false });
    expect(html).toContain('src="https://squirrelscan.com/tech-icons/nextjs.png"');
  });
});

describe("reportInlineScripts", () => {
  /** Every executable inline script body: no src, not a JSON data block. */
  function executableScripts(html: string): string[] {
    const bodies: string[] = [];
    const tag = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    for (const [, attrs, body] of html.matchAll(tag)) {
      if (/\bsrc=/.test(attrs ?? "") || /type="application\/json"/.test(attrs ?? "")) continue;
      bodies.push(body ?? "");
    }
    return bodies;
  }

  test("lists every executable inline script the report renders, exactly", () => {
    const scope = { origin: "cli" as const, maxPages: 200, pagesCrawled: 200, capped: true };
    const reports = [
      report(),
      // The coverage notice carries its own dismiss script.
      { ...report({ scanScope: scope }), sitemaps: { totalUrls: 900, missingPages: [] } } as AuditReport,
      // The entity viewer carries its own script.
      report({ entityMap: MAP }),
    ];
    const known = new Set(reportInlineScripts());
    const seen = new Set<string>();
    for (const r of reports) {
      for (const body of executableScripts(renderHtml(r, { reportId: "01JREPORT", offline: false }))) {
        expect(known.has(body)).toBe(true);
        seen.add(body);
      }
    }
    // The fixtures exercise every listed script, so none of them is stale.
    expect(seen).toEqual(known);
  });
});
