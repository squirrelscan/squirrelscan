// schema/article — ISO 8601 date validation, issue #1099.
//
// Presence-only checks passed a raw Postgres timestamp
// ("2026-07-16 03:55:00+00") straight through: valid JSON string, so it
// looked "present" even though schema.org requires ISO 8601 (space instead
// of T, truncated "+00" offset). These lock in: malformed dates warn, valid
// ISO 8601 (date-only and Z/offset datetime) pass unchanged, and the switch
// to flattenJsonLdNodes still finds Article schema wrapped in @graph.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { articleSchemaRule } from "../src/schema/article";
import type { ParsedPage, RuleContext } from "../src/types";

function pageCtx(html: string, url = "https://example.com/"): RuleContext {
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
}

function run(ctx: RuleContext): CheckResult[] {
  return articleSchemaRule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

function withSchema(schema: unknown): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(
    schema,
  )}</script></head><body><p>content</p></body></html>`;
}

const BASE_ARTICLE = {
  "@type": "NewsArticle",
  headline: "Headline",
  author: { "@type": "Person", name: "Author" },
};

describe("schema/article — ISO 8601 date validation (#1099)", () => {
  test("raw Postgres timestamp datePublished warns", () => {
    const html = withSchema({
      ...BASE_ARTICLE,
      datePublished: "2026-07-16 03:55:00+00",
      dateModified: "2026-07-16T04:35:34.907Z",
    });
    const dateCheck = check(run(pageCtx(html)), "article-date-format");

    expect(dateCheck?.status).toBe("warn");
    expect(dateCheck?.items?.map((i) => i.id)).toEqual(["datePublished"]);
  });

  test("valid ISO 8601 datetime (Z offset) and date-only pass unchanged", () => {
    const html = withSchema({
      ...BASE_ARTICLE,
      datePublished: "2026-07-16",
      dateModified: "2026-07-16T04:35:34.907Z",
    });
    expect(check(run(pageCtx(html)), "article-date-format")).toBeUndefined();
  });

  test("valid ISO 8601 datetime with ±HH:MM offset passes", () => {
    const html = withSchema({
      ...BASE_ARTICLE,
      datePublished: "2026-07-16T03:55:00+00:00",
    });
    expect(check(run(pageCtx(html)), "article-date-format")).toBeUndefined();
  });

  test("valid ISO 8601 datetime without a UTC offset (local time) passes", () => {
    const html = withSchema({ ...BASE_ARTICLE, datePublished: "2026-07-16T03:55:00" });
    expect(check(run(pageCtx(html)), "article-date-format")).toBeUndefined();
  });

  test("out-of-range month/day/hour components warn", () => {
    const html = withSchema({ ...BASE_ARTICLE, datePublished: "2026-13-40T25:00:00Z" });
    expect(check(run(pageCtx(html)), "article-date-format")?.status).toBe("warn");
  });

  test("impossible calendar date — February 31 — warns despite passing the shape check", () => {
    const html = withSchema({ ...BASE_ARTICLE, datePublished: "2026-02-31" });
    expect(check(run(pageCtx(html)), "article-date-format")?.status).toBe("warn");
  });

  test("impossible calendar date — April 31 (April has 30 days) — warns", () => {
    const html = withSchema({ ...BASE_ARTICLE, datePublished: "2026-04-31" });
    expect(check(run(pageCtx(html)), "article-date-format")?.status).toBe("warn");
  });

  test("impossible calendar date — Feb 29 in a non-leap year (2026) — warns", () => {
    const html = withSchema({ ...BASE_ARTICLE, datePublished: "2026-02-29" });
    expect(check(run(pageCtx(html)), "article-date-format")?.status).toBe("warn");
  });

  test("Feb 29 in a real leap year (2024) passes", () => {
    const html = withSchema({ ...BASE_ARTICLE, datePublished: "2024-02-29" });
    expect(check(run(pageCtx(html)), "article-date-format")).toBeUndefined();
  });

  test("epoch number datePublished warns", () => {
    const html = withSchema({ ...BASE_ARTICLE, datePublished: 1752633300 });
    const dateCheck = check(run(pageCtx(html)), "article-date-format");
    expect(dateCheck?.status).toBe("warn");
    expect(dateCheck?.items?.map((i) => i.id)).toEqual(["datePublished"]);
  });

  test("RFC 2822 datePublished warns", () => {
    const html = withSchema({
      ...BASE_ARTICLE,
      datePublished: "Thu, 16 Jul 2026 03:55:00 GMT",
    });
    expect(check(run(pageCtx(html)), "article-date-format")?.status).toBe("warn");
  });

  test("DD/MM/YYYY datePublished warns", () => {
    const html = withSchema({ ...BASE_ARTICLE, datePublished: "16/07/2026" });
    expect(check(run(pageCtx(html)), "article-date-format")?.status).toBe("warn");
  });

  test("missing datePublished is not double-reported by the date-format check", () => {
    const html = withSchema({
      "@type": "Article",
      headline: "Headline",
      author: { "@type": "Person", name: "Author" },
    });
    const checks = run(pageCtx(html));
    expect(check(checks, "article-required")?.status).toBe("warn");
    expect(check(checks, "article-date-format")).toBeUndefined();
  });

  test("empty string datePublished reports only as missing, not also as malformed", () => {
    const html = withSchema({
      "@type": "Article",
      headline: "Headline",
      author: { "@type": "Person", name: "Author" },
      datePublished: "",
    });
    const checks = run(pageCtx(html));
    expect(check(checks, "article-required")?.status).toBe("warn");
    expect(check(checks, "article-required")?.items?.map((i) => i.id)).toContain("datePublished");
    expect(check(checks, "article-date-format")).toBeUndefined();
  });

  test("@graph-wrapped Article schema is still found and validated (Yoast-style)", () => {
    const html = withSchema({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Site" },
        { ...BASE_ARTICLE, datePublished: "2026-07-16 03:55:00+00" },
      ],
    });
    const dateCheck = check(run(pageCtx(html)), "article-date-format");
    expect(dateCheck?.status).toBe("warn");
  });

  test("multiple Article nodes on a page: the last one wins (matches prior behavior)", () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        ...BASE_ARTICLE,
        datePublished: "2026-01-01",
      })}</script>
      <script type="application/ld+json">${JSON.stringify({
        ...BASE_ARTICLE,
        datePublished: "2026-07-16 03:55:00+00",
      })}</script>
      </head><body><p>content</p></body></html>`;
    const dateCheck = check(run(pageCtx(html)), "article-date-format");
    // The second (last) script's malformed date must be the one evaluated.
    expect(dateCheck?.status).toBe("warn");
  });

  test("finding uses warning severity", () => {
    expect(articleSchemaRule.meta.severity).toBe("warning");
  });

  test("a pretty-printed Article script with internal blank lines is still found when a second script is also present", () => {
    // Regression: re-parsing ctx.parsed.schema.raw (multiple <script> blocks
    // joined with "\n\n") via a whole-raw-then-blank-line-split fallback mis-splits
    // INSIDE a script whose own pretty-printed JSON contains blank lines,
    // silently dropping it. Reading ctx.parsed.schemas.all (parsed per-script,
    // never joined) must not have this failure mode.
    const html = `<html><head>
      <script type="application/ld+json">
      {
        "@type": "NewsArticle",
        "headline": "Headline",

        "author": {"@type": "Person", "name": "Author"},
        "datePublished": "2026-07-16 03:55:00+00"
      }
      </script>
      <script type="application/ld+json">${JSON.stringify({ "@type": "WebSite", name: "Site" })}</script>
      </head><body><p>content</p></body></html>`;
    const checks = run(pageCtx(html));

    expect(check(checks, "article-required")?.status).toBe("pass");
    expect(check(checks, "article-date-format")?.status).toBe("warn");
  });
});
