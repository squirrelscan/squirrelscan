// ReportSummary (#336): the report header is a single summary block — favicon +
// title/description + score ring, then the screenshot (half width) beside the
// category scores. These pin the new data surfaces: offline favicon tile, title fallback,
// date+TIME generated line, and the footer squirrel version.

import { describe, expect, test } from "bun:test";

import type { AuditReport, DomainStatsPositions } from "../src/types";
import { renderHtml } from "../src/output/html";
import { formatHumanDateTime } from "../src/utils";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://github.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

describe("ReportSummary", () => {
  test("favicon renders as an offline initial tile", () => {
    const html = renderHtml(baseReport());
    expect(html).toContain('class="site-favicon"');
    expect(html).toContain('class="site-favicon" aria-hidden="true">G</div>');
    expect(html).not.toContain("icons.duckduckgo.com");
    expect(html).not.toContain("squirrelscan.com/tech-icons");
  });

  test("technology badges do not make remote image requests", () => {
    const html = renderHtml(
      baseReport({
        technologies: {
          items: [
            {
              id: "react",
              name: "React",
              category: "framework",
              version: null,
              confidence: "high",
              detectedBy: "script",
              icon: "react",
            },
          ],
          added: [],
          removed: [],
          firstScan: true,
        },
      }),
    );
    expect(html).toContain(">React</span>");
    expect(html).not.toContain("squirrelscan.com/tech-icons");
  });

  test("title uses homepage.title, falls back to the host", () => {
    expect(renderHtml(baseReport({ homepage: { title: "My Site", description: null } }))).toContain(
      "My Site",
    );
    // No homepage → the <h1> falls back to the bare host.
    expect(renderHtml(baseReport())).toContain(">github.com<");
  });

  test("description renders when present", () => {
    const html = renderHtml(baseReport({ homepage: { title: "X", description: "A great site" } }));
    expect(html).toContain("A great site");
  });

  test("generated line shows date AND time (UTC)", () => {
    const html = renderHtml(baseReport());
    expect(html).toContain(formatHumanDateTime("2026-06-16T14:30:00.000Z"));
    expect(html).toContain("14:30 UTC");
  });

  test("footer shows the squirrel generator version when present, omits it otherwise", () => {
    expect(renderHtml(baseReport({ generatorVersion: "1.2.3" }))).toContain("squirrel v1.2.3");
    expect(renderHtml(baseReport())).not.toContain("squirrel v");
  });

  test("no dedicated Screenshot heading — the screenshot moved into the summary", () => {
    const html = renderHtml(
      baseReport({ screenshotUrl: "https://assets.squirrelscan.com/s.png" }),
    );
    expect(html).not.toContain(">Screenshot</h2>");
    expect(html).toContain('class="screenshot-section"');
  });
});

// #792: a failed/blocked audit must not read as a clean pass, and a block must
// be framed as the SITE refusing our crawler, not a squirrelscan outage.
describe("failed/blocked report copy", () => {
  test("blocked report: shows the actionable block notice, hides 'No issues found'", () => {
    const html = renderHtml(
      baseReport({
        status: "blocked",
        statusReason: "Site blocked the crawler (bot protection / auth / rate limit)",
        totalPages: 0,
      }),
    );
    expect(html).toContain('class="failure-notice"');
    expect(html).toContain("Your site blocked the audit");
    expect(html).toContain("Allowlist the squirrelscan crawler");
    // Never a false clean pass.
    expect(html).not.toContain("No issues found");
  });

  test("blocked report: locked section does NOT blame the cloud service", () => {
    const html = renderHtml(
      baseReport({
        status: "blocked",
        statusReason: "Site blocked the crawler (bot protection / auth / rate limit)",
        totalPages: 0,
        cloudPlan: "paid",
        lockedRules: [{ id: "a", name: "JS Rendering" }],
      }),
    );
    expect(html).not.toContain("temporarily unavailable");
    expect(html).toContain("need a completed audit to run");
  });

  test("failed (unreachable) report: shows the failed notice, hides 'No issues found'", () => {
    const html = renderHtml(
      baseReport({
        status: "failed",
        statusReason: "No pages were crawled",
        totalPages: 0,
      }),
    );
    expect(html).toContain('class="failure-notice"');
    // Apostrophes render escaped (&#x27;), so assert on apostrophe-free spans.
    expect(html).toContain("audit your site");
    expect(html).toContain("there was nothing");
    expect(html).not.toContain("No issues found");
  });

  test("no em-dashes in the failure notice copy", () => {
    const blocked = renderHtml(baseReport({ status: "blocked", totalPages: 0 }));
    const failed = renderHtml(baseReport({ status: "failed", totalPages: 0 }));
    // Isolate the notice so unrelated markup can't mask an em-dash in the copy.
    for (const html of [blocked, failed]) {
      const start = html.indexOf('class="failure-notice"');
      const notice = html.slice(start, start + 1200);
      expect(notice).not.toContain("—");
    }
  });
});

