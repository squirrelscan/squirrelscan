// Tests for processors/discovery/fetch-robots.ts - Robots.txt parsing and fetching

import { describe, it, expect } from "bun:test";

import { parseRobotsTxt, isUrlAllowed } from "../../../../src/crawl/robots";

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

describe("isUrlAllowed", () => {
  const baseRobotsTxt = {
    exists: true,
    url: "https://example.com/robots.txt",
    content: "",
    sizeBytes: 0,
    sitemaps: [],
    errors: [],
  };

  it("allows all when robots.txt doesn't exist", () => {
    const robotsTxt = { ...baseRobotsTxt, exists: false, rules: [] };
    expect(isUrlAllowed(robotsTxt, "https://example.com/anything", "*")).toBe(
      true
    );
  });

  it("allows when no matching rules", () => {
    const robotsTxt = { ...baseRobotsTxt, rules: [] };
    expect(isUrlAllowed(robotsTxt, "https://example.com/page", "*")).toBe(true);
  });

  it("blocks disallowed paths", () => {
    const robotsTxt = {
      ...baseRobotsTxt,
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "disallow" as const, path: "/private" }],
        },
      ],
    };

    expect(
      isUrlAllowed(robotsTxt, "https://example.com/private/page", "*")
    ).toBe(false);
    expect(isUrlAllowed(robotsTxt, "https://example.com/public", "*")).toBe(
      true
    );
  });

  it("respects allow rules", () => {
    const robotsTxt = {
      ...baseRobotsTxt,
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "allow" as const, path: "/allowed" }],
        },
      ],
    };

    expect(
      isUrlAllowed(robotsTxt, "https://example.com/allowed/page", "*")
    ).toBe(true);
  });

  it("matches specific user agents", () => {
    const robotsTxt = {
      ...baseRobotsTxt,
      rules: [
        {
          userAgent: "Googlebot",
          rules: [{ type: "disallow" as const, path: "/google-blocked" }],
        },
        {
          userAgent: "*",
          rules: [{ type: "disallow" as const, path: "/all-blocked" }],
        },
      ],
    };

    // Googlebot matches specific rule
    expect(
      isUrlAllowed(
        robotsTxt,
        "https://example.com/google-blocked",
        "Googlebot/2.1"
      )
    ).toBe(false);

    // Other bots only match wildcard
    expect(
      isUrlAllowed(robotsTxt, "https://example.com/google-blocked", "Bingbot")
    ).toBe(true);

    // All bots blocked by wildcard
    expect(
      isUrlAllowed(robotsTxt, "https://example.com/all-blocked", "Bingbot")
    ).toBe(false);
  });

  it("handles root disallow", () => {
    const robotsTxt = {
      ...baseRobotsTxt,
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "disallow" as const, path: "/" }],
        },
      ],
    };

    expect(isUrlAllowed(robotsTxt, "https://example.com/anything", "*")).toBe(
      false
    );
    expect(isUrlAllowed(robotsTxt, "https://example.com/", "*")).toBe(false);
  });
});
