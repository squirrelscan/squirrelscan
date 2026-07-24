// eeat author-byline & content-dates — visible HTML markup detection.
//
// Regression coverage for issue #122: `eeat/author-byline` and
// `eeat/content-dates` only read JSON-LD schema, so they missed visible markup —
// Kadence-theme hCard bylines (`.author.vcard .fn`, `rel="author"`) and
// entry-meta `<time>` (`time.entry-date.published`, `[itemprop="datePublished"]`).
// Also covers Yoast `@graph` Article schema whose `author` is an `@id`
// reference to a separate Person node, and false-positive guards so org-level
// metadata (footer copyright, header owner link) on every page is NOT treated
// as a per-article byline/date.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { authorBylineRule } from "../src/eeat/author-byline";
import { contentDatesRule } from "../src/eeat/content-dates";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

// ── Helpers ─────────────────────────────────────────────────────────

function siteCtx(pagesHtml: { url: string; html: string }[]): RuleContext {
  const pages: SiteData["pages"] = pagesHtml.map((p) => ({
    url: p.url,
    statusCode: 200,
    parsed: parsePage(p.html, p.url),
  }));
  return {
    page: {
      url: pages[0]?.url ?? "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: pages[0]?.parsed ?? ({} as ParsedPage),
    site: {
      baseUrl: "https://example.com",
      pages,
      robotsTxt: null,
      sitemaps: null,
    },
    options: {},
  };
}

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  return rule.run(ctx).checks as CheckResult[];
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

// A WordPress/Kadence-style article: hCard byline + entry-meta <time>, NO JSON-LD.
function kadencePost(url: string): { url: string; html: string } {
  return {
    url,
    html: `<html><body>
      <article class="post type-post">
        <header class="entry-header">
          <h1 class="entry-title">A Post</h1>
          <div class="entry-meta entry-meta-divider-dot">
            <span class="posted-by author vcard">
              <a class="url fn n" href="/author/jane/" rel="author">Jane Doe</a>
            </span>
            <span class="posted-on">
              <time class="entry-date published" itemprop="datePublished" datetime="2024-03-10T08:00:00+00:00">March 10, 2024</time>
              <time class="updated" itemprop="dateModified" datetime="2024-04-01T09:00:00+00:00">April 1, 2024</time>
            </span>
          </div>
        </header>
        <div class="entry-content"><p>Body content.</p></div>
      </article>
    </body></html>`,
  };
}

// Yoast-style @graph: Article.author is an @id ref to a separate Person node.
function yoastPost(
  url: string,
  authorName = "Jane Doe"
): { url: string; html: string } {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        author: { "@id": `${url}#/schema/person/abc` },
        datePublished: "2024-03-10T08:00:00+00:00",
        dateModified: "2024-04-01T09:00:00+00:00",
      },
      {
        "@type": "Person",
        "@id": `${url}#/schema/person/abc`,
        name: authorName,
      },
    ],
  };
  return {
    url,
    html: `<html><head><script type="application/ld+json">${JSON.stringify(
      graph
    )}</script></head><body><article class="post"><p>Body.</p></article></body></html>`,
  };
}

// ── Parser-level visible-meta extraction ────────────────────────────