describe("LockedRulesSection", () => {
  test("renders the upsell with count, CTA, and each locked rule when present", () => {
    const html = renderHtml(
      baseReport({
        lockedRules: [
          { id: "a/render", name: "JS Rendering" },
          { id: "b/ai", name: "AI Content Quality" },
        ],
      }),
    );
    expect(html).toContain('class="locked-section"');
    expect(html).toContain("2 more checks with cloud audits");
    expect(html).toContain("JS Rendering");
    expect(html).toContain("AI Content Quality");
    expect(html).toContain("https://squirrelscan.com");
  });

  test("singular wording for a single locked rule", () => {
    const html = renderHtml(baseReport({ lockedRules: [{ id: "a", name: "X" }] }));
    expect(html).toContain("1 more check with cloud audits");
  });

  test("omits the section when there are no locked rules", () => {
    expect(renderHtml(baseReport())).not.toContain('class="locked-section"');
    expect(renderHtml(baseReport({ lockedRules: [] }))).not.toContain('class="locked-section"');
  });

  // #368: a signed-in user must never see the "get a free account" upsell.
  test("signed-in free plan: no signup upsell, shows dashboard link", () => {
    const html = renderHtml(
      baseReport({ lockedRules: [{ id: "a", name: "X" }], cloudPlan: "free" }),
    );
    expect(html).toContain('class="locked-section"');
    expect(html).toContain("run this audit");
    expect(html).toContain("Add credits in your");
    expect(html).not.toContain("free squirrelscan account");
    expect(html).not.toContain("Get started");
    expect(html).toContain("https://app.squirrelscan.com");
  });

  test("signed-in paid plan: framed as temporarily unavailable, no upsell", () => {
    const html = renderHtml(
      baseReport({ lockedRules: [{ id: "a", name: "X" }], cloudPlan: "paid" }),
    );
    expect(html).toContain("temporarily unavailable");
    expect(html).not.toContain("free squirrelscan account");
    expect(html).not.toContain("Get started");
  });

  // #368: a paid user who deliberately ran --http must NOT be told cloud is
  // "unavailable" — locked checks are framed as their own opt-out.
  test("signed-in + --http opt-out: deliberate choice, not 'unavailable'", () => {
    const html = renderHtml(
      baseReport({
        lockedRules: [{ id: "a", name: "X" }],
        cloudPlan: "paid",
        cloudMode: "http",
      }),
    );
    expect(html).toContain("without cloud rendering");
    expect(html).toContain("--http");
    expect(html).not.toContain("temporarily unavailable");
    expect(html).not.toContain("free squirrelscan account");
    expect(html).not.toContain("Get started");
  });

  // Cloud genuinely on (browser) but checks still missed → keep the "unavailable" framing.
  test("signed-in paid + cloud on (browser): keeps temporarily-unavailable framing", () => {
    const html = renderHtml(
      baseReport({
        lockedRules: [{ id: "a", name: "X" }],
        cloudPlan: "paid",
        cloudMode: "browser",
      }),
    );
    expect(html).toContain("temporarily unavailable");
    expect(html).not.toContain("--http");
  });

  test("explicit anonymous keeps the free-account upsell (back-compat with absent)", () => {
    const html = renderHtml(
      baseReport({ lockedRules: [{ id: "a", name: "X" }], cloudPlan: "anonymous" }),
    );
    expect(html).toContain("free squirrelscan account");
    expect(html).toContain("Get started");
  });
});

describe("DomainStats organic-positions chart (#491)", () => {
  function withStats(positions: Partial<DomainStatsPositions> | null): AuditReport {
    return baseReport({
      domainStats: {
        domain: "github.com",
        capturedAt: "2026-06-16T14:30:00.000Z",
        metrics: {
          backlinks: 1000,
          referringDomains: null,
          referringMainDomains: null,
          referringPages: null,
          dofollow: null,
          rank: null,
          backlinksUpdatedAt: null,
          organicKeywords: 50,
          organicTraffic: null,
          organicImpressions: null,
          positions: positions as DomainStatsPositions | null,
          paidKeywords: null,
          paidTraffic: null,
          paidTrafficCost: null,
        },
      },
    });
  }

  test("renders a static CSS bar chart (no inline 'Organic positions:' text list)", () => {
    const html = renderHtml(
      withStats({ pos1: 5, pos2_3: 12, pos4_10: 30, pos11_20: null, pos21_30: null }),
    );
    expect(html).toContain('class="position-chart"');
    expect(html).toContain('class="position-fill"');
    // Bands present best→worst, with counts.
    expect(html).toContain(">#1<");
    expect(html).toContain(">#4–10<");
    // The old inline text format is gone.
    expect(html).not.toContain("Organic positions: ");
    // Bars are proportional: the largest band (pos4_10 = 30, the max) fills 100%.
    expect(html).toContain("width:100%");
  });

  test("absent/all-null positions render no chart", () => {
    expect(renderHtml(withStats(null))).not.toContain('class="position-chart"');
    expect(
      renderHtml(withStats({ pos1: null, pos2_3: null })),
    ).not.toContain('class="position-chart"');
  });
});
