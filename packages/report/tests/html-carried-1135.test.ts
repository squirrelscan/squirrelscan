// #1135/#1136 — the public HTML report must surface carried-forward
// provenance (badges, rollups, mixed-note) and keep long affected-page lists
// collapsible + copyable, not just correct in the underlying grouping data.

import { describe, expect, test } from "bun:test";

import type { AuditReport, ReportRuleResult } from "../src/types";
import { renderHtml } from "../src/output/html";

function baseReport(ruleResults: Record<string, ReportRuleResult>): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 10,
    passed: 5,
    warnings: 1,
    failed: 0,
    ruleResults,
  };
}

function rule(id: string, checks: ReportRuleResult["checks"]): ReportRuleResult {
  return {
    meta: {
      id,
      name: id,
      description: "desc",
      category: "legal",
      scope: "page",
      severity: "warning",
      weight: 5,
    },
    checks,
  };
}

describe("renderHtml carried-forward provenance (#1135/#1136)", () => {
  test("a fully carried check gets the 'carried' rule badge + not-re-checked label", () => {
    const html = renderHtml(
      baseReport({
        "legal/cookie-consent": rule("legal/cookie-consent", [
          {
            name: "cc",
            status: "warn",
            message: "no consent banner",
            pageUrl: "https://example.com/a",
            provenance: "carried",
            lastSeenAt: Date.now() - 3 * 86_400_000,
          },
        ]),
      }),
    );
    expect(html).toContain('class="carried-badge"');
    expect(html).toContain("Not re-checked this run");
    expect(html).toContain("3 days ago");
  });

  test("a partially carried rule gets the N-of-M rollup, not the full-carry badge", () => {
    const html = renderHtml(
      baseReport({
        "legal/cookie-consent": rule("legal/cookie-consent", [
          {
            name: "cc",
            status: "warn",
            message: "no consent banner",
            pageUrl: "https://example.com/a",
            provenance: "carried",
            lastSeenAt: 1,
          },
          {
            name: "cc",
            status: "warn",
            message: "no consent banner (variant)",
            pageUrl: "https://example.com/b",
            provenance: "fresh",
          },
        ]),
      }),
    );
    expect(html).toContain("1 of 2 pages carried from previous crawls.");
    expect(html).not.toContain('class="carried-badge"');
  });

  test("mixedProvenanceNote renders: clean everywhere checked, red only from carried pages", () => {
    const checks: ReportRuleResult["checks"] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        name: "cc",
        status: "pass" as const,
        message: "ok",
        pageUrl: `https://example.com/fresh-${i}`,
      })),
      {
        name: "cc",
        status: "warn" as const,
        message: "no consent banner",
        pageUrl: "https://example.com/carried",
        provenance: "carried" as const,
        lastSeenAt: 1,
      },
    ];
    const html = renderHtml(baseReport({ "legal/cookie-consent": rule("legal/cookie-consent", checks) }));
    expect(html).toContain("Fixed on all 5 pages checked this run; 1 page pending re-check.");
  });

  test("a long affected-pages list caps inline and offers a 'show all' + copy textarea", () => {
    const pages = Array.from({ length: 60 }, (_, i) => `https://example.com/p${i}`);
    const html = renderHtml(
      baseReport({
        "images/alt-text": rule("images/alt-text", [
          {
            name: "alt",
            status: "warn",
            message: "missing alt",
            pages,
            details: { aggregated: true, occurrences: 60 },
          },
        ]),
      }),
    );
    expect(html).toContain("+10 more — show all");
    expect(html).toContain("Copy as plain text");
    expect(html).toContain("<textarea");
    // All 60 URLs are present somewhere (inline + nested "show all").
    for (const p of pages) expect(html).toContain(p);
  });

  test("a short affected-pages list has no copy textarea (nothing worth copying)", () => {
    const html = renderHtml(
      baseReport({
        "images/alt-text": rule("images/alt-text", [
          { name: "alt", status: "warn", message: "missing alt", pageUrl: "https://example.com/a" },
        ]),
      }),
    );
    expect(html).not.toContain("Copy as plain text");
  });

  // #1136 codex review (round 2): a slice-only "cap" that still embeds every
  // overflow URL in a nested details AND duplicates the whole list again in
  // the copy textarea is not actually a cap — a check with thousands of
  // affected pages would blow up a PUBLIC report's HTML. This must stay
  // bounded regardless of how large the underlying check is.
  test("a check with 1,000+ affected pages stays bounded (hard cap, disclosed, no unbounded duplication)", () => {
    const pages = Array.from({ length: 1_043 }, (_, i) => `https://example.com/p${i}`);
    const html = renderHtml(
      baseReport({
        "images/alt-text": rule("images/alt-text", [
          {
            name: "alt",
            status: "warn",
            message: "missing alt",
            pages,
            details: { aggregated: true, occurrences: 1_043 },
          },
        ]),
      }),
    );
    // Truncation is disclosed with the real total, never silently dropped.
    expect(html).toContain("Showing 200 of 1,043 affected pages.");
    expect(html).toContain("Copy as plain text (first 200)");
    // Only the first 200 URLs ever get materialized — as an href AND as
    // plain text in the copy textarea, so each page URL appears at most
    // twice. Page #250 (well past the cap) must not appear anywhere.
    expect(html).not.toContain("https://example.com/p250");
    const occurrencesOfP0 = html.split("https://example.com/p0\"").length - 1; // href="...p0"
    expect(occurrencesOfP0).toBe(1);
    // Bound the total count of materialized page-URL occurrences: 200 as
    // hrefs + 200 as textarea plain text = 400, not ~2,086 (1,043 x 2).
    const totalUrlOccurrences = (html.match(/https:\/\/example\.com\/p\d+/g) ?? []).length;
    expect(totalUrlOccurrences).toBeLessThanOrEqual(400);
    expect(totalUrlOccurrences).toBeGreaterThan(200); // sanity: not over-truncated either
  });

  // #1136 codex review (round 2): a site-scope check (duplicate-title,
  // blocked-links, sitemap-*) stores its affected pages ONLY on
  // items[].sourcePages, not check.pages — before this fix such a check got
  // NO expand/copy affordance, just a 3-item preview with a dead "+N more".
  test("a site-scope check (pages only via item.sourcePages) gets the full PagesList affordance", () => {
    const sourcePages = Array.from({ length: 12 }, (_, i) => `https://example.com/dup-${i}`);
    const html = renderHtml(
      baseReport({
        "seo/duplicate-title": rule("seo/duplicate-title", [
          {
            name: "duplicate-title",
            status: "warn",
            message: "Duplicate title across pages",
            // No `pages`/`pageUrl` at all — pure site-scope, case 2 (resource +
            // sourcePages) per affected-pages.ts.
            items: [{ id: "Home | Example", sourcePages, label: "Home | Example" }],
          },
        ]),
      }),
    );
    // The rule/check now reports the real affected-page count...
    expect(html).toContain("12 pages affected");
    // ...as clickable links (not just the old 3-item dead-end preview)...
    for (const p of sourcePages) expect(html).toContain(`href="${p}"`);
    // ...with expand/copy affordance, and the redundant preview note now
    // points at the real list instead of dead-ending.
    expect(html).toContain("Copy as plain text");
    expect(html).toContain("more (see full list above)");
  });

  test("an item that IS a page (no sourcePages) isn't listed twice (PagesList + items block)", () => {
    const html = renderHtml(
      baseReport({
        "sitemap/coverage": rule("sitemap/coverage", [
          {
            name: "sitemap-4xx",
            status: "fail",
            message: "Sitemap URL returns 4xx",
            items: [{ id: "https://example.com/gone" }],
          },
        ]),
      }),
    );
    // Covered once via the unified PagesList...
    expect(html).toContain("1 page affected");
    const linkOccurrences = html.split('href="https://example.com/gone"').length - 1;
    expect(linkOccurrences).toBe(1);
    // ...and the (now fully redundant) items block is suppressed entirely.
    expect(html).not.toContain("1 item");
  });

  // #1136 review round 3: a URL-id item with an EXPLICIT empty sourcePages
  // (case 2 in affected-pages.ts — an unattributed resource, deliberately
  // contributes 0 pages) is NOT the same as an item with no sourcePages key
  // at all (case 3 — the item IS the page). Treating them the same would
  // drop the item from BOTH the pages list (0 pages either way) AND the
  // items block, silently losing data.
  test("a URL-id item with sourcePages: [] is NOT filtered as redundant (stays visible, contributes 0 pages)", () => {
    const html = renderHtml(
      baseReport({
        "seo/blocked-links": rule("seo/blocked-links", [
          {
            name: "blocked-resource",
            status: "warn",
            message: "Resource blocked, no known referring page",
            items: [{ id: "https://cdn.example.com/blocked.js", sourcePages: [] }],
          },
        ]),
      }),
    );
    // Contributes 0 pages (an unattributed resource is not itself a page) —
    // PagesList must not render for this check.
    expect(html).not.toContain("page affected");
    // But the item itself must still be visible with its own identity.
    expect(html).toContain("1 item");
    expect(html).toContain('href="https://cdn.example.com/blocked.js"');
  });
});
