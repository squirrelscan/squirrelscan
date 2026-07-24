import { describe, it, expect } from "bun:test";

import type { RobotsTxtData } from "@/types";

import { isPageIndexable } from "@/utils/indexable";

describe("isPageIndexable", () => {
  it("returns indexable for pages without noindex", () => {
    const parsed = { meta: { robots: "" } };
    const result = isPageIndexable(parsed as any, {});

    expect(result.isIndexable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("returns not indexable when robots meta has noindex", () => {
    const parsed = { meta: { robots: "noindex, nofollow" } };
    const result = isPageIndexable(parsed as any, {});

    expect(result.isIndexable).toBe(false);
    expect(result.reasons).toContain("meta:noindex");
  });

  it("returns not indexable when X-Robots-Tag header has noindex", () => {
    const parsed = { meta: { robots: "" } };
    const headers = { "x-robots-tag": "noindex" };
    const result = isPageIndexable(parsed as any, headers);

    expect(result.isIndexable).toBe(false);
    expect(result.reasons).toContain("header:noindex");
  });

  it("returns not indexable when both meta and header have noindex", () => {
    const parsed = { meta: { robots: "noindex" } };
    const headers = { "x-robots-tag": "noindex, nofollow" };
    const result = isPageIndexable(parsed as any, headers);

    expect(result.isIndexable).toBe(false);
    expect(result.reasons).toContain("meta:noindex");
    expect(result.reasons).toContain("header:noindex");
    expect(result.reasons.length).toBe(2);
  });

  it("handles case-insensitive noindex", () => {
    const parsed = { meta: { robots: "NOINDEX" } };
    const result = isPageIndexable(parsed as any, {});

    expect(result.isIndexable).toBe(false);
    expect(result.reasons).toContain("meta:noindex");
  });

  it("returns not indexable when parsed is null", () => {
    const result = isPageIndexable(null, {});

    expect(result.isIndexable).toBe(false);
    expect(result.reasons).toContain("unparseable");
  });

  it("ignores noindex in other directives", () => {
    const parsed = { meta: { robots: "follow, noarchive" } };
    const result = isPageIndexable(parsed as any, {});

    expect(result.isIndexable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("returns not indexable when robots.txt disallows URL", () => {
    const parsed = { meta: { robots: "" } };
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

    const result = isPageIndexable(
      parsed as any,
      {},
      "https://example.com/admin/page",
      robotsTxt
    );

    expect(result.isIndexable).toBe(false);
    expect(result.reasons).toContain("robots.txt:disallowed");
  });

  it("returns indexable when robots.txt allows URL", () => {
    const parsed = { meta: { robots: "" } };
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

    const result = isPageIndexable(
      parsed as any,
      {},
      "https://example.com/public/page",
      robotsTxt
    );

    expect(result.isIndexable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("returns all blocking reasons when multiple sources block", () => {
    const parsed = { meta: { robots: "noindex" } };
    const headers = { "x-robots-tag": "noindex" };
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

    const result = isPageIndexable(
      parsed as any,
      headers,
      "https://example.com/page",
      robotsTxt
    );

    expect(result.isIndexable).toBe(false);
    expect(result.reasons).toContain("meta:noindex");
    expect(result.reasons).toContain("header:noindex");
    expect(result.reasons).toContain("robots.txt:disallowed");
    expect(result.reasons.length).toBe(3);
  });

  it("works without optional url and robotsTxt parameters", () => {
    const parsed = { meta: { robots: "" } };
    const result = isPageIndexable(parsed as any, {});

    expect(result.isIndexable).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
