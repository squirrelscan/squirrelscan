// crawl/canonical-chain accepted the SHAPE of a redirect chain as proof one
// happened — `chainLength > 0 || pageUrl !== finalUrl`, with no check that any
// hop returned a 3xx — and then labelled the result `url (200) → url (200)`.
// That is the defect #1510 fixed in links/redirect-chains, still latent here:
// it went quiet only because the producers stopped fabricating chains, so any
// producer regression or a chain persisted from an older crawl brings it back.
//
// These tests pin the rule to observed redirect evidence, on the exact shapes
// from the field report.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { RedirectChain, RedirectHop } from "@squirrelscan/core-contracts";
import type { RuleContext } from "../src/types";

import { canonicalChainRule } from "../src/crawl/canonical-chain";

function hop(url: string, statusCode: number, type: RedirectHop["type"] = "http"): RedirectHop {
  return { url, statusCode, type };
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

/**
 * A document is required — the rule returns no checks without one — but the
 * page-redirect-chain check reads nothing from it, so a bare canonical is
 * enough for every case here.
 */
function ctx(page: {
  url: string;
  finalUrl?: string;
  redirectChain?: RedirectChain;
  canonical?: string;
}): RuleContext {
  const canonical = page.canonical ?? page.url;
  const html = `<html><head><link rel="canonical" href="${canonical}"></head><body></body></html>`;
  return {
    page: {
      url: page.url,
      finalUrl: page.finalUrl,
      redirectChain: page.redirectChain,
      html,
      statusCode: 200,
    },
    parsed: { document: parseHTML(html).document },
    options: {},
  } as unknown as RuleContext;
}

const run = (page: Parameters<typeof ctx>[0], name: string) =>
  canonicalChainRule.run(ctx(page)).checks.find((c) => c.name === name);

describe("crawl/canonical-chain — chain shape is not redirect evidence", () => {
  test("the fabricated 200 → 200 chain no longer reports a redirect", () => {
    // Verbatim from the #1524 report: a slash-canonical page whose chain claims
    // two hops, both 200. An HTTP response that returned 200 did not redirect.
    const check = run(
      {
        url: "https://example.com/o-mnie",
        finalUrl: "https://example.com/o-mnie/",
        redirectChain: chain("https://example.com/o-mnie", "https://example.com/o-mnie/", [
          hop("https://example.com/o-mnie", 200),
          hop("https://example.com/o-mnie/", 200),
        ]),
      },
      "page-redirect-chain"
    );

    expect(check).toBeUndefined();
  });

  test("a genuine 301 → 200 chain still fires, labelled with the observed statuses", () => {
    const check = run(
      {
        url: "https://example.com/o-mnie",
        finalUrl: "https://example.com/o-mnie/",
        redirectChain: chain("https://example.com/o-mnie", "https://example.com/o-mnie/", [
          hop("https://example.com/o-mnie", 301),
          hop("https://example.com/o-mnie/", 200),
        ]),
      },
      "page-redirect-chain"
    );

    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.label).toBe(
      "https://example.com/o-mnie (301) → https://example.com/o-mnie/ (200)"
    );
  });

  test("a chain with no hop statuses still fires when the request landed elsewhere", () => {
    // The render path reports the landing URL but never the statuses that led
    // to it, so unobserved hops are recorded as 0. Landing on a different
    // resource is evidence in its own right, and the label must not invent a
    // status for a hop nobody watched.
    const check = run(
      {
        url: "https://example.com/old",
        finalUrl: "https://example.com/new",
        redirectChain: chain("https://example.com/old", "https://example.com/new", [
          hop("https://example.com/old", 0),
          hop("https://example.com/new", 200),
        ]),
      },
      "page-redirect-chain"
    );

    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.label).toBe("https://example.com/old → https://example.com/new (200)");
  });

  test.each([["meta-refresh"], ["javascript"]] as const)(
    "a %s hop returning 200 is a real redirect, not a contradiction",
    (type) => {
      // A client-side redirect IS a document that returned 200 and then sent
      // the visitor elsewhere, so its 2xx is the truth rather than a borrowed
      // status.
      const check = run(
        {
          url: "https://example.com/splash",
          finalUrl: "https://example.com/home",
          redirectChain: chain("https://example.com/splash", "https://example.com/home", [
            hop("https://example.com/splash", 200, type),
            hop("https://example.com/home", 200),
          ]),
        },
        "page-redirect-chain"
      );

      expect(check?.status).toBe("warn");
    }
  );

  test("one contradictory hop suppresses the chain even beside an observed 301", () => {
    // A 200 on a hop the chain says was followed is proof the chain was
    // assembled rather than watched, and that taints every status in it.
    const check = run(
      {
        url: "https://example.com/a",
        finalUrl: "https://example.com/c",
        redirectChain: chain("https://example.com/a", "https://example.com/c", [
          hop("https://example.com/a", 301),
          hop("https://example.com/b", 200),
          hop("https://example.com/c", 200),
        ]),
      },
      "page-redirect-chain"
    );

    expect(check).toBeUndefined();
  });

  test("a redirect that only rewrites the query string still counts as landing elsewhere", () => {
    // The query is part of the request target: `/search` and `/search?page=1`
    // are different resources, so a request aimed at one that landed on the
    // other redirected, even with no status to prove it.
    const check = run(
      {
        url: "https://example.com/search",
        finalUrl: "https://example.com/search?page=1",
        redirectChain: chain("https://example.com/search", "https://example.com/search?page=1", [
          hop("https://example.com/search", 0),
          hop("https://example.com/search?page=1", 200),
        ]),
      },
      "page-redirect-chain"
    );

    expect(check?.status).toBe("warn");
  });

  test("a fragment-only difference is not a redirect", () => {
    // The fragment never leaves the browser, so it cannot differ across an
    // HTTP request and must not be read as a destination change.
    const check = run(
      {
        url: "https://example.com/docs",
        finalUrl: "https://example.com/docs#install",
        redirectChain: chain("https://example.com/docs", "https://example.com/docs#install", [
          hop("https://example.com/docs", 0),
          hop("https://example.com/docs#install", 200),
        ]),
      },
      "page-redirect-chain"
    );

    expect(check).toBeUndefined();
  });

  test("a page that never redirected stays silent", () => {
    const check = run(
      {
        url: "https://example.com/about/",
        finalUrl: "https://example.com/about/",
        redirectChain: chain("https://example.com/about/", "https://example.com/about/", [
          hop("https://example.com/about/", 200),
        ]),
      },
      "page-redirect-chain"
    );

    expect(check).toBeUndefined();
  });
});

