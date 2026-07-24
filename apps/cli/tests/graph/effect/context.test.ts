// Tests for effect/context.ts - AuditContext and reactive context management

import { describe, it, expect, beforeEach } from "bun:test";
import { Effect } from "effect";

import type { Config } from "../../../src/config";

import {
  createInitialContext,
  createContextRef,
  createRuleConfig,
  getContext,
  updateContext,
  addPage,
  addLink,
  addImage,
  markVisited,
  addToQueue,
  recordFailure,
  updateLinkStatus,
  setRobotsTxt,
  addSitemap,
  startNodeExecution,
  completeNodeExecution,
  type AuditContext,
  type Page,
  type LinkAppearance,
  type ImageAppearance,
} from "../../../src/infra/context";
import { CrawlError } from "../../../src/infra/errors";

// Mock config for testing
const mockConfig: Config = {
  project: {
    domains: [],
  },
  crawler: {
    max_pages: 10,
    coverage: "surface",
    delay_ms: 100,
    timeout_ms: 30000,
    user_agent: "TestBot/1.0",
    headers: {},
    follow_redirects: true,
    concurrency: 3,
    per_host_concurrency: 2,
    per_host_delay_ms: 200,
    include: [],
    exclude: [],
    allow_query_params: [],
    drop_query_prefixes: ["utm_"],
    respect_robots: true,
    incremental: true,
    breadth_first: true,
    max_prefix_budget: 0.25,
    use_cache_control: true,
    max_staleness_seconds: 86400,
  },
  rules: {
    enable: ["*"],
    disable: [],
  },
  external_links: {
    enabled: true,
    cache_ttl_days: 7,
    timeout_ms: 10000,
    concurrency: 5,
  },
  output: {
    format: "console",
  },
  cloud: {
    enabled: true,
    max_credits_per_audit: 200,
    confirm_threshold: 50,
    batch_size: 20,
    technologies: true,
    editor_summary: true,
    domain_stats: true,
    rendering: "http" as const,
    render_concurrency: 4,
    publish: true,
    visibility: "unlisted" as const,
  },
  intel: { enabled: false, feed_ttl_hours: 24, providers: {} },
  integrity: {
    cloaking_probe: {
      enabled: false,
      max_pages: 10,
      recent_days: 14,
      query_variation: true,
      googlebot_user_agent:
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    },
    soft404_confirm: {
      enabled: true,
      max_confirmations: 25,
      budget_ms: 60_000,
    },
  },
  rule_options: {},
  smart_audits: false,
};

describe("createInitialContext", () => {
  it("creates context with correct target URL", () => {
    const ctx = createInitialContext("https://example.com/page", mockConfig);
    expect(ctx.targetUrl).toBe("https://example.com/page");
    expect(ctx.baseUrl).toBe("https://example.com");
  });

  it("initializes empty site graph", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    expect(ctx.project.site.pages.size).toBe(0);
    expect(ctx.project.site.links.size).toBe(0);
    expect(ctx.project.site.images.size).toBe(0);
    expect(ctx.project.site.robotsTxt).toBeNull();
    expect(ctx.project.site.sitemaps).toEqual([]);
  });

  it("seeds crawl queue with target URL", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    expect(ctx.crawlQueue.has("https://example.com")).toBe(true);
  });

  it("maps config settings correctly", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    expect(ctx.settings.crawler.maxPages).toBe(10);
    expect(ctx.settings.crawler.delayMs).toBe(100);
    expect(ctx.settings.crawler.userAgent).toBe("TestBot/1.0");
  });

  it("initializes counters to zero", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    expect(ctx.pagesCrawled).toBe(0);
    expect(ctx.pagesMaxReached).toBe(false);
  });
});

describe("createRuleConfig", () => {
  it("enables all rules with wildcard", () => {
    const config = createRuleConfig(["*"], []);
    expect(config.isEnabled("core/meta-title")).toBe(true);
    expect(config.isEnabled("seo/canonical")).toBe(true);
  });

  it("enables specific category with wildcard", () => {
    const config = createRuleConfig(["seo/*"], []);
    expect(config.isEnabled("seo/canonical")).toBe(true);
    expect(config.isEnabled("core/meta-title")).toBe(false);
  });

  it("disables specific rules", () => {
    const config = createRuleConfig(["*"], ["a11y/*"]);
    expect(config.isEnabled("seo/canonical")).toBe(true);
    expect(config.isEnabled("a11y/alt-text")).toBe(false);
  });

  it("disable takes precedence over enable", () => {
    const config = createRuleConfig(["*"], ["seo/canonical"]);
    expect(config.isEnabled("seo/canonical")).toBe(false);
    expect(config.isEnabled("seo/meta-description")).toBe(true);
  });
});

