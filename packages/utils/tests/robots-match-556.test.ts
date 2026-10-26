// pub#556: one "blocked by robots.txt" decision for every rule, matching how
// Google reads robots.txt: the group for the crawler (or `*`), the longest
// matching rule wins, Allow wins a tie, `*` matches any run of characters,
// a trailing `$` anchors the end, and the query string is part of the path.

import { describe, expect, test } from "bun:test";

import type { RobotsTxtData } from "@squirrelscan/core-contracts";

import { isRobotsTxtDisallowed, parseRobotsTxt } from "../src/robots-txt";

const robots = (content: string): RobotsTxtData => parseRobotsTxt(content, "https://example.com/robots.txt");
const blocked = (path: string, content: string) => isRobotsTxtDisallowed(`https://example.com${path}`, robots(content));

const FIXTURE = "User-agent: *\nDisallow: /blocked-\nDisallow: /dir/\nAllow: /dir/ok\nDisallow: /*.php\n";

describe("isRobotsTxtDisallowed (pub#556)", () => {
  test("the issue's fixture: prefixes, a longer Allow, and a wildcard", () => {
    expect(blocked("/blocked-header", FIXTURE)).toBe(true);
    expect(blocked("/blocked-meta", FIXTURE)).toBe(true);
    expect(blocked("/dir/ok", FIXTURE)).toBe(false);
    expect(blocked("/dir/other", FIXTURE)).toBe(true);
    expect(blocked("/x.php", FIXTURE)).toBe(true);
    expect(blocked("/open", FIXTURE)).toBe(false);
  });

  test("the longest rule wins whatever the order, and Allow wins a tie", () => {
    expect(blocked("/shop/cart", "User-agent: *\nAllow: /shop/cart\nDisallow: /shop/")).toBe(false);
    expect(blocked("/shop/cart", "User-agent: *\nDisallow: /shop/\nAllow: /shop/cart")).toBe(false);
    expect(blocked("/shop/x", "User-agent: *\nAllow: /shop/\nDisallow: /shop/x")).toBe(true);
    expect(blocked("/p", "User-agent: *\nDisallow: /p\nAllow: /p")).toBe(false);
  });

  test("`$` anchors the end; the query string is part of the path", () => {
    expect(blocked("/a.pdf", "User-agent: *\nDisallow: /*.pdf$")).toBe(true);
    expect(blocked("/a.pdf?v=1", "User-agent: *\nDisallow: /*.pdf$")).toBe(false);
    expect(blocked("/list?sort=price", "User-agent: *\nDisallow: /*?sort=")).toBe(true);
    expect(blocked("/list", "User-agent: *\nDisallow: /*?sort=")).toBe(false);
  });

  test("percent-encoding is normalised on both sides", () => {
    expect(blocked("/caf%C3%A9", "User-agent: *\nDisallow: /café")).toBe(true);
    expect(blocked("/caf%c3%a9/x", "User-agent: *\nDisallow: /caf%C3%A9/")).toBe(true);
    expect(blocked("/%66oo", "User-agent: *\nDisallow: /foo")).toBe(true);
    expect(blocked("/foo", "User-agent: *\nDisallow: /%66oo")).toBe(true);
    // An encoded reserved character stays encoded: `%2F` is not `/`.
    expect(blocked("/a/b", "User-agent: *\nDisallow: /a%2Fb")).toBe(false);
    expect(blocked("/a%20b", "User-agent: *\nDisallow: /a b")).toBe(true);
  });

  test("the crawler's own group wins over `*`, matched without case", () => {
    const content = "User-agent: *\nDisallow: /\n\nUser-agent: googlebot\nAllow: /\n";
    expect(blocked("/page", content)).toBe(false);
  });

  test("stacked user agents share the following rules", () => {
    const content = "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n";
    const data = robots(content);

    expect(isRobotsTxtDisallowed("https://example.com/page", data, "GPTBot")).toBe(true);
    expect(isRobotsTxtDisallowed("https://example.com/page", data, "ClaudeBot")).toBe(true);
  });

  test("an explicit empty disallow group overrides a blocked wildcard group", () => {
    const content = "User-agent: GPTBot\nDisallow:\n\nUser-agent: *\nDisallow: /\n";
    const data = robots(content);

    expect(isRobotsTxtDisallowed("https://example.com/page", data, "GPTBot")).toBe(false);
    expect(isRobotsTxtDisallowed("https://example.com/page", data, "OtherBot")).toBe(true);
  });

  test("inline comments do not become part of a rule path", () => {
    const content = "User-agent: *\nDisallow: / # no training\n";

    expect(blocked("/page", content)).toBe(true);
  });

  test("a long run of wildcards is matched in linear time", () => {
    const pattern = `/${"a*".repeat(200)}b`;
    const start = performance.now();
    expect(blocked(`/${"a".repeat(5000)}`, `User-agent: *\nDisallow: ${pattern}`)).toBe(false);
    // Generous for a loaded CI box: a backtracking matcher takes minutes here.
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
