// `statusCode: 0` is the "no status was observed for this hop" sentinel that the
// render path produces: the service reports the page it landed on, never the
// statuses of the redirects that got it there. It is a marker for rules to read,
// NOT a status code, and it must never reach a report as `(0)` — that reads like
// a real HTTP status and means nothing to a user.
//
// Every rule that renders a hop goes through `formatRedirectHop`. These tests
// hold that line across all of them at once, so a rule added later that
// interpolates `statusCode` itself is caught here.

import { describe, expect, test } from "bun:test";

import {
  formatRedirectHop,
  type RedirectChain,
  type RedirectHop,
} from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import type { RuleContext } from "../src/types";

import { canonicalChainRule } from "../src/crawl/canonical-chain";
import { redirectChainRule } from "../src/crawl/redirect-chain";
import { redirectChainsRule } from "../src/links/redirect-chains";

const SOURCE = "https://example.com/o-mnie";
const LANDING = "https://example.com/o-mnie/";

function hop(url: string, statusCode: number): RedirectHop {
  return { url, statusCode, type: "http" };
}

/** The shape the cloud render path produces: source hop unobserved, landing 200. */
function renderChain(hops: RedirectHop[]): RedirectChain {
  return {
    sourceUrl: hops[0]!.url,
    finalUrl: hops[hops.length - 1]!.url,
    hops,
    chainLength: Math.max(0, hops.length - 1),
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };
}

const UNOBSERVED = renderChain([hop(SOURCE, 0), hop(LANDING, 200)]);
// Long enough to trip crawl/redirect-chain's default maxHops of 2.
const UNOBSERVED_LONG = renderChain([
  hop(SOURCE, 0),
  hop("https://example.com/mid/", 0),
  hop("https://example.com/mid2/", 0),
  hop(LANDING, 200),
]);

const html = `<!doctype html><html><head><title>t</title>
<link rel="canonical" href="${LANDING}"></head><body><p>hello there</p></body></html>`;

function pageCtx(chain: RedirectChain): RuleContext {
  return {
    page: { url: SOURCE, finalUrl: LANDING, statusCode: 200, html, redirectChain: chain },
    parsed: parsePage(html, LANDING),
    site: { baseUrl: "https://example.com", pages: [] },
    options: {},
  } as unknown as RuleContext;
}

function siteCtx(chain: RedirectChain): RuleContext {
  return {
    page: { url: SOURCE, finalUrl: LANDING, statusCode: 200, html },
    parsed: parsePage(html, LANDING),
    site: {
      baseUrl: "https://example.com",
      pages: [{ url: SOURCE, finalUrl: LANDING, redirectChain: chain, parsed: { links: [] } }],
    },
    options: {},
  } as unknown as RuleContext;
}

/**
 * Every rendered string a rule emitted: labels, messages, item ids, AND the
 * `meta` / `details` payloads. `crawl/redirect-chain` only ever puts its chain
 * string in `meta.chain` and `details.chain`, and those are serialized into the
 * report, so a check that looked at labels alone passed with the bug still in
 * place.
 */
function emittedText(result: { checks: { message?: string; items?: unknown[] }[] }): string[] {
  const out: string[] = [];
  for (const check of result.checks) {
    if (check.message) out.push(check.message);
    for (const item of (check.items ?? []) as { label?: string; id?: string }[]) {
      if (item.label) out.push(item.label);
      if (item.id) out.push(item.id);
    }
    // Whole-check serialization, so nothing renderable escapes the assertion.
    out.push(JSON.stringify(check));
  }
  return out;
}

describe("formatRedirectHop", () => {
  test("renders an observed status", () => {
    expect(formatRedirectHop(hop(SOURCE, 301))).toBe(`${SOURCE} (301)`);
  });

  test("renders an unobserved hop bare, never as (0)", () => {
    expect(formatRedirectHop(hop(SOURCE, 0))).toBe(SOURCE);
  });

  test("honours a display URL override", () => {
    expect(formatRedirectHop(hop(SOURCE, 301), "/o-mnie")).toBe("/o-mnie (301)");
    expect(formatRedirectHop(hop(SOURCE, 0), "/o-mnie")).toBe("/o-mnie");
  });
});

describe("no rule renders (0) for an unobserved hop", () => {
  const cases: [string, () => { checks: { message?: string; items?: unknown[] }[] }][] = [
    ["crawl/canonical-chain", () => canonicalChainRule.run(pageCtx(UNOBSERVED))],
    ["crawl/canonical-chain (long)", () => canonicalChainRule.run(pageCtx(UNOBSERVED_LONG))],
    ["crawl/redirect-chain", () => redirectChainRule.run(siteCtx(UNOBSERVED_LONG))],
    ["links/redirect-chains", () => redirectChainsRule.run(siteCtx(UNOBSERVED))],
  ];

  test.each(cases)("%s", (_name, run) => {
    const text = emittedText(run());
    // Non-vacuous: the rule really did report something to inspect.
    expect(text.length).toBeGreaterThan(0);
    for (const line of text) {
      expect(line).not.toContain("(0)");
    }
  });

  test("the unobserved hop's URL is still shown, just without a status", () => {
    const labels = emittedText(canonicalChainRule.run(pageCtx(UNOBSERVED)));
    const chainLabel = labels.find((l) => l.includes(" → "));
    expect(chainLabel).toBe(`${SOURCE} → ${LANDING} (200)`);
  });

  test("an observed status is still rendered", () => {
    const observed = renderChain([hop(SOURCE, 301), hop(LANDING, 200)]);
    const labels = emittedText(canonicalChainRule.run(pageCtx(observed)));
    expect(labels.some((l) => l.includes("(301)"))).toBe(true);
  });
});
