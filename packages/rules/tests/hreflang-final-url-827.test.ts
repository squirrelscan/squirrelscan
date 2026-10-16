// pub#827: i18n/hreflang compares a redirected page's self reference with the
// URL an HTTP redirect ended on. Only an all-HTTP chain with an observed 3xx
// counts: a render that navigated, or an end that will not parse, keeps the
// page URL.

import { describe, expect, test } from "bun:test";

import type { RedirectChain } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { hreflangRule } from "../src/i18n/hreflang";
import type { RuleContext } from "../src/types";

const OLD = "https://example.com/en/old";
const NEW = "https://example.com/en/new";

function names(url: string, redirectChain: RedirectChain | undefined): string[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title><link rel="alternate" hreflang="en" href="${NEW}"><link rel="alternate" hreflang="x-default" href="${NEW}"></head><body></body></html>`;
  const ctx = {
    page: {
      url,
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
      ...(redirectChain ? { redirectChain, finalUrl: redirectChain.finalUrl } : {}),
    },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  return hreflangRule.run(ctx).checks.map((c) => `${c.name}:${c.status}`);
}

function chain(finalUrl: string, hops: RedirectChain["hops"]): RedirectChain {
  return { sourceUrl: OLD, finalUrl, hops, chainLength: hops.length - 1, isLoop: false, endsInError: false };
}

describe("i18n/hreflang self reference after a redirect (pub#827)", () => {
  test("an HTTP redirect is judged by the URL it ended on", () => {
    const http = chain(NEW, [
      { url: OLD, statusCode: 301, type: "http" },
      { url: NEW, statusCode: 200, type: "http" },
    ]);
    expect(names(OLD, http)).toEqual(["hreflang:pass"]);
  });

  test("no redirect, a client-side hop, an unobserved hop or an unparseable end keeps the page URL", () => {
    expect(names(NEW, undefined)).toEqual(["hreflang:pass"]);
    expect(names(OLD, undefined)).toContain("hreflang-self:warn");
    const js = chain(NEW, [
      { url: OLD, statusCode: 200, type: "javascript" },
      { url: NEW, statusCode: 200, type: "http" },
    ]);
    expect(names(OLD, js)).toContain("hreflang-self:warn");
    const unobserved = chain(NEW, [
      { url: OLD, statusCode: 0, type: "http" },
      { url: NEW, statusCode: 200, type: "http" },
    ]);
    expect(names(OLD, unobserved)).toContain("hreflang-self:warn");
    const broken = chain("not a url", [
      { url: OLD, statusCode: 301, type: "http" },
      { url: "not a url", statusCode: 200, type: "http" },
    ]);
    expect(names(OLD, broken)).toContain("hreflang-self:warn");
  });
});
