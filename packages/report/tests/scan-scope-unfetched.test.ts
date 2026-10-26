// A capped crawl knows of more pages than it fetched: the in-scope URLs still
// queued when it stopped (`scanScope.unfetched`). Every renderer says how many,
// and the report page counts them as discovered, as a floor ("N+").

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { scanScopeLine, scanScopeUnfetched } from "../src/coverage";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

function report(scanScope: AuditReport["scanScope"], overrides: Partial<AuditReport> = {}) {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-23T00:00:00.000Z",
    totalPages: 200,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    scanScope,
    ...overrides,
  } satisfies AuditReport;
}

const capped = report({
  origin: "cloud",
  maxPages: 200,
  pagesCrawled: 200,
  capped: true,
  unfetched: 531,
});

/** The page's visible text runs, without React's text-node separators. */
function html(r: AuditReport): string {
  return renderHtml(r, { reportId: "TESTID" }).replaceAll("<!-- -->", "");
}

describe("scanScopeUnfetched", () => {
  test("a whole non-negative count, or 0 for anything a stored report could hold", () => {
    expect(scanScopeUnfetched(capped)).toBe(531);
    expect(scanScopeUnfetched(report(undefined))).toBe(0);
    for (const bad of [-1, 2.7, Number.NaN, Number.POSITIVE_INFINITY, "531", null]) {
      const r = report({ origin: "cli", pagesCrawled: 1, capped: false, unfetched: bad as never });
      expect(scanScopeUnfetched(r)).toBe(0);
    }
  });
});

describe("scan line", () => {
  test("adds the queued count after the page limit", () => {
    expect(scanScopeLine(capped)).toBe(
      "Scan: 200 pages crawled from squirrelscan cloud (page limit 200 reached; 531 more discovered but not fetched).",
    );
  });

  test("a run with no limit still says it", () => {
    const r = report({ origin: "cli", pagesCrawled: 12, capped: false, unfetched: 3 });
    expect(scanScopeLine(r)).toBe(
      "Scan: 12 pages crawled from the CLI (3 more discovered but not fetched).",
    );
  });

  test("unchanged when nothing was left queued", () => {
    for (const unfetched of [undefined, 0]) {
      const r = report({
        origin: "cloud",
        maxPages: 200,
        pagesCrawled: 200,
        capped: true,
        unfetched,
      });
      expect(scanScopeLine(r)).toBe(
        "Scan: 200 pages crawled from squirrelscan cloud (page limit 200 reached).",
      );
    }
  });

  test("text and markdown carry it", () => {
    expect(renderText(capped)).toContain("531 more discovered but not fetched");
    expect(renderMarkdown(capped)).toContain("531 more discovered but not fetched");
  });

  test("a rate-limited run says it once, on the rate-limit line that already counts them", () => {
    // `rateLimited.unfetched` is the 5 abandoned URLs plus the same 531 queued ones.
    const throttled = {
      ...capped,
      rateLimited: { pages: 5, hosts: ["example.com"], unfetched: 536 },
    };
    expect(scanScopeLine(throttled)).toBe(
      "Scan: 200 pages crawled from squirrelscan cloud (page limit 200 reached).",
    );
    const text = renderText(throttled);
    expect(text).toContain("536 more discovered but not fetched");
    expect(text).not.toContain("531 more discovered");
  });
});