describe("Reactive Context", () => {
  it("creates and reads context ref", async () => {
    const initial = createInitialContext("https://example.com", mockConfig);
    const ref = await Effect.runPromise(createContextRef(initial));
    const ctx = await Effect.runPromise(getContext(ref));
    expect(ctx.targetUrl).toBe("https://example.com");
  });

  it("updates context immutably", async () => {
    const initial = createInitialContext("https://example.com", mockConfig);
    const ref = await Effect.runPromise(createContextRef(initial));

    await Effect.runPromise(
      updateContext(ref, (ctx) => ({
        ...ctx,
        pagesCrawled: 5,
      }))
    );

    const ctx = await Effect.runPromise(getContext(ref));
    expect(ctx.pagesCrawled).toBe(5);
  });
});

describe("addPage", () => {
  let ctx: AuditContext;

  beforeEach(() => {
    ctx = createInitialContext("https://example.com", mockConfig);
  });

  it("adds page to site graph", () => {
    const page: Page = {
      url: "https://example.com/about",
      raw: null,
      parsed: null,
      links: [],
      images: [],
      ruleResults: [],
      depth: 1,
      parentUrl: "https://example.com",
    };

    const updated = addPage(ctx, page);
    expect(updated.project.site.pages.has("https://example.com/about")).toBe(
      true
    );
  });

  it("increments pagesCrawled counter", () => {
    const page: Page = {
      url: "https://example.com/about",
      raw: null,
      parsed: null,
      links: [],
      images: [],
      ruleResults: [],
      depth: 1,
    };

    const updated = addPage(ctx, page);
    expect(updated.pagesCrawled).toBe(1);
  });

  it("sets pagesMaxReached when limit hit", () => {
    // Set max pages to 1
    ctx = createInitialContext("https://example.com", {
      ...mockConfig,
      crawler: { ...mockConfig.crawler, max_pages: 1 },
    });

    const page: Page = {
      url: "https://example.com/about",
      raw: null,
      parsed: null,
      links: [],
      images: [],
      ruleResults: [],
      depth: 1,
    };

    const updated = addPage(ctx, page);
    expect(updated.pagesMaxReached).toBe(true);
  });
});

describe("addLink", () => {
  let ctx: AuditContext;

  beforeEach(() => {
    ctx = createInitialContext("https://example.com", mockConfig);
  });

  it("adds new link to site graph", () => {
    const appearance: LinkAppearance = {
      pageUrl: "https://example.com",
      anchorText: "About Us",
      position: "nav",
      isNofollow: false,
    };

    const updated = addLink(ctx, "https://example.com/about", appearance, true);
    expect(updated.project.site.links.has("https://example.com/about")).toBe(
      true
    );

    const link = updated.project.site.links.get("https://example.com/about");
    expect(link?.isInternal).toBe(true);
    expect(link?.appearances.length).toBe(1);
  });

  it("deduplicates links and adds appearances", () => {
    const appearance1: LinkAppearance = {
      pageUrl: "https://example.com",
      anchorText: "About Us",
      position: "nav",
      isNofollow: false,
    };

    const appearance2: LinkAppearance = {
      pageUrl: "https://example.com/contact",
      anchorText: "About",
      position: "footer",
      isNofollow: false,
    };

    let updated = addLink(ctx, "https://example.com/about", appearance1, true);
    updated = addLink(updated, "https://example.com/about", appearance2, true);

    const link = updated.project.site.links.get("https://example.com/about");
    expect(link?.appearances.length).toBe(2);
  });
});

describe("addImage", () => {
  let ctx: AuditContext;

  beforeEach(() => {
    ctx = createInitialContext("https://example.com", mockConfig);
  });

  it("adds new image to site graph", () => {
    const appearance: ImageAppearance = {
      pageUrl: "https://example.com",
      alt: "Logo",
      isLazyLoaded: false,
      inFigure: false,
    };

    const updated = addImage(ctx, "https://example.com/logo.png", appearance);
    expect(
      updated.project.site.images.has("https://example.com/logo.png")
    ).toBe(true);
  });

  it("deduplicates images and adds appearances", () => {
    const appearance1: ImageAppearance = {
      pageUrl: "https://example.com",
      alt: "Logo",
      isLazyLoaded: false,
      inFigure: false,
    };

    const appearance2: ImageAppearance = {
      pageUrl: "https://example.com/about",
      alt: "Company Logo",
      isLazyLoaded: true,
      inFigure: false,
    };

    let updated = addImage(ctx, "https://example.com/logo.png", appearance1);
    updated = addImage(updated, "https://example.com/logo.png", appearance2);

    const image = updated.project.site.images.get(
      "https://example.com/logo.png"
    );
    expect(image?.appearances.length).toBe(2);
  });
});

describe("markVisited", () => {
  it("adds URL to visited set", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    const updated = markVisited(ctx, "https://example.com/about");
    expect(updated.visitedUrls.has("https://example.com/about")).toBe(true);
  });

  it("removes URL from crawl queue", () => {
    let ctx = createInitialContext("https://example.com", mockConfig);
    ctx = addToQueue(ctx, ["https://example.com/about"]);
    expect(ctx.crawlQueue.has("https://example.com/about")).toBe(true);

    const updated = markVisited(ctx, "https://example.com/about");
    expect(updated.crawlQueue.has("https://example.com/about")).toBe(false);
  });
});

