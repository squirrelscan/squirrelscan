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
import type { ExternalLinkCheckData, ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";

interface FixturePage {
  url: string;
  statusCode: number;
  internal?: string[];
  external?: string[];
}

function ctx(
  pages: FixturePage[],
  site: { externalLinks?: ExternalLinkCheckData[]; linkDiscoveryOff?: boolean } = {},
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
      "2 of 4 internal link target(s) were not fetched because this audit did not follow links, so they were not checked for broken links",
    );
    expect(skipped.details).toEqual({ linkTargets: 4, unfetchedTargets: 2 });
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
    expect(checks[0]!.details).toEqual({ linkTargets: 2, unfetchedTargets: 0 });
  });

  test("links followed (Surface, Full): unfetched targets keep today's pass", () => {
    // A followed crawl that ran out of budget is a different gap (#1146), left as
    // is; the pass says how much it covered.
    const { checks } = brokenLinksRule.run(ctx(pages));
    expect(named(checks, "broken-links").map((c) => c.status)).toEqual(["pass"]);
    expect(checks[0]!.details).toEqual({ linkTargets: 4, unfetchedTargets: 2 });
  });
});