describe("parser — visible author/date extraction", () => {
  test("extracts hCard author + entry-meta dates", () => {
    const p = parsePage(kadencePost("https://ex.com/blog/post").html, "https://ex.com/blog/post");
    expect(p.visibleAuthor).toBe("Jane Doe");
    expect(p.visibleDatePublished).toBe("2024-03-10T08:00:00+00:00");
    expect(p.visibleDateModified).toBe("2024-04-01T09:00:00+00:00");
  });

  test("generic .author byline inside article", () => {
    const html = `<html><body><article><span class="author">Sam Writer</span><p>x</p></article></body></html>`;
    const p = parsePage(html, "https://ex.com/post");
    expect(p.visibleAuthor).toBe("Sam Writer");
  });

  test("does NOT extract from footer/header chrome", () => {
    const html = `<html><body>
      <header role="banner"><a rel="author" href="/owner">Acme Corp</a></header>
      <main><p>Landing page copy.</p></main>
      <footer role="contentinfo"><span class="author">Admin</span><time class="published" datetime="2020-01-01">2020</time></footer>
    </body></html>`;
    const p = parsePage(html, "https://ex.com/");
    expect(p.visibleAuthor).toBeNull();
    expect(p.visibleDatePublished).toBeNull();
  });

  test("does NOT extract when no article/content container present", () => {
    const html = `<html><body><div class="author">Someone</div><time class="published" datetime="2024-01-01">2024</time></body></html>`;
    const p = parsePage(html, "https://ex.com/");
    expect(p.visibleAuthor).toBeNull();
    expect(p.visibleDatePublished).toBeNull();
  });

  test("ignores org-noise byline names (Admin / staff)", () => {
    const html = `<html><body><article><span class="author vcard"><span class="fn">Administrator</span></span><p>x</p></article></body></html>`;
    const p = parsePage(html, "https://ex.com/post");
    expect(p.visibleAuthor).toBeNull();
  });

  test("does NOT pick up a testimonial .author inside <main> (homepage)", () => {
    // `<main>` alone is not an article container — a customer testimonial byline
    // on a marketing homepage must not be treated as content authorship.
    const html = `<html><body><main>
      <h1>Welcome</h1>
      <div class="testimonial"><blockquote>Great!</blockquote><span class="author">Happy Customer</span></div>
    </main></body></html>`;
    const p = parsePage(html, "https://ex.com/");
    expect(p.visibleAuthor).toBeNull();
  });

  test("does NOT pick up a header rel=author owner link (no role attr)", () => {
    const html = `<html><body>
      <header><a rel="author" href="/owner">Acme Corp</a></header>
      <main><p>Marketing copy.</p></main>
    </body></html>`;
    const p = parsePage(html, "https://ex.com/");
    expect(p.visibleAuthor).toBeNull();
  });

  test("does NOT pick up a comment author (#comments thread by id)", () => {
    const html = `<html><body><article class="post">
      <header class="entry-header"><p>No byline here.</p></header>
      <div id="comments">
        <div class="comment"><span class="author vcard"><span class="fn">Commenter Carl</span></span>
          <time class="published" datetime="2024-05-01">May 1</time></div>
      </div>
    </article></body></html>`;
    const p = parsePage(html, "https://ex.com/post");
    expect(p.visibleAuthor).toBeNull();
    expect(p.visibleDatePublished).toBeNull();
  });

  test("STILL detects byline on a review article (review token not over-broad)", () => {
    // A review *article* legitimately has a byline — `category-review` etc. must
    // not suppress detection.
    const html = `<html><body><article class="post category-review">
      <header class="entry-header">
        <span class="author vcard"><a class="url fn n" rel="author" href="/a/r">Rita Reviewer</a></span>
      </header><div class="entry-content"><p>My review.</p></div>
    </article></body></html>`;
    const p = parsePage(html, "https://ex.com/reviews/widget");
    expect(p.visibleAuthor).toBe("Rita Reviewer");
  });
});

// ── Schema @id reference resolution ─────────────────────────────────

