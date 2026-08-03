// links/redirect-chains reported `(200) → (200)` "redirects" on sites whose
// every internal link is trailing-slash canonical (WordPress, Hugo, Jekyll and
// most static hosts). Two hops both returning 200 is not a redirect at all — it
// is a chain assembled from a source URL and a landing URL by a fetcher that
// never observed the responses in between. These tests pin the rule to real
// redirect evidence, and pin the label to hops whose status was actually seen.

import { describe, expect, test } from "bun:test";

import type { RedirectChain, RedirectHop } from "@squirrelscan/core-contracts";
import type { RuleContext } from "../src/types";

import { redirectChainsRule } from "../src/links/redirect-chains";

interface PageInput {
  url: string;
  finalUrl: string;
  redirectChain?: RedirectChain;
  links?: string[];
}

function hop(url: string, statusCode: number): RedirectHop {
  return { url, statusCode, type: "http" };
}

function chain(sourceUrl: string, finalUrl: string, hops: RedirectHop[]): RedirectChain {
  return {
    sourceUrl,
    finalUrl,
    hops,
    chainLength: Math.max(0, hops.length - 1),
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };
}

function ctx(pages: PageInput[]): RuleContext {
  return {
    page: { url: pages[0]?.url ?? "https://example.com/", html: "", statusCode: 200 },
    parsed: {},
    site: {
      baseUrl: "https://example.com",
      pages: pages.map((page) => ({
        url: page.url,
        finalUrl: page.finalUrl,
        redirectChain: page.redirectChain,
        parsed: {
          links: (page.links ?? []).map((url) => ({ url, isInternal: true })),
        },
      })),
      robotsTxt: null,
      sitemaps: null,
    },
    options: {},
  } as unknown as RuleContext;
}

const check = (pages: PageInput[], name: string) =>
  redirectChainsRule.run(ctx(pages)).checks.find((c) => c.name === name);

describe("links/redirect-chains — trailing-slash false positives", () => {
  test("the exact reported shape (200 → 200) is not a redirect", () => {
    // Verbatim from the field report: a slash-canonical page whose chain claims
    // two hops, both 200. Neither hop redirected, so nothing should be flagged.
    const pages: PageInput[] = [
      {
        url: "https://example.com/o-mnie",
        finalUrl: "https://example.com/o-mnie/",
        redirectChain: chain("https://example.com/o-mnie", "https://example.com/o-mnie/", [
          hop("https://example.com/o-mnie", 200),
          hop("https://example.com/o-mnie/", 200),
        ]),
      },
    ];

    const { checks } = redirectChainsRule.run(ctx(pages));

    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("pass");
    expect(checks[0]!.message).toContain("No redirects");
  });

  test("a slash-canonical site produces zero phantom chains", () => {
    // Every page fetched at the URL it was linked at, no redirect anywhere.
    const pages: PageInput[] = [
      "https://example.com/",
      "https://example.com/o-mnie/",
      "https://example.com/blog/",
      "https://example.com/kontakt/",
    ].map((url) => ({
      url,
      finalUrl: url,
      redirectChain: chain(url, url, [hop(url, 200)]),
      links: ["https://example.com/o-mnie/", "https://example.com/blog/"],
    }));

    const { checks } = redirectChainsRule.run(ctx(pages));

    expect(checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("a page whose links-to-redirect fan-out is driven by a phantom chain stays quiet", () => {
    // The regression that made this site-wide: `links-to-redirect` inherits
    // redirect-pages' targets, so one phantom chain blamed every linking page.
    const pages: PageInput[] = [
      {
        url: "https://example.com/o-mnie",
        finalUrl: "https://example.com/o-mnie/",
        redirectChain: chain("https://example.com/o-mnie", "https://example.com/o-mnie/", [
          hop("https://example.com/o-mnie", 200),
          hop("https://example.com/o-mnie/", 200),
        ]),
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        url: `https://example.com/p${i}/`,
        finalUrl: `https://example.com/p${i}/`,
        links: ["https://example.com/o-mnie/"],
      })),
    ];

    expect(check(pages, "links-to-redirect")).toBeUndefined();
  });
});

describe("links/redirect-chains — genuine redirects still report", () => {
  test("a real 301 chain is reported", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/przemyslenia",
        finalUrl: "https://example.com/przemyslenia-artykuly/",
        redirectChain: chain(
          "https://example.com/przemyslenia",
          "https://example.com/przemyslenia-artykuly/",
          [
            hop("https://example.com/przemyslenia", 301),
            hop("https://example.com/przemyslenia-artykuly/", 200),
          ],
        ),
      },
    ];

    const redirectPages = check(pages, "redirect-pages");
    expect(redirectPages?.status).toBe("warn");
    expect(redirectPages?.items).toHaveLength(1);
    expect(redirectPages?.items?.[0]?.label).toBe(
      "https://example.com/przemyslenia (301) → https://example.com/przemyslenia-artykuly/ (200)",
    );
  });

  test("a real 301 on a slash-only redirect is still reported", () => {
    // The one genuine case in the field report: the site really did serve a 301
    // from the no-slash form. Suppressing on shape alone would have hidden it.
    const pages: PageInput[] = [
      {
        url: "https://example.com/o-mnie",
        finalUrl: "https://example.com/o-mnie/",
        redirectChain: chain("https://example.com/o-mnie", "https://example.com/o-mnie/", [
          hop("https://example.com/o-mnie", 301),
          hop("https://example.com/o-mnie/", 200),
        ]),
      },
    ];

    expect(check(pages, "redirect-pages")?.status).toBe("warn");
  });

  test("a multi-hop chain is reported and every hop is labelled", () => {
    const pages: PageInput[] = [
      {
        url: "http://example.com/old",
        finalUrl: "https://example.com/new/",
        redirectChain: chain("http://example.com/old", "https://example.com/new/", [
          hop("http://example.com/old", 301),
          hop("https://example.com/old", 302),
          hop("https://example.com/new/", 200),
        ]),
      },
    ];

    expect(check(pages, "redirect-pages")?.items?.[0]?.label).toBe(
      "http://example.com/old (301) → https://example.com/old (302) → https://example.com/new/ (200)",
    );
  });

  test("a genuine destination change with unobserved hop statuses still reports", () => {
    // Browser-rendered pages come back with the landing page only, so the source
    // hop carries status 0. The URL genuinely changed, so it is still a redirect.
    const pages: PageInput[] = [
      {
        url: "https://example.com/old-post/",
        finalUrl: "https://example.com/new-post/",
        redirectChain: chain("https://example.com/old-post/", "https://example.com/new-post/", [
          hop("https://example.com/old-post/", 0),
          hop("https://example.com/new-post/", 200),
        ]),
      },
    ];

    const redirectPages = check(pages, "redirect-pages");
    expect(redirectPages?.status).toBe("warn");
    // An unobserved status is omitted rather than printed as "(0)".
    expect(redirectPages?.items?.[0]?.label).toBe(
      "https://example.com/old-post/ → https://example.com/new-post/ (200)",
    );
  });

  test("links pointing at a genuinely redirecting URL are still blamed", () => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/old",
        finalUrl: "https://example.com/new/",
        redirectChain: chain("https://example.com/old", "https://example.com/new/", [
          hop("https://example.com/old", 301),
          hop("https://example.com/new/", 200),
        ]),
      },
      {
        url: "https://example.com/",
        finalUrl: "https://example.com/",
        links: ["https://example.com/old"],
      },
    ];

    const linksToRedirect = check(pages, "links-to-redirect");
    expect(linksToRedirect?.status).toBe("warn");
    expect(linksToRedirect?.items?.[0]?.sourcePages).toEqual(["https://example.com/"]);
  });
});

