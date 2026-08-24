// content/date-agreement — the date signals on a page must agree (#108).
//
// content/freshness passes as soon as ANY date signal exists and eeat/content-dates
// reports coverage, so squirrelscan.com's own site passed both while broken in two
// opposite directions: /blog/* showed a 2025 byline against a 2026 schema date, and
// /learn/* emitted Article dates the reader never saw.
//
// The must-not-fire cases below are load-bearing, not decoration: the first version
// of this check inside an internal audit pass produced 14 findings of which 1 was
// real, and both causes (a date read off a sitewide SoftwareApplication node, a
// date-shaped string read out of prose or a citation link) are pinned here.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { dateAgreementRule, matchDate } from "../src/content/date-agreement";
import type { ParsedPage, RuleContext } from "../src/types";

function run(
  html: string,
  url = "https://example.com/blog/post",
  headers: Record<string, string> = {},
): CheckResult[] {
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  return dateAgreementRule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

function page(schema: unknown, body: string, title = "A post about caching"): string {
  const ld = schema
    ? `<script type="application/ld+json">${JSON.stringify(schema)}</script>`
    : "";
  return `<html><head><title>${title}</title>${ld}</head><body>${body}</body></html>`;
}

/** The sitewide node every page of the site carries — NOT a document date. */
const SITEWIDE_APP = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "squirrel",
  datePublished: "2026-01-01",
};

function article(datePublished: string, dateModified?: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "A post about caching",
    datePublished,
    ...(dateModified ? { dateModified } : {}),
  };
}

const PROSE =
  "<p>Caching is the cheapest performance win available to most sites, and the headers " +
  "that drive it are set once and then forgotten for years at a time.</p>";

describe("matchDate", () => {
  test("reads the written forms a byline actually uses", () => {
    expect(matchDate("March 12, 2024")?.ms).toBe(Date.UTC(2024, 2, 12));
    expect(matchDate("Mar 12, 2024")?.ms).toBe(Date.UTC(2024, 2, 12));
    expect(matchDate("12 March 2024")?.ms).toBe(Date.UTC(2024, 2, 12));
    expect(matchDate("2024-03-12")?.ms).toBe(Date.UTC(2024, 2, 12));
    expect(matchDate("2024-03-12T09:30:00Z")?.ms).toBe(Date.UTC(2024, 2, 12));
  });

  test("a written date is read as the calendar day, not as local midnight", () => {
    // Date.parse("March 12, 2024") is LOCAL midnight, which lands on the 11th in
    // UTC for every timezone east of Greenwich — enough to turn an exact match
    // into a one-day disagreement depending on where the audit runs.
    expect(matchDate("March 12, 2024")?.ms).toBe(matchDate("2024-03-12")?.ms);
  });

  test("a run of digits that is not a date is not one", () => {
    expect(matchDate("Order 20240312 shipped")).toBeNull();
    expect(matchDate("no dates here")).toBeNull();
  });
});