describe("parser — Yoast @graph @id author resolution", () => {
  test("resolves author via @id reference", () => {
    const p = parsePage(yoastPost("https://ex.com/post").html, "https://ex.com/post");
    expect(p.author?.name).toBe("Jane Doe");
  });

  test("resolves the *referenced* person, not the first Person node", () => {
    // Two Person nodes (editor + author); Article references only the author.
    const url = "https://ex.com/post";
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Person", "@id": `${url}#/person/editor`, name: "Editor Ed" },
        {
          "@type": "Article",
          author: { "@id": `${url}#/person/jane` },
          datePublished: "2024-03-10",
        },
        { "@type": "Person", "@id": `${url}#/person/jane`, name: "Jane Doe" },
      ],
    };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(
      graph
    )}</script></head><body><article><p>b</p></article></body></html>`;
    const p = parsePage(html, url);
    expect(p.author?.name).toBe("Jane Doe");
  });

  test("resolves to a later duplicate @id node that carries the name", () => {
    // A nameless stub Person with the same @id appears before the full node;
    // first-wins would resolve the author to null.
    const url = "https://ex.com/post";
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Person", "@id": `${url}#/person/x` },
        { "@type": "Article", author: { "@id": `${url}#/person/x` } },
        { "@type": "Person", "@id": `${url}#/person/x`, name: "Jane Doe" },
      ],
    };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(
      graph
    )}</script></head><body><article><p>b</p></article></body></html>`;
    const p = parsePage(html, url);
    expect(p.author?.name).toBe("Jane Doe");
  });

  test("inline author name takes precedence over @id ref", () => {
    const url = "https://ex.com/post";
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Article",
          author: { "@id": `${url}#/person/x`, name: "Inline Name" },
        },
        { "@type": "Person", "@id": `${url}#/person/x`, name: "Referenced Name" },
      ],
    };
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(
      graph
    )}</script></head><body><article><p>b</p></article></body></html>`;
    const p = parsePage(html, url);
    expect(p.author?.name).toBe("Inline Name");
  });
});

// ── eeat/author-byline rule ─────────────────────────────────────────

describe("eeat/author-byline — visible markup", () => {
  test("detects hCard byline on Kadence post (no JSON-LD)", () => {
    const checks = run(authorBylineRule, siteCtx([kadencePost("https://ex.com/blog/post")]));
    expect(check(checks, "author-byline")?.status).toBe("pass");
  });

  test("detects author via Yoast @graph @id ref", () => {
    const checks = run(authorBylineRule, siteCtx([yoastPost("https://ex.com/blog/post")]));
    expect(check(checks, "author-byline")?.status).toBe("pass");
  });

  test("counts a visible-byline page as content even on a large site", () => {
    // 6+ pages forces the content-page gate; the byline page must still count.
    const pages = [
      { url: "https://ex.com/", html: "<html><body><p>home</p></body></html>" },
      { url: "https://ex.com/a", html: "<html><body><p>a</p></body></html>" },
      { url: "https://ex.com/b", html: "<html><body><p>b</p></body></html>" },
      { url: "https://ex.com/c", html: "<html><body><p>c</p></body></html>" },
      { url: "https://ex.com/d", html: "<html><body><p>d</p></body></html>" },
      { url: "https://ex.com/e", html: "<html><body><p>e</p></body></html>" },
      kadencePost("https://ex.com/the-post"),
    ];
    const checks = run(authorBylineRule, siteCtx(pages));
    // Exactly one content page (the byline post) with an author → 100%.
    expect(check(checks, "author-byline")?.status).toBe("pass");
  });

  test("does NOT pass when only org-level chrome carries a byline", () => {
    const orgPages = [
      {
        url: "https://ex.com/blog/post",
        html: `<html><body>
          <header role="banner"><a rel="author" href="/owner">Acme</a></header>
          <article><p>Just body text, no byline.</p></article>
          <footer role="contentinfo"><span class="author">Admin</span></footer>
        </body></html>`,
      },
    ];
    const checks = run(authorBylineRule, siteCtx(orgPages));
    expect(check(checks, "author-byline")?.status).toBe("warn");
  });
});

// ── eeat/content-dates rule ─────────────────────────────────────────

describe("eeat/content-dates — visible markup", () => {
  test("detects entry-meta <time> dates on Kadence post (no JSON-LD)", () => {
    const checks = run(contentDatesRule, siteCtx([kadencePost("https://ex.com/blog/post")]));
    expect(check(checks, "date-published")?.status).toBe("pass");
    expect(check(checks, "date-modified")?.status).toBe("pass");
  });

  test("detects dates via Yoast @graph Article schema", () => {
    const checks = run(contentDatesRule, siteCtx([yoastPost("https://ex.com/blog/post")]));
    expect(check(checks, "date-published")?.status).toBe("pass");
  });

  test("counts a visible-date page as content even on a large site", () => {
    const pages = [
      { url: "https://ex.com/", html: "<html><body><p>home</p></body></html>" },
      { url: "https://ex.com/a", html: "<html><body><p>a</p></body></html>" },
      { url: "https://ex.com/b", html: "<html><body><p>b</p></body></html>" },
      { url: "https://ex.com/c", html: "<html><body><p>c</p></body></html>" },
      { url: "https://ex.com/d", html: "<html><body><p>d</p></body></html>" },
      { url: "https://ex.com/e", html: "<html><body><p>e</p></body></html>" },
      kadencePost("https://ex.com/the-post"),
    ];
    const checks = run(contentDatesRule, siteCtx(pages));
    expect(check(checks, "date-published")?.status).toBe("pass");
  });

  test("does NOT count footer copyright date as datePublished", () => {
    const pages = [
      {
        url: "https://ex.com/blog/post",
        html: `<html><body>
          <article><p>Body text without a date.</p></article>
          <footer role="contentinfo"><time class="published" datetime="2020-01-01">© 2020</time></footer>
        </body></html>`,
      },
    ];
    const checks = run(contentDatesRule, siteCtx(pages));
    expect(check(checks, "date-published")?.status).toBe("warn");
  });
});

// ── Combined Kadence + Yoast site repro (issue #122) ────────────────

describe("Kadence/Yoast site — issue #122 repro", () => {
  // A real site has non-content pages (home, about, products); the >5-page gate
  // filters those out so only the two posts are scored. Both posts must be
  // detected — one via visible markup, one via @graph schema.
  const nonContent = (n: number) => ({
    url: `https://helder-ai.nl/p${n}`,
    html: "<html><body><p>page</p></body></html>",
  });
  const site = siteCtx([
    { url: "https://helder-ai.nl/", html: "<html><body><p>home</p></body></html>" },
    nonContent(1),
    nonContent(2),
    nonContent(3),
    nonContent(4),
    nonContent(5),
    kadencePost("https://helder-ai.nl/visible-post"),
    yoastPost("https://helder-ai.nl/schema-post", "Bob Author"),
  ]);

  test("author detected across visible and @graph posts", () => {
    const c = check(run(authorBylineRule, site), "author-byline");
    expect(c?.status).toBe("pass");
    expect(c?.value).toBe("2/2 pages");
  });

  test("dates detected across visible and @graph posts", () => {
    expect(check(run(contentDatesRule, site), "date-published")?.status).toBe("pass");
  });
});
