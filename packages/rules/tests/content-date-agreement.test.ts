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

import { dateAgreementRule, looksLikeDate, matchDate } from "../src/content/date-agreement";
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

  test("reads written dates in other languages", () => {
    const jan8 = Date.UTC(2026, 0, 8);
    expect(matchDate("Publié le 8 janvier 2026")?.ms).toBe(jan8);
    expect(matchDate("Publié le 1er janvier 2026")?.ms).toBe(Date.UTC(2026, 0, 1));
    expect(matchDate("le 8 février 2026")?.ms).toBe(Date.UTC(2026, 1, 8));
    expect(matchDate("8 févr. 2026")?.ms).toBe(Date.UTC(2026, 1, 8));
    expect(matchDate("Veröffentlicht am 8. Januar 2026")?.ms).toBe(jan8);
    expect(matchDate("15. März 2026")?.ms).toBe(Date.UTC(2026, 2, 15));
    expect(matchDate("8 de enero de 2026")?.ms).toBe(jan8);
    expect(matchDate("8 gennaio 2026")?.ms).toBe(jan8);
    expect(matchDate("8 de janeiro de 2026")?.ms).toBe(jan8);
    expect(matchDate("8 januari 2026")?.ms).toBe(jan8);
    expect(matchDate("2026年1月8日")?.ms).toBe(jan8);
    expect(matchDate("2026년 1월 8일")?.ms).toBe(jan8);
    expect(matchDate("2026/01/08")?.ms).toBe(jan8);
  });

  test("a numeric date is read both ways when both are possible", () => {
    // 08/01/2026 is the 8th of January or the 1st of August: both readings are
    // kept so the caller can compare whichever agrees with the schema.
    const ambiguous = matchDate("08/01/2026");
    expect(ambiguous?.ms).toBe(Date.UTC(2026, 0, 8));
    expect(ambiguous?.alternatives).toEqual([Date.UTC(2026, 7, 1)]);

    // Only one reading is a real date once a part is above 12 or above the month's length.
    expect(matchDate("25/12/2026")).toEqual({ text: "25/12/2026", ms: Date.UTC(2026, 11, 25) });
    expect(matchDate("12/25/2026")).toEqual({ text: "12/25/2026", ms: Date.UTC(2026, 11, 25) });
    expect(matchDate("8.1.2026")?.ms).toBe(Date.UTC(2026, 0, 8));
    expect(matchDate("31/04/2026")).toBeNull();
  });

  test("no trailing word boundary is needed: sibling text can run straight on", () => {
    // `textContent` joins sibling elements with nothing, so a date is often
    // followed directly by the next element's first letter.
    expect(matchDate("Published March 12, 2024Read more")?.text).toBe("March 12, 2024");
    expect(matchDate("Published March 12, 2024Read more")?.ms).toBe(Date.UTC(2024, 2, 12));
    expect(matchDate("INPPublished March 12, 2024Caching.")?.ms).toBe(Date.UTC(2024, 2, 12));
    expect(matchDate("12 March 2024Read more")?.ms).toBe(Date.UTC(2024, 2, 12));
    // Still not a date when the year is the start of a longer number.
    expect(matchDate("March 12, 20245")).toBeNull();
  });

  test("a date that is not on the calendar is not one", () => {
    expect(matchDate("February 31, 2026")).toBeNull();
    expect(matchDate("31 avril 2026")).toBeNull();
  });

  test("a run of digits that is not a date is not one", () => {
    expect(matchDate("Order 20240312 shipped")).toBeNull();
    expect(matchDate("no dates here")).toBeNull();
  });
});

