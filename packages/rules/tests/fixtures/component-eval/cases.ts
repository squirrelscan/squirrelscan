// Synthetic case corpus for the repo#2307 component-aware findings evaluation.
//
// Every page is an HTML string authored for this evaluation: no real site
// content, no personal data. Labels are HUMAN ground truth, written here by
// reasoning about what repair each faulty element needs. They are never
// derived from the grouping code, which is the thing under evaluation.
//
// A label names one (page, rule, element locator) observation and the real fix
// it needs (`fixKey`). Two observations share a fixKey exactly when one edit to
// one template, component or slot repairs both.

export const EVAL_ORIGIN = "https://eval.example";
/** Pinned so stale-copyright verdicts do not change on 1 January. */
export const EVAL_CURRENT_YEAR = 2026;

export type EvalRuleId = "a11y/link-text" | "content/stale-copyright";

export interface EvalPage {
  /** Path on EVAL_ORIGIN. */
  path: string;
  /** Inner body HTML. */
  html: string;
}

export interface EvalLabel {
  page: string;
  rule: EvalRuleId;
  /** `element.locator` the rule reports for the faulty element. */
  locator: string;
  /**
   * The region nesting the rule reports (`region.nestedIn`). Locators are
   * relative to the region, so an article header and the site header both read
   * `header:1>header>a:1`; the nesting tells them apart.
   */
  nestedIn: string;
  /** The real fix this element needs. Same string, same fix. */
  fixKey: string;
  /**
   * True when the defect sits in a shared site region and the evaluation
   * expects every observation with this fixKey in ONE observed group.
   */
  expectGrouped: boolean;
  /**
   * True when the rule is expected to judge this element as observed
   * component evidence. False for content-nested, landmark-less and main
   * content elements: the rule must stay uncertain about them.
   */
  expectObserved: boolean;
}

export interface EvalCase {
  id: string;
  /** Which item of the issue's evaluation plan this case covers. */
  plan: string;
  title: string;
  pages: EvalPage[];
  labels: EvalLabel[];
  /**
   * Legacy report: the stored evidence is stripped before grouping, as if the
   * report predates component evidence.
   */
  legacy?: boolean;
  /** Regression expectations authored with the case (see the record). */
  expect: {
    /** Observed-attribution groups. */
    observedGroups: number;
    /** All fix groups, including repeated-subtree promotions. */
    afterGroups: number;
    rollups: number;
    /**
     * Golden for AC6: every warn or fail check the rules produce for the case,
     * per rule, as sorted `[path, status, message, itemsJson]` rows. Pinned
     * from a run and checked by hand against each fixture (one row per page
     * with a defect; the message counts that page's generic links; items name
     * the distinct link texts). Pages with no defect have no row.
     */
    detections: Partial<Record<EvalRuleId, Array<[string, string, string, string]>>>;
  };
  /** What this case demonstrates and why the labels are right. */
  note: string;
}

const NAV = '<nav><a href="/">Home</a><a href="/about">About</a><a href="/docs">Docs</a></nav>';

/** Three unrelated page layouts around different main content. */
function layout(kind: "plain" | "sidebar" | "article" | "bare", title: string, extra = ""): string {
  switch (kind) {
    case "plain":
      return `<header><a href="/">Eval Co</a></header><main><h1>${title}</h1><p>Plain page body for ${title}.</p>${extra}</main>`;
    case "sidebar":
      return `<div class="app"><aside><a href="/docs/start">Start guide</a></aside><main><h1>${title}</h1><p>Docs page body for ${title}.</p>${extra}</main></div>`;
    case "article":
      return `<main><article><h1>${title}</h1><p>Long form body for ${title}.</p>${extra}</article></main>`;
    case "bare":
      return `<main><h1>${title}</h1><p>Minimal body for ${title}.</p>${extra}</main>`;
  }
}

/** The shared footer: current year, so only its generic links are defects. */
function footer(links: string, year = EVAL_CURRENT_YEAR, extra = ""): string {
  return `<footer class="site-footer">${NAV}${extra}<p>&copy; ${year} Eval Co</p>${links}</footer>`;
}

const LEARN = '<a href="/pricing">Learn more</a>';
const CLICK = '<a href="/contact">Click here</a>';

