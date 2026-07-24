import { describe, it, expect } from "bun:test";

import type { RobotsTxtData } from "@/types";

import { isRobotsTxtDisallowed } from "@/utils/robots-txt";

describe("isRobotsTxtDisallowed", () => {
  it("returns false when robotsTxt is null", () => {
    expect(isRobotsTxtDisallowed("https://example.com/page", null)).toBe(false);
  });

  it("returns false when robots.txt does not exist", () => {
    const robotsTxt: RobotsTxtData = {
      exists: false,
      url: "https://example.com/robots.txt",
      content: null,
      sizeBytes: 0,
      sitemaps: [],
      rules: [],
      errors: [],
    };

    expect(isRobotsTxtDisallowed("https://example.com/page", robotsTxt)).toBe(
      false
    );
  });

  it("returns false when URL has no pathname", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: *\nDisallow: /admin/",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "disallow", path: "/admin/" }],
        },
      ],
      errors: [],
    };

    expect(isRobotsTxtDisallowed("invalid-url", robotsTxt)).toBe(false);
  });

  it("returns false when no matching user-agent rules", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: BadBot\nDisallow: /",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "BadBot",
          rules: [{ type: "disallow", path: "/" }],
        },
      ],
      errors: [],
    };

    expect(
      isRobotsTxtDisallowed("https://example.com/page", robotsTxt, "Googlebot")
    ).toBe(false);
  });

  it("returns true when path is disallowed for Googlebot", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: Googlebot\nDisallow: /admin/",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "Googlebot",
          rules: [{ type: "disallow", path: "/admin/" }],
        },
      ],
      errors: [],
    };

    expect(
      isRobotsTxtDisallowed("https://example.com/admin/page", robotsTxt)
    ).toBe(true);
  });

  it("returns false when path is allowed", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: *\nAllow: /api/",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "allow", path: "/api/" }],
        },
      ],
      errors: [],
    };

    expect(
      isRobotsTxtDisallowed("https://example.com/api/endpoint", robotsTxt)
    ).toBe(false);
  });

  it("returns false when path not matching any rules (default: allowed)", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: *\nDisallow: /admin/",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "disallow", path: "/admin/" }],
        },
      ],
      errors: [],
    };

    expect(
      isRobotsTxtDisallowed("https://example.com/public/page", robotsTxt)
    ).toBe(false);
  });

  it("falls back to wildcard user-agent when specific not found", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: *\nDisallow: /private/",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "disallow", path: "/private/" }],
        },
      ],
      errors: [],
    };

    expect(
      isRobotsTxtDisallowed(
        "https://example.com/private/page",
        robotsTxt,
        "CustomBot"
      )
    ).toBe(true);
  });

  it("prefers exact user-agent match over wildcard", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content:
        "User-agent: *\nDisallow: /admin/\nUser-agent: Googlebot\nAllow: /admin/",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "disallow", path: "/admin/" }],
        },
        {
          userAgent: "Googlebot",
          rules: [{ type: "allow", path: "/admin/" }],
        },
      ],
      errors: [],
    };

    // Googlebot should use its specific rule (allow)
    expect(
      isRobotsTxtDisallowed("https://example.com/admin/page", robotsTxt)
    ).toBe(false);
  });

  it("first matching rule wins", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: *\nDisallow: /admin/\nAllow: /admin/public/",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "*",
          rules: [
            { type: "disallow", path: "/admin/" },
            { type: "allow", path: "/admin/public/" },
          ],
        },
      ],
      errors: [],
    };

    // /admin/public/ starts with /admin/, so disallow rule matches first
    expect(
      isRobotsTxtDisallowed("https://example.com/admin/public/page", robotsTxt)
    ).toBe(true);

    // But if allow comes first for a different path structure
    const robotsTxt2: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: *\nAllow: /public/\nDisallow: /",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "*",
          rules: [
            { type: "allow", path: "/public/" },
            { type: "disallow", path: "/" },
          ],
        },
      ],
      errors: [],
    };

    // /public/page starts with /public/, so allow rule matches first
    expect(
      isRobotsTxtDisallowed("https://example.com/public/page", robotsTxt2)
    ).toBe(false);

    // /private/page starts with /, so disallow rule matches
    expect(
      isRobotsTxtDisallowed("https://example.com/private/page", robotsTxt2)
    ).toBe(true);
  });

  it("handles root path disallow", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: *\nDisallow: /",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "disallow", path: "/" }],
        },
      ],
      errors: [],
    };

    expect(
      isRobotsTxtDisallowed("https://example.com/any/page", robotsTxt)
    ).toBe(true);
    expect(isRobotsTxtDisallowed("https://example.com/", robotsTxt)).toBe(true);
  });

  it("uses Googlebot as default user-agent", () => {
    const robotsTxt: RobotsTxtData = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: Googlebot\nDisallow: /private/",
      sizeBytes: 100,
      sitemaps: [],
      rules: [
        {
          userAgent: "Googlebot",
          rules: [{ type: "disallow", path: "/private/" }],
        },
      ],
      errors: [],
    };

    // No user-agent specified, should default to Googlebot
    expect(
      isRobotsTxtDisallowed("https://example.com/private/page", robotsTxt)
    ).toBe(true);
  });
});