describe("links/redirect-chains — a chain can never claim a 200 first hop", () => {
  test.each([
    ["all-2xx two-hop chain", [hop("https://example.com/a", 200), hop("https://example.com/a/", 200)]],
    ["2xx then 3xx (the redirect is the LAST hop, so it led nowhere)", [
      hop("https://example.com/a", 200),
      hop("https://example.com/a/", 301),
    ]],
  ])("%s produces no warning", (_name, hops) => {
    const pages: PageInput[] = [
      {
        url: "https://example.com/a",
        finalUrl: "https://example.com/a/",
        redirectChain: chain("https://example.com/a", "https://example.com/a/", hops),
      },
    ];

    expect(check(pages, "redirect-pages")).toBeUndefined();
  });

  test("no emitted chain has a 2xx status on a non-final hop", () => {
    // Blanket invariant over a mixed site: whatever the rule chooses to report,
    // the hop it blames must have actually redirected.
    const pages: PageInput[] = [
      {
        url: "https://example.com/phantom",
        finalUrl: "https://example.com/phantom/",
        redirectChain: chain("https://example.com/phantom", "https://example.com/phantom/", [
          hop("https://example.com/phantom", 200),
          hop("https://example.com/phantom/", 200),
        ]),
      },
      {
        url: "https://example.com/real",
        finalUrl: "https://example.com/real-target/",
        redirectChain: chain("https://example.com/real", "https://example.com/real-target/", [
          hop("https://example.com/real", 308),
          hop("https://example.com/real-target/", 200),
        ]),
      },
    ];

    const items = check(pages, "redirect-pages")?.items ?? [];
    expect(items).toHaveLength(1);
    for (const item of items) {
      const emitted = (item.meta as { chain?: RedirectChain } | undefined)?.chain;
      for (const h of emitted?.hops.slice(0, -1) ?? []) {
        const is2xx = h.statusCode >= 200 && h.statusCode < 300;
        expect(is2xx).toBe(false);
      }
    }
  });
});
