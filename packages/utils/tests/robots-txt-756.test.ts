// robots.txt parsing, as the crawl reads it. Moved from the CLI's robots copy
// (#756), which the crawl no longer ran; which URLs are allowed is the
// crawler's evaluator, tested in packages/crawler/tests/robots-evaluator-756.

import { describe, it, expect } from "bun:test";

import { parseRobotsTxt } from "../src/robots-txt";

describe("parseRobotsTxt", () => {
  it("parses simple robots.txt", () => {
    const content = `
User-agent: *
Disallow: /private/
Allow: /public/
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.exists).toBe(true);
    expect(result.url).toBe("https://example.com/robots.txt");
    expect(result.rules.length).toBe(1);
    expect(result.rules[0].userAgent).toBe("*");
    expect(result.rules[0].rules).toContainEqual({
      type: "disallow",
      path: "/private/",
    });
    expect(result.rules[0].rules).toContainEqual({
      type: "allow",
      path: "/public/",
    });
  });

  it("parses multiple user agents", () => {
    const content = `
User-agent: Googlebot
Disallow: /google-only/

User-agent: Bingbot
Disallow: /bing-only/
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules.length).toBe(2);
    expect(result.rules[0].userAgent).toBe("Googlebot");
    expect(result.rules[1].userAgent).toBe("Bingbot");
  });

  it("extracts sitemaps", () => {
    const content = `
User-agent: *
Disallow:

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-posts.xml
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.sitemaps.length).toBe(2);
    expect(result.sitemaps).toContain("https://example.com/sitemap.xml");
    expect(result.sitemaps).toContain("https://example.com/sitemap-posts.xml");
  });

  it("parses crawl delay", () => {
    const content = `
User-agent: *
Crawl-delay: 5
Disallow: /slow/
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules[0].crawlDelay).toBe(5);
  });

  it("keeps a user-agent group whose only directive is crawl delay", () => {
    const content = `
User-agent: *
Crawl-delay: 10
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules).toEqual([{ userAgent: "*", rules: [], crawlDelay: 10 }]);
  });

  // #1145: only a real delay is stored. A negative one, or one past a double
  // (`1e999` is Infinity, which a published report serializes as null), is
  // ignored like an unparseable one, so a strict reader of the report never
  // sees it.
  it.each([["-1"], ["1e999"], ["-1e999"], ["Infinity"], ["NaN"], ["soon"]])(
    "ignores a Crawl-delay of %s",
    (delay) => {
      const alone = parseRobotsTxt(
        `User-agent: *\nCrawl-delay: ${delay}\n`,
        "https://example.com/robots.txt",
      );
      expect(alone.rules).toEqual([]);
      const withRules = parseRobotsTxt(
        `User-agent: *\nCrawl-delay: ${delay}\nDisallow: /x\n`,
        "https://example.com/robots.txt",
      );
      expect(withRules.rules).toEqual([
        { userAgent: "*", rules: [{ type: "disallow", path: "/x" }], crawlDelay: undefined },
      ]);
    },
  );

  it.each([
    ["0", 0],
    ["2.5", 2.5],
    ["10", 10],
  ])("keeps a Crawl-delay of %s", (delay, expected) => {
    const result = parseRobotsTxt(
      `User-agent: *\nCrawl-delay: ${delay}\n`,
      "https://example.com/robots.txt",
    );
    expect(result.rules).toEqual([{ userAgent: "*", rules: [], crawlDelay: expected }]);
  });

  it("applies one group's directives to every stacked user agent", () => {
    const content = `
User-agent: BingBot
User-agent: AhrefsBot
Crawl-delay: 10
Disallow: /slow/
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules).toEqual([
      {
        userAgent: "BingBot",
        rules: [{ type: "disallow", path: "/slow/" }],
        crawlDelay: 10,
      },
      {
        userAgent: "AhrefsBot",
        rules: [{ type: "disallow", path: "/slow/" }],
        crawlDelay: 10,
      },
    ]);
  });

  it("ignores inline comments", () => {
    const content = `
# This is a comment
User-agent: *
# Another comment
Disallow: / # no training
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules.length).toBe(1);
    expect(result.rules[0].rules).toEqual([{ type: "disallow", path: "/" }]);
  });

  it("shares a group's rules across stacked user agents", () => {
    const content = `
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules).toEqual([
      { userAgent: "GPTBot", rules: [{ type: "disallow", path: "/" }] },
      { userAgent: "ClaudeBot", rules: [{ type: "disallow", path: "/" }] },
    ]);
  });

  it("keeps a named group whose only rule is an empty disallow", () => {
    const content = `
User-agent: GPTBot
Disallow:

User-agent: *
Disallow: /
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules).toEqual([
      { userAgent: "GPTBot", rules: [] },
      { userAgent: "*", rules: [{ type: "disallow", path: "/" }] },
    ]);
  });

  // RFC 9309 2.2.4: records outside the protocol (Sitemap, Crawl-delay, unknown
  // lines) must not change how groups are read. Only Allow and Disallow close
  // a group's user-agent lines, as in Google's parser.
  it.each([
    ["a Sitemap", "Sitemap: https://example.com/sitemap.xml"],
    ["a Crawl-delay", "Crawl-delay: 5"],
    ["an unknown record", "Host: example.com"],
  ])("%s between user-agent lines does not split their group", (_name, record) => {
    const result = parseRobotsTxt(
      `User-agent: GPTBot\n${record}\nUser-agent: CCBot\nDisallow: /\n`,
      "https://example.com/robots.txt",
    );

    expect(result.rules.map((g) => [g.userAgent, g.rules])).toEqual([
      ["GPTBot", [{ type: "disallow", path: "/" }]],
      ["CCBot", [{ type: "disallow", path: "/" }]],
    ]);
  });

  it("a Crawl-delay before stacked user agents applies to the whole group", () => {
    const result = parseRobotsTxt(
      "User-agent: BingBot\nCrawl-delay: 10\nUser-agent: AhrefsBot\nDisallow: /slow/\n",
      "https://example.com/robots.txt",
    );

    expect(result.rules.map((g) => [g.userAgent, g.crawlDelay])).toEqual([
      ["BingBot", 10],
      ["AhrefsBot", 10],
    ]);
  });

  it("a user-agent after an Allow or Disallow still starts a new group", () => {
    const result = parseRobotsTxt(
      "User-agent: A\nDisallow: /\nSitemap: https://example.com/s.xml\nUser-agent: B\nAllow: /\n",
      "https://example.com/robots.txt",
    );

    expect(result.rules).toEqual([
      { userAgent: "A", rules: [{ type: "disallow", path: "/" }] },
      { userAgent: "B", rules: [{ type: "allow", path: "/" }] },
    ]);
    expect(result.sitemaps).toEqual(["https://example.com/s.xml"]);
  });

  it("reads CR-only and CRLF line endings", () => {
    for (const eol of ["\r", "\r\n"]) {
      const result = parseRobotsTxt(
        `User-agent: *${eol}Disallow: /private/${eol}Sitemap: https://example.com/s.xml${eol}`,
        "https://example.com/robots.txt",
      );

      expect(result.rules).toEqual([
        { userAgent: "*", rules: [{ type: "disallow", path: "/private/" }] },
      ]);
      expect(result.sitemaps).toEqual(["https://example.com/s.xml"]);
    }
  });

  it("handles empty content", () => {
    const result = parseRobotsTxt("", "https://example.com/robots.txt");

    expect(result.exists).toBe(true);
    expect(result.rules.length).toBe(0);
    expect(result.sitemaps.length).toBe(0);
  });

  it("handles malformed lines", () => {
    const content = `
User-agent: *
This is not a valid directive
Disallow: /valid/
: empty directive
NoColonHere
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules.length).toBe(1);
    expect(result.rules[0].rules.length).toBe(1);
    expect(result.rules[0].rules[0].path).toBe("/valid/");
  });

  it("handles case-insensitive directives", () => {
    const content = `
USER-AGENT: *
DISALLOW: /upper/
disallow: /lower/
Disallow: /mixed/
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules[0].rules.length).toBe(3);
  });

  it("ignores empty disallow values", () => {
    const content = `
User-agent: *
Disallow:
Allow: /
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    // Empty disallow means allow all
    expect(result.rules[0].rules.length).toBe(1);
    expect(result.rules[0].rules[0].type).toBe("allow");
  });

  it("calculates content size", () => {
    const content = "User-agent: *\nDisallow: /";
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.sizeBytes).toBe(content.length);
  });
});
