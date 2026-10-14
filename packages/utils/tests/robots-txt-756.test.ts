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

  it("handles comments", () => {
    const content = `
# This is a comment
User-agent: *
# Another comment
Disallow: /private/ # inline comment is NOT standard
`;
    const result = parseRobotsTxt(content, "https://example.com/robots.txt");

    expect(result.rules.length).toBe(1);
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