const fixed = (
  page: string,
  rule: EvalRuleId,
  locator: string,
  fixKey: string,
  grouped: boolean,
  observed = true,
  nestedIn = "none",
): EvalLabel => ({
  page,
  rule,
  locator,
  nestedIn,
  fixKey,
  expectGrouped: grouped,
  expectObserved: observed,
});

const LT: EvalRuleId = "a11y/link-text";
const SC: EvalRuleId = "content/stale-copyright";

// Locator of the third footer link: the nav holds three links, then the fault.
const FOOTER_LINK = "footer:1>footer>a:1";

export const EVAL_CASES: EvalCase[] = [
  {
    id: "identical-footer-across-layouts",
    plan: "1. identical footer across different routes and layouts",
    title: "One footer, four layouts",
    pages: [
      { path: "/", html: layout("plain", "Home") + footer(LEARN) },
      { path: "/blog/post", html: layout("article", "A post") + footer(LEARN) },
      { path: "/docs/x", html: layout("sidebar", "Docs x") + footer(LEARN) },
      { path: "/landing", html: layout("bare", "Landing") + footer(LEARN) },
    ],
    labels: ["/", "/blog/post", "/docs/x", "/landing"].map((p) =>
      fixed(p, LT, FOOTER_LINK, "footer-learn-more", true),
    ),
    expect: {
      observedGroups: 1,
      afterGroups: 1,
      rollups: 1,
      detections: {
        "a11y/link-text": [
          ["/", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/blog/post", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/docs/x", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/landing", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
        ],
      },
    },
    note: "The footer template is one file, so one edit fixes the link on all four pages whatever wraps their main content.",
  },
  {
    id: "different-footer-variants",
    plan: "2. different footer variants stay separate",
    title: "Two footer templates carrying the same bad link",
    pages: [
      { path: "/", html: layout("plain", "Home") + footer(LEARN) },
      { path: "/a", html: layout("plain", "A") + footer(LEARN) },
      { path: "/b", html: layout("plain", "B") + footer(LEARN) },
      {
        path: "/shop",
        html:
          layout("plain", "Shop") +
          footer(LEARN, EVAL_CURRENT_YEAR, '<section class="social"><a href="/x">Social</a></section>'),
      },
      {
        path: "/shop/cart",
        html:
          layout("plain", "Cart") +
          footer(LEARN, EVAL_CURRENT_YEAR, '<section class="social"><a href="/x">Social</a></section>'),
      },
    ],
    labels: [
      ...["/", "/a", "/b"].map((p) => fixed(p, LT, FOOTER_LINK, "footer-main-learn-more", true)),
      ...["/shop", "/shop/cart"].map((p) => fixed(p, LT, FOOTER_LINK, "footer-shop-learn-more", true)),
    ],
    expect: {
      observedGroups: 2,
      afterGroups: 2,
      rollups: 2,
      detections: {
        "a11y/link-text": [
          ["/", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/a", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/b", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/shop", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/shop/cart", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
        ],
      },
    },
    note: "The shop footer is a different template (extra social section), so repairing the main footer does not repair it: two fixes, two groups.",
  },
  {
    id: "same-text-different-locations",
    plan: "3. same generic link text at different locations and destinations",
    title: "'Learn more' in four unrelated places",
    pages: [
      { path: "/a", html: layout("plain", "A") + footer(LEARN) },
      {
        path: "/b",
        html: `<header>${NAV}<a href="/docs">Learn more</a></header><main><h1>B</h1><p>Body.</p></main>`,
      },
      {
        path: "/c",
        html: `<div class="app"><aside><a href="/blog">Learn more</a></aside><main><h1>C</h1><p>Body.</p></main></div>`,
      },
      { path: "/d", html: layout("plain", "D") + footer('<a href="/docs">Learn more</a>') },
    ],
    labels: [
      fixed("/a", LT, FOOTER_LINK, "a-footer-pricing", false),
      fixed("/b", LT, "header:1>header>a:1", "b-header-docs", false),
      fixed("/c", LT, "html>body:1>div:1>aside:1>a:1", "c-aside-blog", false, false, "unknown"),
      fixed("/d", LT, FOOTER_LINK, "d-footer-docs", false),
    ],
    expect: {
      observedGroups: 3,
      afterGroups: 3,
      rollups: 3,
      detections: {
        "a11y/link-text": [
          ["/a", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/b", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/c", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/d", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
        ],
      },
    },
    note: "Same words, but different regions or different destinations. Each link is its own edit: the footer link on /a points at pricing, the one on /d at docs.",
  },
  {
    id: "two-faulty-elements-in-one-footer",
    plan: "4. multiple faulty elements in one component",
    title: "One footer, two bad links",
    pages: [
      { path: "/", html: layout("plain", "Home") + footer(LEARN + CLICK) },
      { path: "/blog/post", html: layout("article", "A post") + footer(LEARN + CLICK) },
      { path: "/docs/x", html: layout("sidebar", "Docs x") + footer(LEARN + CLICK) },
    ],
    labels: ["/", "/blog/post", "/docs/x"].flatMap((p) => [
      fixed(p, LT, "footer:1>footer>a:1", "footer-learn-more", true),
      fixed(p, LT, "footer:1>footer>a:2", "footer-click-here", true),
    ]),
    expect: {
      observedGroups: 2,
      afterGroups: 2,
      rollups: 1,
      detections: {
        "a11y/link-text": [
          ["/", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"},{\"id\":\"click here\"}]"],
          ["/blog/post", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"},{\"id\":\"click here\"}]"],
          ["/docs/x", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"},{\"id\":\"click here\"}]"],
        ],
      },
    },
    note: "Two different elements need two different edits, so they are two groups. They sit in the same block on the same pages, so the rollup may present them as one line; the groups themselves stay apart.",
  },
  {
    id: "repeated-cards-with-differing-data",
    plan: "5. repeated cards with differing data",
    title: "Post cards in main, each 'Read more' to a different post",
    pages: [1, 2, 3, 4].map((n) => ({
      path: `/blog/page-${n}`,
      html:
        layout(
          "plain",
          `Blog page ${n}`,
          [1, 2, 3]
            .map(
              (k) =>
                `<div class="card"><h2>Post ${n}-${k}</h2><p>Teaser text for post ${n}-${k}.</p><a href="/blog/post-${n}-${k}">Read more</a></div>`,
            )
            .join(""),
        ) + footer(""),
    })),
    labels: [1, 2, 3, 4].flatMap((n) =>
      [1, 2, 3].map((k) => ({
        page: `/blog/page-${n}`,
        rule: LT,
        locator: `main:1>main>div:${k}>a:1`,
        nestedIn: "none",
        // One card template renders every card with per-post data, so one
        // template edit (name the post in the link text) repairs all twelve.
        // The rule cannot know that from a single page, so it is not observed
        // evidence: the label says so (expectObserved false).
        fixKey: "post-card-template-read-more",
        expectGrouped: false,
        expectObserved: false,
      })),
    ),
    expect: {
      observedGroups: 0,
      afterGroups: 1,
      rollups: 1,
      detections: {
        "a11y/link-text": [
          ["/blog/page-1", "warn", "3 link(s) with generic text", "[{\"id\":\"read more\"}]"],
          ["/blog/page-2", "warn", "3 link(s) with generic text", "[{\"id\":\"read more\"}]"],
          ["/blog/page-3", "warn", "3 link(s) with generic text", "[{\"id\":\"read more\"}]"],
          ["/blog/page-4", "warn", "3 link(s) with generic text", "[{\"id\":\"read more\"}]"],
        ],
      },
    },
    note: "Cards are page content rendered by one template with per-post data. They must never become a site-chrome (observed) group. Repeated-subtree promotion may still say they are one repeated block, which is true of this fixture and is attributed with the weaker label.",
  },
  {
    id: "repeated-cards-hand-authored",
    plan: "5. repeated cards with differing data (hand-authored, differing markup)",
    title: "Post links written by hand, each in different markup",
    pages: [
      {
        path: "/blog/a",
        html: layout("plain", "A", '<div class="card"><p>Teaser A.</p><a href="/blog/post-a">Read more</a></div>') + footer(""),
      },
      {
        path: "/blog/b",
        html: layout("plain", "B", '<section><h2>Post B</h2><a href="/blog/post-b">Read more</a></section>') + footer(""),
      },
      {
        path: "/blog/c",
        html: layout("plain", "C", '<ul><li><span>Post C</span><a href="/blog/post-c">Read more</a></li></ul>') + footer(""),
      },
      {
        path: "/blog/d",
        html: layout("plain", "D", '<p>Post D <a href="/blog/post-d">Read more</a></p>') + footer(""),
      },
    ],
    labels: [
      ["/blog/a", "main:1>main>div:1>a:1"],
      ["/blog/b", "main:1>main>section:1>a:1"],
      ["/blog/c", "main:1>main>ul:1>li:1>a:1"],
      ["/blog/d", "main:1>main>p:2>a:1"],
    ].map(([page, locator], i) => ({
      page: page!,
      rule: LT,
      locator: locator!,
      nestedIn: "none",
      // Different markup per page means no shared template can be shown: each
      // link is its own edit.
      fixKey: `hand-authored-${i}`,
      expectGrouped: false,
      expectObserved: false,
    })),
    expect: {
      observedGroups: 0,
      afterGroups: 0,
      rollups: 0,
      detections: {
        "a11y/link-text": [
          ["/blog/a", "warn", "1 link(s) with generic text", "[{\"id\":\"read more\"}]"],
          ["/blog/b", "warn", "1 link(s) with generic text", "[{\"id\":\"read more\"}]"],
          ["/blog/c", "warn", "1 link(s) with generic text", "[{\"id\":\"read more\"}]"],
          ["/blog/d", "warn", "1 link(s) with generic text", "[{\"id\":\"read more\"}]"],
        ],
      },
    },
    note: "The same words in main on four pages, but nothing recurs structurally. Nothing may be grouped.",
  },
  {
    id: "nested-article-header-vs-site-header",
    plan: "6. nested article header versus site header",
    title: "Site header link grouped, article header links not",
    pages: [1, 2, 3, 4].map((n) => ({
      path: `/post/${n}`,
      html: `<header>${NAV}<a href="/start">Learn more</a></header><main><article><header><h1>Post ${n}</h1><a href="/post/${n}/full">Learn more</a></header><p>Body ${n}.</p></article></main>${footer("")}`,
    })),
    labels: [1, 2, 3, 4].flatMap((n) => [
      fixed(`/post/${n}`, LT, "header:1>header>a:1", "site-header-learn-more", true),
      fixed(`/post/${n}`, LT, "header:1>header>a:1", `article-header-${n}`, false, false, "article"),
    ]),
    expect: {
      observedGroups: 1,
      afterGroups: 1,
      rollups: 1,
      detections: {
        "a11y/link-text": [
          ["/post/1", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/post/2", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/post/3", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/post/4", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
        ],
      },
    },
    note: "The site header is one template. A header inside an article belongs to the article: its link is authored per post.",
  },
  {
    id: "no-semantic-landmarks",
    plan: "7. absent semantic landmarks",
    title: "Chrome built from plain divs",
    pages: [1, 2, 3, 4].map((n) => ({
      path: `/p/${n}`,
      html: `<div class="top"><div class="inner"><a href="/start">Learn more</a></div></div><div class="content"><h1>Page ${n}</h1><p>Body ${n}.</p></div>`,
    })),
    labels: [1, 2, 3, 4].map((n) =>
      fixed(`/p/${n}`, LT, "html>body:1>div:1>div:1>a:1", "div-chrome-learn-more", false, false, "unknown"),
    ),
    expect: {
      observedGroups: 0,
      afterGroups: 1,
      rollups: 1,
      detections: {
        "a11y/link-text": [
          ["/p/1", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/p/2", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/p/3", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/p/4", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
        ],
      },
    },
    note: "Probably one shared block in reality, but nothing in the DOM says so. The rule stays uncertain; what cross-page promotion does with it is recorded, not assumed.",
  },
  {
    id: "one-page-exception",
    plan: "8. one-page exception",
    title: "Shared footer, one page differs",
    pages: [
      { path: "/", html: layout("plain", "Home") + footer(CLICK) },
      { path: "/a", html: layout("sidebar", "A") + footer(CLICK) },
      { path: "/b", html: layout("article", "B") + footer(CLICK) },
      { path: "/special", html: layout("plain", "Special") + footer(LEARN) },
    ],
    labels: [
      ...["/", "/a", "/b"].map((p) => fixed(p, LT, FOOTER_LINK, "footer-click-here", true)),
      fixed("/special", LT, FOOTER_LINK, "special-footer-learn-more", false),
    ],
    expect: {
      observedGroups: 2,
      afterGroups: 2,
      rollups: 2,
      detections: {
        "a11y/link-text": [
          ["/", "warn", "1 link(s) with generic text", "[{\"id\":\"click here\"}]"],
          ["/a", "warn", "1 link(s) with generic text", "[{\"id\":\"click here\"}]"],
          ["/b", "warn", "1 link(s) with generic text", "[{\"id\":\"click here\"}]"],
          ["/special", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
        ],
      },
    },
    note: "The footer is shared but /special carries a different defect in it, so it needs its own edit and its group says one page.",
  },
  {
    id: "stale-year-shared-footer",
    plan: "stale-copyright: same stale year in a shared footer",
    title: "Stale year on every page's footer",
    pages: [
      { path: "/", html: layout("plain", "Home") + footer("", 2019) },
      { path: "/blog/post", html: layout("article", "A post") + footer("", 2019) },
      { path: "/docs/x", html: layout("sidebar", "Docs x") + footer("", 2019) },
      { path: "/landing", html: layout("bare", "Landing") + footer("", 2019) },
    ],
    labels: ["/", "/blog/post", "/docs/x", "/landing"].map((p) =>
      fixed(p, SC, "footer:1>footer>p:1", "footer-year", true),
    ),
    expect: {
      observedGroups: 1,
      afterGroups: 1,
      rollups: 1,
      detections: {
        "content/stale-copyright": [
          ["/", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/blog/post", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/docs/x", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/landing", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
        ],
      },
    },
    note: "One footer template holds the year: one edit.",
  },
  {
    id: "stale-year-footer-variants",
    plan: "stale-copyright: different stale years on different footer variants",
    title: "Two footer templates with different stale years",
    pages: [
      { path: "/", html: layout("plain", "Home") + footer("", 2019) },
      { path: "/a", html: layout("plain", "A") + footer("", 2019) },
      { path: "/b", html: layout("plain", "B") + footer("", 2019) },
      {
        path: "/shop",
        html: layout("plain", "Shop") + footer("", 2021, '<section class="social"><a href="/x">Social</a></section>'),
      },
      {
        path: "/shop/cart",
        html: layout("plain", "Cart") + footer("", 2021, '<section class="social"><a href="/x">Social</a></section>'),
      },
    ],
    labels: [
      ...["/", "/a", "/b"].map((p) => fixed(p, SC, "footer:1>footer>p:1", "footer-main-year", true)),
      ...["/shop", "/shop/cart"].map((p) =>
        fixed(p, SC, "footer:1>footer>p:1", "footer-shop-year", true),
      ),
    ],
    expect: {
      observedGroups: 2,
      afterGroups: 2,
      rollups: 2,
      detections: {
        "content/stale-copyright": [
          ["/", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/a", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/b", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/shop", "warn", "Footer copyright year is 2021, behind the current year 2026", "null"],
          ["/shop/cart", "warn", "Footer copyright year is 2021, behind the current year 2026", "null"],
        ],
      },
    },
    note: "Two templates, two years: two edits.",
  },
  {
    id: "stale-year-article-local-footer",
    plan: "stale-copyright: article-local footer with a year",
    title: "Article footer year beside pages with a stale site footer",
    pages: [
      { path: "/", html: layout("plain", "Home") + footer("", 2019) },
      { path: "/about", html: layout("bare", "About") + footer("", 2019) },
      { path: "/docs", html: layout("sidebar", "Docs") + footer("", 2019) },
      ...[1, 2, 3].map((n) => ({
        path: `/post/${n}`,
        html: `<main><article><h1>Post ${n}</h1><p>Body ${n}.</p><footer>&copy; 2019 Author ${n}</footer></article></main>`,
      })),
    ],
    labels: [
      ...["/", "/about", "/docs"].map((p) => fixed(p, SC, "footer:1>footer>p:1", "site-footer-year", true)),
      // Authored with each article, so each is its own edit.
      ...[1, 2, 3].map((n) =>
        fixed(`/post/${n}`, SC, "footer:1>footer", `article-footer-year-${n}`, false, false, "article"),
      ),
    ],
    expect: {
      observedGroups: 1,
      afterGroups: 1,
      rollups: 1,
      detections: {
        "content/stale-copyright": [
          ["/", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/about", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/docs", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/post/1", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/post/2", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/post/3", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
        ],
      },
    },
    note: "Same stale year everywhere, but the year inside an article belongs to that article. The site footer is one edit; the article footers must not be claimed as the site footer. (The rule reads the newest year across all footers, so an article footer is only an observation on a page where it is the one asserting that year.)",
  },
  {
    id: "mixed-site-order-independence",
    plan: "9. input-order changes (a full mixed site)",
    title: "Shared chrome, variants, cards, article headers and an exception together",
    pages: [
      { path: "/", html: layout("plain", "Home") + footer(LEARN + CLICK, 2019) },
      { path: "/blog/post", html: layout("article", "A post") + footer(LEARN + CLICK, 2019) },
      { path: "/docs/x", html: layout("sidebar", "Docs x") + footer(LEARN + CLICK, 2019) },
      {
        path: "/shop",
        html: layout("plain", "Shop") + footer(LEARN, 2021, '<section class="social"><a href="/x">Social</a></section>'),
      },
      {
        path: "/shop/cart",
        html: layout("plain", "Cart") + footer(LEARN, 2021, '<section class="social"><a href="/x">Social</a></section>'),
      },
      {
        path: "/blog",
        html:
          layout(
            "plain",
            "Blog",
            [1, 2]
              .map((k) => `<div class="card"><h2>P${k}</h2><p>Teaser ${k}.</p><a href="/blog/p${k}">Read more</a></div>`)
              .join(""),
          ) + footer(CLICK, 2019),
      },
    ],
    labels: [
      ...["/", "/blog/post", "/docs/x"].flatMap((p) => [
        fixed(p, LT, "footer:1>footer>a:1", "main-footer-learn-more", true),
        fixed(p, LT, "footer:1>footer>a:2", "main-footer-click-here", true),
        fixed(p, SC, "footer:1>footer>p:1", "main-footer-year", true),
      ]),
      ...["/shop", "/shop/cart"].flatMap((p) => [
        fixed(p, LT, FOOTER_LINK, "shop-footer-learn-more", true),
        fixed(p, SC, "footer:1>footer>p:1", "shop-footer-year", true),
      ]),
      fixed("/blog", LT, "footer:1>footer>a:1", "blog-footer-click-here", false),
      fixed("/blog", SC, "footer:1>footer>p:1", "blog-footer-year", false),
      fixed("/blog", LT, "main:1>main>div:1>a:1", "card-blog-1", false, false),
      fixed("/blog", LT, "main:1>main>div:2>a:1", "card-blog-2", false, false),
    ],
    expect: {
      observedGroups: 7,
      afterGroups: 7,
      rollups: 6,
      detections: {
        "a11y/link-text": [
          ["/", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"},{\"id\":\"click here\"}]"],
          ["/blog", "warn", "3 link(s) with generic text", "[{\"id\":\"read more\"},{\"id\":\"click here\"}]"],
          ["/blog/post", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"},{\"id\":\"click here\"}]"],
          ["/docs/x", "warn", "2 link(s) with generic text", "[{\"id\":\"learn more\"},{\"id\":\"click here\"}]"],
          ["/shop", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/shop/cart", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
        ],
        "content/stale-copyright": [
          ["/", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/blog", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/blog/post", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/docs/x", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/shop", "warn", "Footer copyright year is 2021, behind the current year 2026", "null"],
          ["/shop/cart", "warn", "Footer copyright year is 2021, behind the current year 2026", "null"],
        ],
      },
    },
    note: "Everything above on one site. The point of the case is that group ids and membership do not move when the page order does.",
  },
  {
    id: "legacy-report-without-evidence",
    plan: "10. legacy reports without component evidence",
    title: "A shared-footer site whose stored report predates evidence",
    legacy: true,
    pages: [
      { path: "/", html: layout("plain", "Home") + footer(LEARN, 2019) },
      { path: "/blog/post", html: layout("article", "A post") + footer(LEARN, 2019) },
      { path: "/docs/x", html: layout("sidebar", "Docs x") + footer(LEARN, 2019) },
    ],
    labels: [],
    expect: {
      observedGroups: 0,
      afterGroups: 0,
      rollups: 0,
      detections: {
        "a11y/link-text": [
          ["/", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/blog/post", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
          ["/docs/x", "warn", "1 link(s) with generic text", "[{\"id\":\"learn more\"}]"],
        ],
        "content/stale-copyright": [
          ["/", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/blog/post", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
          ["/docs/x", "warn", "Footer copyright year is 2019, behind the current year 2026", "null"],
        ],
      },
    },
    note: "No evidence means no fix groups and no throw: output falls back to the message grouping that existed before.",
  },
];

/** The rules the evaluation exercises, in the order the harness reports them. */
export const EVAL_RULES_UNDER_TEST: EvalRuleId[] = ["a11y/link-text", "content/stale-copyright"];
