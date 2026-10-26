// robots.txt is site-controlled input, read by the CLI, the cloud audit
// container and the web AI crawler checker. A file inside the 512 KiB fetch cap
// must not be able to exhaust memory or time: stacked user agents multiply
// with their group's rules, so the parsed data holds a bounded number of
// directive entries and rule characters (ROBOTS_MAX_DIRECTIVE_ENTRIES,
// ROBOTS_MAX_RULE_CHARS). Inputs here run to 2 MB, past any cap a caller
// applies.

import { describe, expect, test } from "bun:test";

import {
  ROBOTS_MAX_DIRECTIVE_ENTRIES,
  ROBOTS_MAX_RULE_CHARS,
  isRobotsTxtDisallowed,
  parseRobotsTxt,
} from "../src/robots-txt";

const URL_ = "https://example.com/robots.txt";
const entriesOf = (rules: ReturnType<typeof parseRobotsTxt>["rules"]) =>
  rules.reduce((sum, group) => sum + Math.max(1, group.rules.length), 0);
const charsOf = (rules: ReturnType<typeof parseRobotsTxt>["rules"]) =>
  rules.reduce((sum, group) => sum + group.rules.reduce((n, r) => n + r.path.length, 0), 0);

/** Run `fn`, returning its result and the wall time it took. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("parseRobotsTxt stays bounded on adversarial files", () => {
  test("stacked user agents over many rules stop at the entry budget", () => {
    // ~1.1 MB: 40,000 user agents sharing 40,000 rules would be 1.6 billion entries.
    const content = "User-agent: a\n".repeat(40_000) + "Disallow: /x\n".repeat(40_000);
    const { value, ms } = timed(() => parseRobotsTxt(content, URL_));

    expect(entriesOf(value.rules)).toBeLessThanOrEqual(ROBOTS_MAX_DIRECTIVE_ENTRIES);
    expect(value.errors.some((e) => e.includes("the rest of the file was not read"))).toBe(true);
    expect(ms).toBeLessThan(5_000);
  }, 30_000);

  test("one huge group keeps its first rules, in file order", () => {
    const content = "User-agent: *\nDisallow: /\n" + "Disallow: /x\n".repeat(150_000);
    const { value, ms } = timed(() => parseRobotsTxt(content, URL_));

    expect(value.rules).toHaveLength(1);
    expect(value.rules[0]!.rules).toHaveLength(ROBOTS_MAX_DIRECTIVE_ENTRIES);
    expect(value.errors).toHaveLength(1);
    expect(value.rules[0]!.rules[0]).toEqual({ type: "disallow", path: "/" });
    expect(isRobotsTxtDisallowed("https://example.com/a", value, "GPTBot")).toBe(true);
    expect(ms).toBeLessThan(5_000);
  }, 30_000);

  test("a group cut between two agents keeps whole rules in file order for each", () => {
    const content = "User-agent: a\nUser-agent: b\n" + "Disallow: /x\n".repeat(60_000);
    const result = parseRobotsTxt(content, URL_);

    expect(result.rules.map((g) => [g.userAgent, g.rules.length])).toEqual([
      ["a", 60_000],
      ["b", ROBOTS_MAX_DIRECTIVE_ENTRIES - 60_000],
    ]);
  });

  test("stacked agents over one very long rule stop at the character budget", () => {
    // ~290 KB: 2,000 copies of a 250,000-character rule would be 500 MB of rule text.
    const content =
      "User-agent: GPTBot\n".repeat(2_000) + `Disallow: /${"a".repeat(250_000)}\n`;
    const { value, ms } = timed(() => parseRobotsTxt(content, URL_));

    expect(charsOf(value.rules)).toBeLessThanOrEqual(ROBOTS_MAX_RULE_CHARS);
    expect(value.rules.length).toBeLessThan(10);
    expect(value.errors).toHaveLength(1);
    expect(ms).toBeLessThan(5_000);

    // And a crawl's worth of URL checks against it stays fast.
    const check = timed(() => {
      for (let i = 0; i < 500; i++) {
        isRobotsTxtDisallowed(`https://example.com/${"a".repeat(i)}`, value, "GPTBot");
      }
    });
    expect(check.ms).toBeLessThan(10_000);
  }, 30_000);

  test("Sitemap lines after the budget are still collected", () => {
    const content =
      "User-agent: *\n" +
      "Disallow: /x\n".repeat(ROBOTS_MAX_DIRECTIVE_ENTRIES + 10) +
      "User-agent: GPTBot\nDisallow: /\nSitemap: https://example.com/late.xml\n";
    const result = parseRobotsTxt(content, URL_);

    expect(result.rules.map((g) => g.userAgent)).toEqual(["*"]);
    expect(result.sitemaps).toEqual(["https://example.com/late.xml"]);
  });

  // Linear in rules times URLs (about 16 ms a URL here), never worse.
  test("URL checks against 80,000 wildcard rules stay linear", () => {
    const content = "User-agent: *\n" + "Disallow: /private-*/page$\n".repeat(80_000);
    const robots = parseRobotsTxt(content, URL_);
    const { ms } = timed(() => {
      for (let i = 0; i < 200; i++) {
        isRobotsTxtDisallowed(`https://example.com/public-${i}/page`, robots, "Googlebot");
      }
    });

    expect(ms).toBeLessThan(15_000);
  }, 30_000);

  test("a file under the budget is read whole, with no error", () => {
    const content = "User-agent: a\nUser-agent: b\n" + "Disallow: /x\n".repeat(1_000);
    const result = parseRobotsTxt(content, URL_);

    expect(result.rules.map((g) => g.rules.length)).toEqual([1_000, 1_000]);
    expect(result.errors).toEqual([]);
  });

  test.each([
    ["one 2 MB line with no line break", "User-agent: *" + " Disallow: /".repeat(170_000)],
    ["2 MB of CR-only line endings", "User-agent: a\rDisallow: /x\r".repeat(75_000)],
    ["2 MB of comments", "# x\n".repeat(500_000)],
  ])("%s parses in bounded time", (_name, content) => {
    const { value, ms } = timed(() => parseRobotsTxt(content, URL_));

    expect(entriesOf(value.rules)).toBeLessThanOrEqual(ROBOTS_MAX_DIRECTIVE_ENTRIES);
    expect(ms).toBeLessThan(5_000);
  }, 30_000);

  test("a rule of 100,000 wildcards matches in bounded time", () => {
    const pattern = `/${"*a".repeat(100_000)}$`;
    const robots = parseRobotsTxt(`User-agent: *\nDisallow: ${pattern}\n`, URL_);
    const { value, ms } = timed(() =>
      isRobotsTxtDisallowed(`https://example.com/${"a".repeat(2_000)}b`, robots, "Googlebot"),
    );

    expect(value).toBe(false);
    expect(ms).toBeLessThan(5_000);
  }, 30_000);
});