describe("machine-readable formats", () => {
  test("llm and xml put it on scan-scope, only when there is one", () => {
    expect(renderLlm(capped)).toContain(
      '<scan-scope origin="cloud" crawled="200" max-pages="200" capped="true" unfetched="531"/>',
    );
    expect(renderXml(capped)).toContain('capped="true" unfetched="531"/>');
    const none = report({ origin: "cloud", maxPages: 200, pagesCrawled: 200, capped: true });
    expect(renderLlm(none)).not.toContain("unfetched=");
    expect(renderXml(none)).not.toContain("unfetched=");
  });

  test("a value that is not a count never reaches the markup", () => {
    const forged = report({
      origin: "cloud",
      pagesCrawled: 200,
      capped: true,
      unfetched: '1"/><x' as never,
    });
    expect(renderLlm(forged)).not.toContain("unfetched=");
    expect(renderXml(forged)).not.toContain("unfetched=");
  });

  test("json meta carries it, only when there is one", () => {
    expect(JSON.parse(renderJson(capped)).meta.unfetched).toBe(531);
    const none = report({ origin: "cloud", maxPages: 200, pagesCrawled: 200, capped: true });
    expect("unfetched" in JSON.parse(renderJson(none)).meta).toBe(false);
  });

  test("every renderer drops a non-whole unfetched count", () => {
    const forged = report({
      origin: "cloud",
      maxPages: 200,
      pagesCrawled: 200,
      capped: true,
      unfetched: 2.7,
    });

    expect(renderText(forged)).not.toContain("more discovered but not fetched");
    expect(renderMarkdown(forged)).not.toContain("more discovered but not fetched");
    expect(renderLlm(forged)).not.toContain('unfetched="');
    expect(renderXml(forged)).not.toContain('unfetched="');
    expect("unfetched" in JSON.parse(renderJson(forged)).meta).toBe(false);
    const renderedHtml = html(forged);
    expect(renderedHtml).toContain("Scanned 200 of 200 discovered pages");
    expect(renderedHtml).not.toContain("this crawl fetched 200 and left");
  });
});

describe("report page", () => {
  test("counts the queued URLs as discovered, as a floor, on a capped crawl", () => {
    const out = html(capped);
    expect(out).toContain("Scanned 200 of 731+ discovered pages");
    expect(out).toContain("this crawl fetched 200 and left 531 queued");
  });

  test("a time-stopped crawl is a floor too", () => {
    const out = html(
      report(
        {
          origin: "cloud",
          maxPages: 500,
          pagesCrawled: 87,
          capped: false,
          stopReason: "time",
          unfetched: 40,
        },
        { totalPages: 87 },
      ),
    );
    expect(out).toContain("Scanned 87 of 127+ discovered pages");
  });

  test("the larger of the sitemap and the crawl's own count wins, never their sum", () => {
    // Queued sitemap URLs are already among the sitemap's, so adding the two
    // would count them twice.
    const site = (unfetched: number) =>
      html(
        report({ origin: "cli", maxPages: 20, pagesCrawled: 20, capped: true, unfetched }, {
          totalPages: 20,
          sitemaps: { totalUrls: 78, missingPages: [] },
        } as Partial<AuditReport>),
      );
    // Only sitemap URLs left queued: the sitemap's count stands.
    expect(site(58)).toContain("Scanned 20 of 78+ discovered pages");
    // 58 of them plus 11 links no sitemap lists: the crawl's count is larger.
    expect(site(69)).toContain("Scanned 20 of 89+ discovered pages");
  });

  test("a complete crawl's count is exact: no floor mark", () => {
    const out = html(
      report(
        { origin: "cli", maxPages: 500, pagesCrawled: 200, capped: false },
        { totalPages: 200 },
      ),
    );
    expect(out).toContain("Scanned 200 of 200 discovered pages");
    expect(out).not.toContain("200+");
  });

  test("a capped crawl that knows of nothing more prints no floor mark", () => {
    const out = html(report({ origin: "cloud", maxPages: 200, pagesCrawled: 200, capped: true }));
    expect(out).toContain("Scanned 200 of 200 discovered pages");
    expect(out).not.toContain("left 0 queued");
    expect(out).not.toContain(' queued"');
  });

  // A hosted smart audit: 200 pages audited this run, 100 more known from
  // earlier audits and carried. The queued URLs were never audited, so the
  // coverage note must not say the pages beyond the known ones carry findings.
  const smart = (unfetched?: number) =>
    html(
      report(
        { origin: "cloud", maxPages: 200, pagesCrawled: 200, capped: true, unfetched },
        { coverage: { auditedPages: 200, knownPages: 300, carriedFindings: 5 } },
      ),
    );

  test("queued URLs on a smart audit are not called carried", () => {
    const out = smart(400);
    expect(out).toContain("Scanned 200 of 600+ discovered pages");
    expect(out).not.toContain("carried from earlier audits");
  });

  test("a smart audit's gap of known pages alone still reads as carried", () => {
    expect(smart()).toContain("carried from earlier audits");
  });
});
