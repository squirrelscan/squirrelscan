// repo#2729 — a link check that did not run is "not checked", never a pass.
//
// A Quick audit (and --offline, and external_links.enabled = false) never
// requests the external links, and a Quick crawl never follows internal links.
// The rules used to pass anyway ("No external links found to check", "No broken
// internal links detected"), the report read as clean, and the cloud resolved
// open broken-link issues on that pass.

import { describe, expect, test } from "bun:test";

import {
  EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
  LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
} from "@squirrelscan/core-contracts";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import { brokenLinksRule } from "../src/links/broken-links";
import { deadLinksRule } from "../src/links/dead-links";
import type { ExternalLinkCheckData, ParsedPage, RuleContext, SiteData } from "../src/types";

const BASE = "https://example.com";

interface FixturePage {
  url: string;
  statusCode: number;
  internal?: string[];
  external?: string[];
}

function ctx(
  pages: FixturePage[],
  site: Partial<
    Pick<
      SiteData,
      | "externalLinks"
      | "linkDiscoveryOff"
      | "linkTargetStatuses"
      | "internalLinkProbe"
      | "externalLinkCheck"
    >
  > = {},
): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      robotsTxt: null,
      sitemaps: null,
      pages: pages.map((p) => ({
        url: p.url,
        statusCode: p.statusCode,
        parsed: {
          links: [
            ...(p.internal ?? []).map((url) => ({ url, isInternal: true, text: "", rel: null })),
            ...(p.external ?? []).map((url) => ({ url, isInternal: false, text: "", rel: null })),
          ],
        } as unknown as ParsedPage,
      })),
      ...site,
    },
    options: {},
  } as unknown as RuleContext;
}

const named = (checks: { name: string; status: string }[], name: string) =>
  checks.filter((c) => c.name === name);

describe("links/broken-external-links when external link checking did not run", () => {
  test("undefined link data is skipped with the not-checked reason, never a pass", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([
        {
          url: `${BASE}/`,
          statusCode: 200,
          external: ["https://a.example/", "https://b.example/x", "https://a.example/"],
        },
        { url: `${BASE}/about`, statusCode: 200, external: ["https://b.example/x"] },
      ]),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.skipReason).toBe(EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON);
    // Distinct hrefs on the audited pages, so the reader knows what went unchecked.
    expect(checks[0]!.message).toBe(
      "External link checking was off for this audit, so 2 external link(s) on the audited pages were not checked",
    );
    expect(checks[0]!.details).toEqual({ externalLinksFound: 2 });
  });

  test("skipped even when the pages have no external links: nothing was checked", () => {
    const { checks } = brokenExternalLinksRule.run(ctx([{ url: `${BASE}/`, statusCode: 200 }]));
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.message).toBe(
      "External link checking was off for this audit, so external links were not checked",
    );
  });

  test("an empty list means checking ran and found nothing: still a pass", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([{ url: `${BASE}/`, statusCode: 200 }], { externalLinks: [] }),
    );
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.message).toBe("No external links found to check");
  });

  test("no check results while the pages link out is not a pass either", () => {
    // `squirrel analyze` re-runs rules on a stored crawl whose link phase never ran.
    const { checks } = brokenExternalLinksRule.run(
      ctx([{ url: `${BASE}/`, statusCode: 200, external: ["https://a.example/"] }], {
        externalLinks: [],
      }),
    );
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.skipReason).toBe(EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON);
    expect(checks[0]!.message).toBe(
      "No external link check results for the 1 external link(s) on the audited pages, so they were not checked",
    );
  });

  test("results with no status or error at all are not 'All 0 working'", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([{ url: `${BASE}/`, statusCode: 200 }], {
        externalLinks: [
          { href: "https://a.example/", status: null, error: null, sourcePages: [`${BASE}/`] },
        ],
      }),
    );
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.message).toBe("None of the 1 external link(s) could be checked this audit");
  });

  test("only http(s) hrefs the checker could request are counted", () => {
    const page = {
      url: `${BASE}/`,
      statusCode: 200,
      parsed: {
        links: [
          { url: "https://a.example/", isInternal: false, text: "" },
          { url: "ftp://files.example/x", isInternal: false, text: "" },
          { url: "http://[bad", isInternal: false, text: "", error: "Invalid URL format" },
        ],
      } as unknown as ParsedPage,
    };
    const context = ctx([]);
    context.site!.pages = [page];
    const { checks } = brokenExternalLinksRule.run(context);
    expect(checks[0]!.details).toEqual({ externalLinksFound: 1 });
  });

  test("checked links still warn on a 404", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([{ url: `${BASE}/`, statusCode: 200 }], {
        externalLinks: [
          { href: "https://dead.example/", status: 404, error: null, sourcePages: [`${BASE}/`] },
        ],
      }),
    );
    expect(checks[0]!.status).toBe("warn");
  });

  test("links over the per-audit limit are not checked, next to the result for the rest", () => {
    const { checks } = brokenExternalLinksRule.run(
      ctx([{ url: `${BASE}/`, statusCode: 200 }], {
        externalLinks: [
          { href: "https://a.example/", status: 200, error: null, sourcePages: [`${BASE}/`] },
        ],
        externalLinkCheck: { found: 30, checked: 1, cap: 1 },
      }),
    );
    expect(checks.map((c) => `${c.status}:${c.skipReason ?? ""}`)).toEqual([
      "pass:",
      "skipped:external-links-over-cap",
    ]);
    expect(checks[1]!.message).toBe(
      "29 of 30 external link(s) were not checked: over this audit's limit of 1, which checks the most-linked first",
    );
  });

  test("links/dead-links skips with the same reason (kept off the locked upsell)", () => {
    const { checks } = deadLinksRule.run(ctx([{ url: `${BASE}/`, statusCode: 200 }]));
    expect(checks[0]!.status).toBe("skipped");
    expect(checks[0]!.skipReason).toBe(EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON);
  });
});