describe("crawl/canonical-chain — canonical-redirects needs the same evidence", () => {
  const selfCanonicalThroughChain = (hops: RedirectHop[]) => ({
    url: "https://example.com/page",
    finalUrl: "https://example.com/elsewhere",
    canonical: "https://example.com/page",
    redirectChain: chain("https://example.com/page", "https://example.com/elsewhere", hops),
  });

  test("a fabricated chain does not accuse the canonical of resolving through redirects", () => {
    const check = run(
      selfCanonicalThroughChain([
        hop("https://example.com/page", 200),
        hop("https://example.com/elsewhere", 200),
      ]),
      "canonical-redirects"
    );

    expect(check).toBeUndefined();
  });

  test("an observed 301 still flags the canonical", () => {
    const check = run(
      selfCanonicalThroughChain([
        hop("https://example.com/page", 301),
        hop("https://example.com/elsewhere", 200),
      ]),
      "canonical-redirects"
    );

    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.label).toBe(
      "https://example.com/page (301) → https://example.com/elsewhere (200)"
    );
  });

  test("an unobserved chain to a different destination still flags the canonical", () => {
    // Both checks must ask the same question. Demanding a recorded 3xx here
    // while page-redirect-chain accepts a different destination would drop
    // every render-path redirect, which reports where the request landed but
    // never the statuses that led there.
    const check = run(
      selfCanonicalThroughChain([
        hop("https://example.com/page", 0),
        hop("https://example.com/elsewhere", 200),
      ]),
      "canonical-redirects"
    );

    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.label).toBe(
      "https://example.com/page → https://example.com/elsewhere (200)"
    );
  });
});