describe("looksLikeDate", () => {
  test("is true for dates it can read and for dates it cannot", () => {
    expect(looksLikeDate("March 12, 2024")).toBe(true);
    // Not parseable here, but a reader sees a date.
    expect(looksLikeDate("8 stycznia 2026")).toBe(true);
    expect(looksLikeDate("8 января 2026 г.")).toBe(true);
    expect(looksLikeDate("2026. január 8.")).toBe(true);
    expect(looksLikeDate("8/1/26")).toBe(true);
    expect(looksLikeDate("令和8年1月8日 2026年1月")).toBe(true);
  });

  test("is false for prose and numbers that are not dates", () => {
    expect(looksLikeDate("Caching is the cheapest performance win available.")).toBe(false);
    expect(looksLikeDate("Order 20240312 shipped")).toBe(false);
    expect(looksLikeDate("Version 1.2.34 is out")).toBe(false);
  });

  test("is false for a number, an ordinary word and a year", () => {
    expect(looksLikeDate("3 million 2024")).toBe(false);
    expect(looksLikeDate("5 sites in 2024")).toBe(false);
    expect(looksLikeDate("Top 10 2024")).toBe(false);
    expect(looksLikeDate("Chapter 3 2024")).toBe(false);
    expect(looksLikeDate("2024 Honda 5")).toBe(false);
    expect(looksLikeDate("Over 20 users 2024")).toBe(false);
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

  test("'Data' opening a sentence is not a byline prefix", () => {
    const html = page(
      article("2026-02-10"),
      "<main><article><h1>Interaction to Next Paint</h1>" +
        "<p>Data as of March 12, 2024 shows INP is the metric to watch.</p>" +
        `${PROSE}</article></main>`,
    );

    expect(check(run(html), "byline-vs-schema-date")?.value).not.toBe("March 12, 2024");
  });

  test("'Data:' and 'Datum:' still open a byline", () => {
    const html = page(
      article("2026-02-10"),
      "<main><article><h1>Interaction to Next Paint</h1>" +
        "<p class=\"byline\">Data: February 10, 2026</p>" +
        `${PROSE}</article></main>`,
    );

    expect(check(run(html), "byline-vs-schema-date")?.value).toBe("February 10, 2026");
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

  test("a citation link is not the byline: reverting to textContent would flip this", () => {
    // Differential fixture. "Published" opens a byline-shaped line, so the date
    // inside the anchor WOULD be taken as this page's byline (2024 against a 2026
    // schema date) if the anchor's text were not removed first. The older
    // "Announced <a>" fixture is not byline-shaped either way and could not tell.
    const html = page(
      article("2026-02-10"),
      "<main><article><h1>Interaction to Next Paint</h1>" +
        '<p>Published <a href="https://web.dev/">March 12, 2024</a></p>' +
        `${PROSE}</article></main>`,
    );
    const checks = run(html);

    expect(checks.every((c) => c.status !== "warn")).toBe(true);
    expect(check(checks, "byline-vs-schema-date")).toBeUndefined();
    // The page does print a date, so "shows no date at all" would be wrong too.
    expect(check(checks, "visible-date-missing")).toBeUndefined();
  });

  test("a citation with no space or punctuation before the next element still counts as a date", () => {
    // `textContent` reads this as "Announced March 12, 2024Caching." and the old
    // trailing \b hid the date; deleting the trap fixture's period used to flip
    // it from clean to a visible-date-missing warning.
    const html = page(
      article("2026-02-10"),
      "<main><article><h1>Interaction to Next Paint</h1>" +
        '<p>Announced <a href="https://web.dev/blog/inp-cwv">March 12, 2024</a></p>' +
        `<p>Caching.</p></article></main>`,
    );

    expect(run(html).every((c) => c.status !== "warn")).toBe(true);
  });

  test("a date followed straight by a sibling element is still the visible date", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><p class="byline"><span>Published</span><span>January 8, 2026</span></p>' +
        `<a href="/more">Read more</a>${PROSE}</article></main>`,
    );

    expect(check(run(html), "byline-vs-schema-date")?.status).toBe("pass");
  });

  test.each([
    ["French", "Publié le 8 janvier 2026"],
    ["German", "Veröffentlicht am 8. Januar 2026"],
    ["Spanish", "Publicado el 8 de enero de 2026"],
    ["Japanese", "2026年1月8日"],
    ["Korean", "2026년 1월 8일"],
    ["numeric, day first", "Published on 08/01/2026"],
    ["numeric, month first", "Published on 01/08/2026"],
    ["numeric with dots", "8.1.2026"],
  ])("a %s byline that agrees with the schema date is not reported as missing", (_name, text) => {
    const html = page(
      article("2026-01-08"),
      `<main><article><p class="byline">${text}</p>${PROSE}</article></main>`,
    );
    const checks = run(html);

    expect(checks.every((c) => c.status !== "warn")).toBe(true);
    expect(check(checks, "visible-date-missing")).toBeUndefined();
  });

  test("a non-English byline without byline markup is read from its opening word", () => {
    const html = page(
      article("2026-01-08"),
      `<main><article><h1>Cache</h1><p>Publié le 8 janvier 2026</p>${PROSE}</article></main>`,
    );

    expect(check(run(html), "byline-vs-schema-date")?.status).toBe("pass");
  });

  test("a date in a locale it cannot read stays silent rather than warning", () => {
    // "8 stycznia 2026" (Polish) is a date to the reader but not to the parser.
    // Saying the page shows no date would be false, so say nothing.
    const html = page(
      article("2026-01-08"),
      `<main><article><h1>Cache</h1><p>Opublikowano 8 stycznia 2026</p>${PROSE}</article></main>`,
    );

    expect(run(html).length).toBe(0);
  });

  test("a year in a URL slug that is not a publication date is not reported", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><p class="byline">Published on January 8, 2026</p>' +
        `${PROSE}</article></main>`,
      "Honda Civic review",
    );

    for (const slug of [
      "/reviews/2024-honda-civic-review",
      "/guides/best-caching-headers-of-2024",
      "/posts/web-vitals-2024-edition",
    ]) {
      const checks = run(html, `https://example.com${slug}`);
      expect(check(checks, "url-title-year")).toBeUndefined();
      expect(checks.every((c) => c.status !== "warn")).toBe(true);
    }
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

  test("a non-English byline that disagrees with the schema date warns", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><p class="byline">Publié le 4 novembre 2025</p>' +
        `${PROSE}</article></main>`,
    );
    const warn = check(run(html), "byline-vs-schema-date");

    expect(warn?.status).toBe("warn");
    expect(warn?.value).toBe("4 novembre 2025");
    expect(warn?.details?.["gapDays"]).toBe(65);
  });

  test("a reference number after a Published opener is not read as a byline date", () => {
    const html = page(
      article("2026-03-20"),
      '<main><article><p>Published: ref 3.4.2019 for the archive</p>' +
        `${PROSE}</article></main>`,
    );

    expect(check(run(html), "byline-vs-schema-date")).toBeUndefined();
  });

  test("a numeric byline that matches neither reading of the schema date warns", () => {
    const html = page(
      article("2026-03-20"),
      '<main><article><p class="byline">Published on 08/01/2026</p>' +
        `${PROSE}</article></main>`,
    );

    expect(check(run(html), "byline-vs-schema-date")?.status).toBe("warn");
  });

  test("a dated URL segment and a dated slug still count as the URL's year", () => {
    const html = page(
      article("2026-01-08"),
      '<main><article><p class="byline">Published on January 8, 2026</p>' +
        `${PROSE}</article></main>`,
    );

    for (const path of ["/blog/2024/caching", "/blog/2024-03-12-caching", "/2024/03/caching"]) {
      expect(check(run(html, `https://example.com${path}`), "url-title-year")?.status).toBe("warn");
    }
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
