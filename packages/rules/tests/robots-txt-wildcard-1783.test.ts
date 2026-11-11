// #1783: `User-agent: *` with `Disallow: /` does not mean every crawler is blocked when a named group re-allows some.
// `robots-txt-disallow` keeps its meaning (every crawler blocked); a wildcard block with named re-allows is the
// lower-severity `robots-txt-disallow-wildcard`, which names the crawlers still let in.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";

import { robotsTxtRule } from "../src/crawl/robots-txt";
import type { ParsedPage, RuleContext } from "../src/types";

function run(content: string): CheckResult[] {
  const robotsTxt = parseRobotsTxt(content, "https://example.com/robots.txt");
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt, sitemaps: null },
    options: {},
  } as RuleContext;
  return robotsTxtRule.run(ctx).checks;
}
const named = (checks: CheckResult[], name: string) => checks.find((c) => c.name === name);

describe("crawl/robots-txt: a wildcard block and named re-allows (#1783)", () => {
  test("wildcard only: every crawler is blocked, the old fail, and no wildcard row", () => {
    const checks = run("User-agent: *\nDisallow: /\n");
    expect(named(checks, "robots-txt-disallow")).toMatchObject({ status: "fail", message: "robots.txt blocks all crawling" });
    expect(named(checks, "robots-txt-disallow-wildcard")).toBeUndefined();
  });

  test("a wildcard block with a Googlebot allow: a separate warn row naming the allowed crawlers, and no fail", () => {
    const checks = run("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: Bingbot\nDisallow:\n");
    const wide = named(checks, "robots-txt-disallow-wildcard")!;
    expect(wide.status).toBe("warn");
    expect(wide.message).toContain("Googlebot, Bingbot");
    expect(wide.message).toContain("without a group of its own");
    expect(wide.details?.allowed).toEqual(["Googlebot", "Bingbot"]);
    // Not every crawler is blocked, so the old check no longer says so.
    expect(named(checks, "robots-txt-disallow")?.status).toBe("pass");
    expect(checks.some((c) => c.status === "fail" && c.name === "robots-txt-disallow")).toBe(false);
  });

  test("a wildcard block with a named Disallow for another bot: still every crawler, the fail", () => {
    const checks = run("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /\n");
    expect(named(checks, "robots-txt-disallow")?.status).toBe("fail");
    expect(named(checks, "robots-txt-disallow-wildcard")).toBeUndefined();
  });

  test("a named allow beside a named block names only the one allowed", () => {
    const checks = run("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n");
    expect(named(checks, "robots-txt-disallow-wildcard")?.details?.allowed).toEqual(["Googlebot"]);
  });

  test("no wildcard block: the pass is as before", () => {
    const checks = run("User-agent: *\nDisallow: /private\n");
    expect(named(checks, "robots-txt-disallow")).toMatchObject({ status: "pass", message: "robots.txt does not block all crawling" });
    expect(named(checks, "robots-txt-disallow-wildcard")).toBeUndefined();
  });

  test("a re-allow of an AI crawler alone does not downgrade: Google and Bing are still out, so it still fails", () => {
    const checks = run("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n");
    expect(named(checks, "robots-txt-disallow")).toMatchObject({ status: "fail", message: "robots.txt blocks all crawling" });
    expect(named(checks, "robots-txt-disallow")?.details?.allowedByName).toEqual(["GPTBot"]);
    expect(named(checks, "robots-txt-disallow-wildcard")).toBeUndefined();
  });

  test("a major search crawler re-allowed gives the warn, and the other re-allowed bots are listed in its details", () => {
    const checks = run("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: Googlebot\nAllow: /\n");
    const wide = named(checks, "robots-txt-disallow-wildcard")!;
    expect(wide.details?.allowed).toEqual(["Googlebot"]);
    expect(wide.details?.otherAllowed).toEqual(["GPTBot"]);
    expect(wide.message).not.toContain("GPTBot");
  });

  test("each of the short list of major crawlers counts, in any case", () => {
    for (const token of ["Bingbot", "bingbot", "DuckDuckBot", "YandexBot", "Applebot"]) {
      const checks = run(`User-agent: *\nDisallow: /\n\nUser-agent: ${token}\nAllow: /\n`);
      expect(named(checks, "robots-txt-disallow-wildcard"), token).toBeDefined();
    }
  });

  test("the whole site is judged by the crawl's own matcher: `Disallow: /*` blocks it", () => {
    // `/*` blocks every path, the root and the deep probe included
    expect(named(run("User-agent: *\nDisallow: /*\n"), "robots-txt-disallow")?.status).toBe("fail");
    // a named group whose own `Disallow: /*` blocks the site is not a re-allow
    expect(
      named(run("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /*\n"), "robots-txt-disallow-wildcard")
    ).toBeUndefined();
    // `/*` under `*` with a Googlebot allow: the warn, not the fail
    const star = run("User-agent: *\nDisallow: /*\n\nUser-agent: Googlebot\nAllow: /\n");
    expect(named(star, "robots-txt-disallow-wildcard")?.status).toBe("warn");
    expect(named(star, "robots-txt-disallow")?.status).toBe("pass");
  });

  test("a homepage-only rule is not a whole-site block: `Disallow: /$` under `*` is a pass, not a fail", () => {
    const checks = run("User-agent: *\nDisallow: /$\n");
    expect(named(checks, "robots-txt-disallow")).toMatchObject({ status: "pass", message: "robots.txt does not block all crawling" });
    expect(named(checks, "robots-txt-disallow-wildcard")).toBeUndefined();
  });

  test("a real prefix rule is not mistaken for a whole-site block: `Disallow: /$` with `Disallow: /s` is a pass", () => {
    // `/s` would have matched a single probe under /squirrel...; two probes with unlike first characters need a
    // rule for the whole site to take both.
    const checks = run("User-agent: *\nDisallow: /$\nDisallow: /s\n");
    expect(named(checks, "robots-txt-disallow")).toMatchObject({ status: "pass" });
    expect(named(checks, "robots-txt-disallow-wildcard")).toBeUndefined();
    expect(named(run("User-agent: *\nDisallow: /z\nDisallow: /~\nDisallow: /$\n"), "robots-txt-disallow")?.status).toBe("fail");
  });

  test("a group that re-permits only the homepage is not a re-allow of the site", () => {
    // Googlebot: `Disallow: /` with `Allow: /$` lets in "/" and nothing else
    const onlyHome = run("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /\nAllow: /$\n");
    expect(named(onlyHome, "robots-txt-disallow-wildcard")).toBeUndefined();
    expect(named(onlyHome, "robots-txt-disallow")?.status).toBe("fail");
    // A Googlebot group with only `Allow: /$` is different: it has a group of its own and nothing in it blocks, so
    // the wildcard no longer applies to Googlebot and the whole site is open to it. That IS a re-allow.
    const allowRootOnly = run("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /$\n");
    expect(named(allowRootOnly, "robots-txt-disallow-wildcard")?.details?.allowed).toEqual(["Googlebot"]);
  });

  test("an ordinary partial disallow is still a pass", () => {
    expect(named(run("User-agent: *\nDisallow: /private*\n"), "robots-txt-disallow")?.status).toBe("pass");
  });
});