describe("content/date-agreement — must not fire", () => {
  test("Article node beside a sitewide SoftwareApplication with a different date", () => {
    // The trap: taking the FIRST datePublished in the document attributed the
    // app's 2026-01-01 release date to every post on the site.
    const html = page(
      [SITEWIDE_APP, article("2025-11-04")],
      `<main><article><p class="byline">Published on November 4, 2025 by Nik</p>${PROSE}</article></main>`,
    );
    const checks = run(html);

    expect(checks.every((c) => c.status !== "warn")).toBe(true);
    expect(check(checks, "byline-vs-schema-date")?.status).toBe("pass");
    // The comparison used the Article node, not the app's release date.
    expect(check(checks, "byline-vs-schema-date")?.details?.["schemaNodeType"]).toBe("Article");
  });

  test("a date in running prose is not a byline", () => {
    const html = page(
      article("2026-02-10"),
      "<main><article><h1>Interaction to Next Paint</h1>" +
        "<p>INP replaced FID on March 12, 2024, and the threshold has not moved since.</p>" +
        `<p class="byline">Published on February 10, 2026</p>${PROSE}</article></main>`,
    );
    const checks = run(html);

    expect(checks.every((c) => c.status !== "warn")).toBe(true);
    expect(check(checks, "byline-vs-schema-date")?.value).toBe("February 10, 2026");
  });

  test("prose without any byline at all is still not read as a byline", () => {
    // Same prose, no byline markup anywhere: the sentence must not become the
    // page's visible date and produce a 2024-vs-2026 disagreement.
    const html = page(
      { ...article("2026-02-10"), "@type": "WebPage" },
      "<main><h1>Interaction to Next Paint</h1>" +
        "<p>INP replaced FID on March 12, 2024, and the threshold has not moved since.</p>" +
        `${PROSE}</main>`,
    );

    expect(run(html).every((c) => c.status !== "warn")).toBe(true);
  });

  test("a date that only exists inside an outbound citation link", () => {
    const html = page(
      article("2026-02-10"),
      "<main><article><h1>Interaction to Next Paint</h1>" +
        '<p>Announced <a href="https://web.dev/blog/inp-cwv">March 12, 2024</a>.</p>' +
        `${PROSE}</article></main>`,
    );
    const checks = run(html);

    // Not a disagreement with the citation's date, and not "no date at all"
    // either: the page does print a date, this rule just declines to read it as
    // the byline. Accusing it of showing none would be its own false positive.
    expect(checks.every((c) => c.status !== "warn")).toBe(true);
    expect(check(checks, "byline-vs-schema-date")).toBeUndefined();
    expect(check(checks, "visible-date-missing")).toBeUndefined();
  });

  test("a long nav above the content does not push the byline out of the zone", () => {
    // With no <article>/<main> the walk starts at <body>; chrome is skipped
    // whole so a menu cannot spend the whole byline zone before the byline.
    const nav = Array.from({ length: 40 }, (_, i) => `<a href="/p/${i}">Section number ${i}</a>`)
      .join("");
    const html = page(
      article("2026-01-08"),
      `<header><nav>${nav}</nav></header>` +
        '<div class="post"><h1>Caching</h1><p class="byline">Published on January 8, 2026</p>' +
        `${PROSE}</div>`,
    );

    expect(check(run(html), "byline-vs-schema-date")?.status).toBe("pass");
  });

  test("a WebPage node with CMS boilerplate dates is not required to show a date", () => {
    // Yoast et al. emit a dated WebPage node on every page of a site, contact
    // form included; demanding a rendered byline there warns on everything.
    const html = page(
      { "@context": "https://schema.org", "@type": "WebPage", datePublished: "2026-02-10" },
      `<main><h1>Contact us</h1>${PROSE}</main>`,
      "Contact us",
    );

    expect(run(html, "https://example.com/contact").length).toBe(0);
  });

  test("an archive listing one date per entry is not a page-level disagreement", () => {
    const items = ["2024-03-12", "2025-06-01", "2026-01-08"]
      .map((d) => `<li><a href="/blog/${d}"><time datetime="${d}">${d}</time></a></li>`)
      .join("");
    const html = page(
      { "@context": "https://schema.org", "@type": "CollectionPage", dateModified: "2026-06-30" },
      `<main><h1>Archive</h1><ul>${items}</ul></main>`,
      "Blog archive",
    );

    expect(run(html, "https://example.com/blog").every((c) => c.status !== "warn")).toBe(true);
  });

  test("a Published date and an Updated date, only one of which matches", () => {
    const html = page(
      article("2025-01-06", "2026-02-10"),
      '<main><article><span class="byline">Published January 6, 2025</span>' +
        '<span class="byline">Updated February 10, 2026</span>' +
        `${PROSE}</article></main>`,
    );

    expect(run(html).every((c) => c.status !== "warn")).toBe(true);
  });

  test("a page with no date signals at all stays silent", () => {
    expect(run(page(null, `<main><h1>Hello</h1>${PROSE}</main>`)).length).toBe(0);
  });

  test("a visible 'Updated' date that matches dateModified rather than datePublished", () => {
    const html = page(
      article("2025-01-06", "2026-02-10"),
      '<main><article><p class="entry-meta">Updated February 10, 2026</p>' +
        `${PROSE}</article></main>`,
    );

    expect(run(html).every((c) => c.status !== "warn")).toBe(true);
  });
});

describe("content/date-agreement — disagreements", () => {
  test("a visible 2025 byline against a 2026 schema date warns, naming both", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><p class="byline">Published on November 4, 2025</p>' +
        `${PROSE}</article></main>`,
    );
    const warn = check(run(html), "byline-vs-schema-date");

    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("November 4, 2025");
    expect(warn?.message).toContain("2026-01-08");
    expect(warn?.value).toBe("November 4, 2025");
    expect(warn?.expected).toBe("2026-01-08");
    expect(warn?.details?.["gapDays"]).toBe(65);
  });

  test("a one-day difference is inside tolerance; two days is not", () => {
    const body = (visible: string) =>
      `<main><article><time datetime="${visible}">${visible}</time>${PROSE}</article></main>`;

    expect(check(run(page(article("2026-01-08"), body("2026-01-09"))), "byline-vs-schema-date")
      ?.status).toBe("pass");
    expect(check(run(page(article("2026-01-08"), body("2026-01-10"))), "byline-vs-schema-date")
      ?.status).toBe("warn");
  });

  test("schema dates with no visible date anywhere warns", () => {
    const html = page(article("2026-01-08", "2026-02-01"), `<main><article>${PROSE}</article></main>`);
    const warn = check(run(html), "visible-date-missing");

    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("no date at all");
    expect(warn?.expected).toBe("2026-01-08");
  });

  test("a <time> element with a datetime but nothing rendered shows the reader nothing", () => {
    const html = page(
      article("2026-01-08"),
      `<main><article><time datetime="2026-01-08"></time>${PROSE}</article></main>`,
    );

    expect(check(run(html), "visible-date-missing")?.status).toBe("warn");
  });

  test("a year in the URL that disagrees with the schema date warns", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><p class="byline">Published on January 8, 2026</p>' +
        `${PROSE}</article></main>`,
    );
    const warn = check(run(html, "https://example.com/blog/2024/03/caching"), "url-title-year");

    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("URL says 2024");
    expect(warn?.value).toBe(2024);
  });

  test("a year in the title that disagrees with the schema date warns", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><p class="byline">Published on January 8, 2026</p>' +
        `${PROSE}</article></main>`,
      "The best caching headers of 2023",
    );
    const warn = check(run(html), "url-title-year");

    expect(warn?.status).toBe("warn");
    expect(warn?.message).toContain("title says 2023");
  });

  test("a URL year that matches the schema date passes", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><p class="byline">Published on January 8, 2026</p>' +
        `${PROSE}</article></main>`,
    );

    expect(check(run(html, "https://example.com/blog/2026/01/caching"), "url-title-year")?.status)
      .toBe("pass");
  });
});