describe("addToQueue", () => {
  it("adds URLs to crawl queue", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    const updated = addToQueue(ctx, [
      "https://example.com/about",
      "https://example.com/contact",
    ]);

    expect(updated.crawlQueue.has("https://example.com/about")).toBe(true);
    expect(updated.crawlQueue.has("https://example.com/contact")).toBe(true);
  });

  it("skips already visited URLs", () => {
    let ctx = createInitialContext("https://example.com", mockConfig);
    ctx = markVisited(ctx, "https://example.com/about");

    const updated = addToQueue(ctx, ["https://example.com/about"]);
    expect(updated.crawlQueue.has("https://example.com/about")).toBe(false);
  });

  it("skips URLs already in pages", () => {
    let ctx = createInitialContext("https://example.com", mockConfig);
    const page: Page = {
      url: "https://example.com/about",
      raw: null,
      parsed: null,
      links: [],
      images: [],
      ruleResults: [],
      depth: 1,
    };
    ctx = addPage(ctx, page);

    const updated = addToQueue(ctx, ["https://example.com/about"]);
    expect(updated.crawlQueue.has("https://example.com/about")).toBe(false);
  });
});

describe("recordFailure", () => {
  it("records failed URL with error", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    const error = CrawlError.network(
      "https://example.com/fail",
      "Connection refused"
    );

    const updated = recordFailure(ctx, "https://example.com/fail", error);
    expect(updated.failedUrls.has("https://example.com/fail")).toBe(true);
    expect(updated.errors.length).toBe(1);
  });
});

describe("updateLinkStatus", () => {
  it("updates link status after check", () => {
    let ctx = createInitialContext("https://example.com", mockConfig);
    const appearance: LinkAppearance = {
      pageUrl: "https://example.com",
      anchorText: "External",
      position: "content",
      isNofollow: false,
    };
    ctx = addLink(ctx, "https://external.com", appearance, false);

    const updated = updateLinkStatus(ctx, "https://external.com", 200);
    const link = updated.project.site.links.get("https://external.com");
    expect(link?.status).toBe(200);
    expect(link?.checkedAt).toBeDefined();
  });

  it("records error for broken links", () => {
    let ctx = createInitialContext("https://example.com", mockConfig);
    const appearance: LinkAppearance = {
      pageUrl: "https://example.com",
      anchorText: "Broken",
      position: "content",
      isNofollow: false,
    };
    ctx = addLink(ctx, "https://broken.com", appearance, false);

    const updated = updateLinkStatus(
      ctx,
      "https://broken.com",
      404,
      "Not Found"
    );
    const link = updated.project.site.links.get("https://broken.com");
    expect(link?.status).toBe(404);
    expect(link?.error).toBe("Not Found");
  });
});

describe("setRobotsTxt", () => {
  it("sets robots.txt data in context", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    const robotsTxt = {
      exists: true,
      url: "https://example.com/robots.txt",
      content: "User-agent: *\nDisallow: /admin/",
      sizeBytes: 30,
      sitemaps: ["https://example.com/sitemap.xml"],
      rules: [
        {
          userAgent: "*",
          rules: [{ type: "disallow" as const, path: "/admin/" }],
        },
      ],
      errors: [],
    };

    const updated = setRobotsTxt(ctx, robotsTxt);
    expect(updated.project.site.robotsTxt?.exists).toBe(true);
    expect(updated.project.site.robotsTxt?.sitemaps.length).toBe(1);
  });
});

describe("addSitemap", () => {
  it("adds sitemap to context", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    const sitemap = {
      url: "https://example.com/sitemap.xml",
      type: "urlset" as const,
      urls: [{ loc: "https://example.com/page1" }],
      childSitemaps: [],
      errors: [],
      urlCount: 1,
    };

    const updated = addSitemap(ctx, sitemap);
    expect(updated.project.site.sitemaps.length).toBe(1);
    expect(updated.project.site.sitemaps[0].urlCount).toBe(1);
  });
});

describe("Node Execution Tracking", () => {
  it("tracks node execution start", () => {
    const ctx = createInitialContext("https://example.com", mockConfig);
    const updated = startNodeExecution(ctx, "node-1", "fetchRobots");

    expect(updated.executions.length).toBe(1);
    expect(updated.executions[0].nodeId).toBe("node-1");
    expect(updated.executions[0].status).toBe("running");
  });

  it("tracks node execution completion", () => {
    let ctx = createInitialContext("https://example.com", mockConfig);
    ctx = startNodeExecution(ctx, "node-1", "fetchRobots");
    const updated = completeNodeExecution(ctx, "node-1", "success");

    expect(updated.executions[0].status).toBe("success");
    expect(updated.executions[0].endTime).toBeDefined();
  });

  it("tracks node execution failure", () => {
    let ctx = createInitialContext("https://example.com", mockConfig);
    ctx = startNodeExecution(ctx, "node-1", "fetchRobots");
    const error = CrawlError.network("https://example.com", "Timeout");
    const updated = completeNodeExecution(ctx, "node-1", "failed", error);

    expect(updated.executions[0].status).toBe("failed");
    expect(updated.executions[0].error).toBeDefined();
  });
});
