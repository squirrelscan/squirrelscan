// #1258: the seed is one blocked page however many URLs reach it, and suspect pages
// are folded into a capped summary.

import { describe, expect, test } from "bun:test";

import {
  MAX_WAF_BLOCKED_PAGES,
  addWafBlockedPage,
  addWafSuspectPage,
  wafBlockedPage,
  type WafSuspectPage,
} from "../src/waf-block";

const blocked = (url: string) =>
  wafBlockedPage({
    url,
    status: 403,
    provider: "Cloudflare",
    providerId: "cloudflare",
    signal: "cf-mitigated: challenge header",
  });

describe("addWafBlockedPage: the seed counts once", () => {
  test("a second sighting of the seed adds nothing", () => {
    let summary = addWafBlockedPage(undefined, blocked("https://example.com/challenge"), true);
    summary = addWafBlockedPage(summary, blocked("https://example.com/"), true);
    expect(summary.total).toBe(1);
    expect(summary.seed?.url).toBe("https://example.com/challenge");
    expect(summary.pages).toEqual([]);
  });

  test("other blocked pages still count and list", () => {
    let summary = addWafBlockedPage(undefined, blocked("https://example.com/"), true);
    summary = addWafBlockedPage(summary, blocked("https://example.com/a"), false);
    summary = addWafBlockedPage(summary, blocked("https://example.com/b"), false);
    expect(summary.total).toBe(3);
    expect(summary.pages.map((p) => p.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});

const suspect = (url: string): WafSuspectPage => ({
  url,
  status: 406,
  provider: "Cloudflare",
  providerId: "cloudflare",
  signal: "refusal page from Cloudflare with no provider block marker",
});

describe("addWafSuspectPage", () => {
  test("counts every page, lists each URL once and names providers once", () => {
    let summary = addWafSuspectPage(undefined, suspect("https://example.com/a"));
    summary = addWafSuspectPage(summary, suspect("https://example.com/a"));
    summary = addWafSuspectPage(summary, suspect("https://example.com/b"));
    expect(summary.total).toBe(3);
    expect(summary.pages.map((p) => p.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(summary.providers).toEqual(["Cloudflare"]);
  });

  test("the list is capped, the total is not", () => {
    let summary = addWafSuspectPage(undefined, suspect("https://example.com/0"));
    for (let i = 1; i < MAX_WAF_BLOCKED_PAGES + 10; i++) {
      summary = addWafSuspectPage(summary, suspect(`https://example.com/${i}`));
    }
    expect(summary.pages.length).toBe(MAX_WAF_BLOCKED_PAGES);
    expect(summary.total).toBe(MAX_WAF_BLOCKED_PAGES + 10);
  });
});