describe("content/date-agreement — schema date source", () => {
  test("a visible date with only a non-document schema date reports the source, never a warning", () => {
    // The /blog/* half of #108: the post's only JSON-LD was the sitewide
    // SoftwareApplication, so there is nothing to disagree WITH.
    const html = page(
      SITEWIDE_APP,
      '<main><article><p class="byline">Published on November 4, 2025</p>' +
        `${PROSE}</article></main>`,
    );
    const checks = run(html);
    const info = check(checks, "schema-date-source");

    expect(checks.every((c) => c.status !== "warn")).toBe(true);
    expect(info?.status).toBe("info");
    expect(info?.message).toContain("SoftwareApplication");
    expect(info?.details?.["schemaDateNodeType"]).toBe("SoftwareApplication");
    expect(info?.details?.["schemaDate"]).toBe("2026-01-01");
  });

  test("a non-document schema date with no visible date says nothing", () => {
    // Otherwise every page of every site carrying a sitewide dated node would
    // report this.
    expect(run(page(SITEWIDE_APP, `<main>${PROSE}</main>`)).length).toBe(0);
  });
});

describe("content/date-agreement — agreement", () => {
  test("visible, schema and Last-Modified dates that agree pass", () => {
    const html = page(
      article("2026-01-08", "2026-01-08"),
      '<main><article><p class="byline">Published on January 8, 2026 by Nik</p>' +
        `${PROSE}</article></main>`,
    );
    const checks = run(html, "https://example.com/blog/caching", {
      "last-modified": "Thu, 08 Jan 2026 10:00:00 GMT",
    });
    const pass = check(checks, "byline-vs-schema-date");

    expect(checks.every((c) => c.status !== "warn")).toBe(true);
    expect(pass?.status).toBe("pass");
    // All four page-side signals are extracted and reported, not just the two
    // that can warn.
    expect(pass?.details?.["visibleDate"]).toBe("January 8, 2026");
    expect(pass?.details?.["schemaDatePublished"]).toBe("2026-01-08");
    expect(pass?.details?.["lastModified"]).toBe("Thu, 08 Jan 2026 10:00:00 GMT");
  });

  test("dates inside a Yoast-style @graph are found", () => {
    const html = page(
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Example", datePublished: "2019-01-01" },
          { "@type": "BlogPosting", headline: "Caching", datePublished: "2026-01-08" },
        ],
      },
      '<main><article><p class="entry-meta">January 8, 2026</p>' + `${PROSE}</article></main>`,
    );
    const pass = check(run(html), "byline-vs-schema-date");

    expect(pass?.status).toBe("pass");
    expect(pass?.details?.["schemaNodeType"]).toBe("BlogPosting");
  });

  test("an Article node wins over the generic WebPage node beside it", () => {
    // Yoast-style graphs emit a dated WebPage ahead of the BlogPosting; the
    // post's own node is the one that speaks for the content, so the byline is
    // compared against it rather than against the page node's build stamp.
    const html = page(
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", dateModified: "2026-05-01" },
          { "@type": "BlogPosting", headline: "Caching", datePublished: "2026-01-08" },
        ],
      },
      '<main><article><p class="byline">Published on January 8, 2026</p>' +
        `${PROSE}</article></main>`,
    );
    const pass = check(run(html), "byline-vs-schema-date");

    expect(pass?.status).toBe("pass");
    expect(pass?.details?.["schemaNodeType"]).toBe("BlogPosting");
  });

  test("a byline rendered as a permalinked <time> still counts as visible", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><a href="/blog/caching"><time datetime="2026-01-08">January 8, 2026</time></a>' +
        `${PROSE}</article></main>`,
    );

    expect(check(run(html), "byline-vs-schema-date")?.status).toBe("pass");
  });

  test("the rule is a page-scope content warning, not an error", () => {
    expect(dateAgreementRule.meta.scope).toBe("page");
    expect(dateAgreementRule.meta.category).toBe("content");
    expect(dateAgreementRule.meta.severity).toBe("warning");
  });
});