describe("links/broken-links when the crawl did not follow links", () => {
  const pages: FixturePage[] = [
    // The home page links one fetched page and two the crawl never requested.
    {
      url: `${BASE}/`,
      statusCode: 200,
      internal: [`${BASE}/about`, `${BASE}/gone`, `${BASE}/blog/old#top`],
    },
    { url: `${BASE}/about`, statusCode: 200, internal: [`${BASE}/`] },
  ];

  test("unfetched targets make the check skipped, with no pass", () => {
    const { checks } = brokenLinksRule.run(ctx(pages, { linkDiscoveryOff: true }));
    const results = named(checks, "broken-links");
    expect(results.map((c) => c.status)).toEqual(["skipped"]);
    const skipped = checks[0]!;
    expect(skipped.skipReason).toBe(LINK_TARGETS_NOT_FETCHED_SKIP_REASON);
    expect(skipped.message).toBe(
      "2 of 4 internal link target(s) were not fetched because this audit did not follow links and internal link checks were off, so they were not checked for broken links",
    );
    expect(skipped.details).toEqual({
      linkTargets: 4,
      unfetchedTargets: 2,
      probedTargets: 0,
      notFetched: { off: 2 },
    });
  });

  test("a broken target it did fetch still fails, next to the not-checked skip", () => {
    const { checks } = brokenLinksRule.run(
      ctx(
        [
          ...pages,
          // A sitemap-listed 404 IS fetched in a Quick crawl.
          { url: `${BASE}/gone`, statusCode: 404 },
        ],
        { linkDiscoveryOff: true },
      ),
    );
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["fail", "skipped"]);
    expect(checks[0]!.items?.[0]?.id).toBe(`${BASE}/gone`);
  });

  test("every target fetched: a real pass even with links not followed", () => {
    const { checks } = brokenLinksRule.run(
      ctx(
        [
          { url: `${BASE}/`, statusCode: 200, internal: [`${BASE}/about`] },
          { url: `${BASE}/about`, statusCode: 200, internal: [`${BASE}/`] },
        ],
        { linkDiscoveryOff: true },
      ),
    );
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["pass"]);
    expect(checks[0]!.details).toEqual({ linkTargets: 2, unfetchedTargets: 0, probedTargets: 0 });
  });

  test("links followed (Surface, Full): unfetched targets keep today's pass", () => {
    // A followed crawl that ran out of budget is a different gap (#1146), left as
    // is; the pass says how much it covered.
    const { checks } = brokenLinksRule.run(ctx(pages));
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["pass"]);
    expect(checks[0]!.details).toEqual({ linkTargets: 4, unfetchedTargets: 2, probedTargets: 0 });
  });

  test("the link probe's statuses count as known: a probed 404 fails, a probed 200 passes", () => {
    const { checks } = brokenLinksRule.run(
      ctx(pages, {
        linkDiscoveryOff: true,
        linkTargetStatuses: [
          { url: `${BASE}/gone`, status: 404, error: null },
          { url: `${BASE}/blog/old`, status: 200, error: null },
        ],
        internalLinkProbe: { unfetched: 2, probed: 2, cap: 200 },
      }),
    );
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["fail"]);
    expect(checks[0]!.items?.map((i) => [i.id, i.meta?.probed])).toEqual([[`${BASE}/gone`, true]]);
  });

  test("targets past the probe's limit stay not checked, and the message says why", () => {
    const { checks } = brokenLinksRule.run(
      ctx(pages, {
        linkDiscoveryOff: true,
        linkTargetStatuses: [{ url: `${BASE}/blog/old`, status: 200, error: null }],
        internalLinkProbe: { unfetched: 2, probed: 1, cap: 1 },
      }),
    );
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["skipped"]);
    expect(checks[0]!.message).toBe(
      "1 of 4 internal link target(s) were not fetched because this audit did not follow links and its internal link checks stop at 1 target, most-linked first, so they were not checked for broken links",
    );
    expect(checks[0]!.details?.notFetched).toEqual({ overLimit: 1 });
  });

  // pub#726: the reason used to be picked in a fixed order, so any audit where
  // the check answered one target blamed the limit, even with nothing over it.
  // The fixture is the issue's: the home page links /about (crawled), three
  // targets the check answered (/missing 404, /moved 410, /private 403) and two
  // it skipped as actions (/logout, a token link); the limit is 200.
  const issuePages: FixturePage[] = [
    {
      url: `${BASE}/`,
      statusCode: 200,
      internal: [
        `${BASE}/about`,
        `${BASE}/missing`,
        `${BASE}/moved`,
        `${BASE}/private`,
        `${BASE}/logout`,
        `${BASE}/account?token=0123456789abcdef01234567`,
      ],
    },
    { url: `${BASE}/about`, statusCode: 200, internal: [`${BASE}/`] },
  ];
  const issueStatuses = [
    { url: `${BASE}/missing`, status: 404, error: null },
    { url: `${BASE}/moved`, status: 410, error: null },
    { url: `${BASE}/private`, status: 403, error: null },
  ];

  test("targets skipped as actions, limit not reached: the line names the skip, not the limit", () => {
    const { checks } = brokenLinksRule.run(
      ctx(issuePages, {
        linkDiscoveryOff: true,
        linkTargetStatuses: issueStatuses,
        internalLinkProbe: { unfetched: 3, probed: 3, cap: 200, outOfScope: 2 },
      }),
    );
    const skipped = named(checks, "broken-links").find((c) => c.status === "skipped")!;
    expect(skipped.message).toBe(
      "2 of 7 internal link target(s) were not fetched because this audit did not follow links and its internal link checks never request targets outside the crawl scope, disallowed by robots.txt, or that look like actions (log out, unsubscribe) or carry a token, so they were not checked for broken links",
    );
    expect(skipped.message).not.toContain("max_targets");
    expect(skipped.details?.notFetched).toEqual({ skipped: 2 });
    // The two answered 4xx still fail beside it.
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["fail", "skipped"]);
  });

  test("over the limit: the line names the limit", () => {
    // Limit 2: the probe answered /missing and /moved; /private was past it.
    const { checks } = brokenLinksRule.run(
      ctx(issuePages, {
        linkDiscoveryOff: true,
        linkTargetStatuses: issueStatuses.slice(0, 2),
        internalLinkProbe: { unfetched: 3, probed: 2, cap: 2, outOfScope: 2 },
      }),
    );
    const skipped = named(checks, "broken-links").find((c) => c.status === "skipped")!;
    expect(skipped.details?.notFetched).toEqual({ overLimit: 1, skipped: 2 });
    expect(skipped.message).toBe(
      "3 of 7 internal link target(s) were not fetched because this audit did not follow links and its internal link checks covered only part of them (1 past the limit of 2 targets; 2 skipped as outside the crawl scope, disallowed by robots.txt, or an action or token link), so they were not checked for broken links",
    );
  });

  test("every cause at once gets a count each", () => {
    const { checks } = brokenLinksRule.run(
      ctx(issuePages, {
        linkDiscoveryOff: true,
        // /moved was asked and never answered; /private was past the limit of 2.
        linkTargetStatuses: [issueStatuses[0]!, { url: `${BASE}/moved`, status: null, error: "timeout" }],
        internalLinkProbe: { unfetched: 3, probed: 1, cap: 2, outOfScope: 2 },
      }),
    );
    const skipped = named(checks, "broken-links").find((c) => c.status === "skipped")!;
    expect(skipped.details?.notFetched).toEqual({ overLimit: 1, skipped: 2, noAnswer: 1 });
    expect(skipped.message).toContain(
      "(1 past the limit of 2 targets; 2 skipped as outside the crawl scope, disallowed by robots.txt, or an action or token link; 1 with no answer)",
    );
  });

  test("a probe refused with 401/403 is unverifiable, not broken (a bot wall)", () => {
    const { checks } = brokenLinksRule.run(
      ctx(pages, {
        linkTargetStatuses: [
          { url: `${BASE}/gone`, status: 403, error: null },
          { url: `${BASE}/blog/old`, status: 401, error: null },
        ],
        internalLinkProbe: { unfetched: 2, probed: 2, cap: 200 },
      }),
    );
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["pass"]);
    expect(named(checks, "refused-links").map((c) => c.status)).toEqual(["info"]);
  });

  test("a probe that got no answer says so rather than naming zero targets", () => {
    const { checks } = brokenLinksRule.run(
      ctx(pages, { linkDiscoveryOff: true, internalLinkProbe: { unfetched: 2, probed: 0, cap: 200 } }),
    );
    expect(checks[0]!.message).toContain("its internal link checks got no answer");
  });

  test("max_targets = 0 and an unreliable HEAD each say why, not 'no answer'", () => {
    const capped = brokenLinksRule.run(
      ctx(pages, { linkDiscoveryOff: true, internalLinkProbe: { unfetched: 2, probed: 0, cap: 0 } }),
    );
    expect(capped.checks[0]!.message).toContain("internal_links.max_targets is 0");
    const untrusted = brokenLinksRule.run(
      ctx(pages, {
        linkDiscoveryOff: true,
        linkTargetStatuses: [
          { url: `${BASE}/gone`, status: null, error: "head unreliable" },
          { url: `${BASE}/blog/old`, status: null, error: "head unreliable" },
        ],
        internalLinkProbe: { unfetched: 2, probed: 0, cap: 200, headUnreliable: true },
      }),
    );
    expect(named(untrusted.checks, "broken-links").map((c) => c.status)).toEqual(["skipped"]);
    expect(untrusted.checks[0]!.message).toContain("could not be trusted");
  });

  test("a probe that was throttled is rate-limited, not broken", () => {
    const { checks } = brokenLinksRule.run(
      ctx(pages, {
        linkTargetStatuses: [
          { url: `${BASE}/gone`, status: 429, error: null, rateLimited: true },
          { url: `${BASE}/blog/old`, status: 200, error: null },
        ],
        internalLinkProbe: { unfetched: 2, probed: 2, cap: 200 },
      }),
    );
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["pass"]);
    expect(named(checks, "rate-limited-links").map((c) => c.status)).toEqual(["info"]);
  });
});
