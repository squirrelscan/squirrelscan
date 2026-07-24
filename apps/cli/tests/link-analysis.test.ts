import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PageAudit, LinkData } from "../src/types";

// Helper to create test pages
function testPage(url: string, links: LinkData[]): PageAudit {
  return { url, links } as unknown as PageAudit;
}

import {
  extractEnhancedLinks,
  analyzeInternalLinks,
  analyzeAnchorText,
  validateInternalLinks,
  validateAnchorText,
} from "../src/links";

const fixturesDir = join(import.meta.dir, "fixtures");
const goodPage = readFileSync(join(fixturesDir, "good-page.html"), "utf-8");
const badPage = readFileSync(join(fixturesDir, "bad-page.html"), "utf-8");

describe("Enhanced Link Extraction", () => {
  test("extracts internal links", () => {
    const links = extractEnhancedLinks(
      goodPage,
      "https://example.com/seo-guide"
    );
    const internalLinks = links.filter((l) => l.isInternal);
    expect(internalLinks.length).toBeGreaterThan(0);
  });

  test("extracts external links", () => {
    const links = extractEnhancedLinks(badPage, "https://example.com/bad-page");
    const externalLinks = links.filter((l) => !l.isInternal);
    expect(externalLinks.length).toBeGreaterThan(0);
  });

  test("identifies generic anchor text", () => {
    const html = `
			<html><body>
				<a href="https://example.com/page1">Click here</a>
				<a href="https://example.com/page2">Read more</a>
				<a href="https://example.com/page3">Learn more</a>
			</body></html>
		`;
    const links = extractEnhancedLinks(html, "https://example.com");
    const genericLinks = links.filter((l) => l.anchorType === "generic");
    expect(genericLinks.length).toBeGreaterThan(0);
  });

  test("identifies empty anchor text", () => {
    const links = extractEnhancedLinks(badPage, "https://example.com/bad-page");
    const emptyLinks = links.filter((l) => l.anchorType === "empty");
    expect(emptyLinks.length).toBeGreaterThan(0);
  });

  test("extracts rel attributes", () => {
    const html = `
			<html><body>
				<a href="https://external.com" rel="nofollow sponsored">Sponsored</a>
				<a href="https://external2.com" rel="noopener">External</a>
			</body></html>
		`;
    const links = extractEnhancedLinks(html, "https://example.com");

    const sponsoredLink = links.find((l) => l.isSponsored);
    expect(sponsoredLink).toBeDefined();
    expect(sponsoredLink?.isNofollow).toBe(true);

    const noopenerLink = links.find((l) => l.hasNoopener);
    expect(noopenerLink).toBeDefined();
  });

  test("skips javascript and mailto links", () => {
    const html = `
			<html><body>
				<a href="javascript:void(0)">JS Link</a>
				<a href="mailto:test@example.com">Email</a>
				<a href="tel:+1234567890">Phone</a>
				<a href="#section">Anchor</a>
				<a href="https://example.com/page">Valid</a>
			</body></html>
		`;
    const links = extractEnhancedLinks(html, "https://example.com");
    expect(links.length).toBe(1);
    expect(links[0].url).toContain("/page");
  });
});

describe("Internal Link Analysis", () => {
  test("calculates crawl depth", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        { url: "https://example.com/page1", text: "Page 1", isInternal: true },
        { url: "https://example.com/page2", text: "Page 2", isInternal: true },
      ]),
      testPage("https://example.com/page1", [
        { url: "https://example.com/page1/sub", text: "Sub", isInternal: true },
      ]),
      testPage("https://example.com/page2", []),
      testPage("https://example.com/page1/sub", []),
    ];

    const analysis = analyzeInternalLinks(pages, "https://example.com/");

    // Root URL keeps trailing slash, others don't
    expect(analysis.crawlDepth.get("https://example.com/")).toBe(0);
    expect(analysis.crawlDepth.get("https://example.com/page1")).toBe(1);
    expect(analysis.crawlDepth.get("https://example.com/page1/sub")).toBe(2);
  });

  test("detects orphan pages", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        { url: "https://example.com/linked", text: "Linked", isInternal: true },
      ]),
      testPage("https://example.com/linked", []),
      testPage("https://example.com/orphan", []),
    ];

    const analysis = analyzeInternalLinks(pages, "https://example.com/");
    expect(analysis.orphanPages).toContain("https://example.com/orphan");
  });

  test("detects deep pages", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        { url: "https://example.com/l1", text: "L1", isInternal: true },
      ]),
      testPage("https://example.com/l1", [
        { url: "https://example.com/l2", text: "L2", isInternal: true },
      ]),
      testPage("https://example.com/l2", [
        { url: "https://example.com/l3", text: "L3", isInternal: true },
      ]),
      testPage("https://example.com/l3", [
        { url: "https://example.com/l4", text: "L4", isInternal: true },
      ]),
      testPage("https://example.com/l4", []),
    ];

    const analysis = analyzeInternalLinks(pages, "https://example.com/");
    expect(analysis.deepPages.some((p) => p.url.includes("/l4"))).toBe(true);
    expect(analysis.deepPages.some((p) => p.depth > 3)).toBe(true);
  });

  test("calculates link equity", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        {
          url: "https://example.com/popular",
          text: "Popular",
          isInternal: true,
        },
      ]),
      testPage("https://example.com/page1", [
        {
          url: "https://example.com/popular",
          text: "Popular",
          isInternal: true,
        },
      ]),
      testPage("https://example.com/page2", [
        {
          url: "https://example.com/popular",
          text: "Popular",
          isInternal: true,
        },
      ]),
      testPage("https://example.com/popular", []),
    ];

    const analysis = analyzeInternalLinks(pages, "https://example.com/");
    expect(analysis.linkEquity.get("https://example.com/popular")).toBe(3);
  });

  test("calculates internal/external ratio", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        {
          url: "https://example.com/page1",
          text: "Internal",
          isInternal: true,
        },
        {
          url: "https://example.com/page2",
          text: "Internal",
          isInternal: true,
        },
        { url: "https://external.com", text: "External", isInternal: false },
      ]),
    ];

    const analysis = analyzeInternalLinks(pages, "https://example.com/");
    expect(analysis.totalInternalLinks).toBe(2);
    expect(analysis.totalExternalLinks).toBe(1);
  });
});

describe("Anchor Text Analysis", () => {
  test("detects generic anchor text", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        {
          url: "https://example.com/page1",
          text: "Click here",
          isInternal: true,
        },
        {
          url: "https://example.com/page2",
          text: "Read more",
          isInternal: true,
        },
        {
          url: "https://example.com/page3",
          text: "Learn more",
          isInternal: true,
        },
      ]),
    ];

    const analysis = analyzeAnchorText(pages);
    expect(analysis.genericAnchors.length).toBe(3);
  });

  test("detects empty anchor text", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        { url: "https://example.com/page1", text: "", isInternal: true },
      ]),
    ];

    const analysis = analyzeAnchorText(pages);
    expect(analysis.emptyAnchors.length).toBe(1);
  });

  test("tracks keyword-rich anchors", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        {
          url: "https://example.com/seo",
          text: "SEO best practices",
          isInternal: true,
        },
        {
          url: "https://example.com/seo2",
          text: "advanced SEO tips",
          isInternal: true,
        },
      ]),
    ];

    const analysis = analyzeAnchorText(pages, "seo");
    expect(analysis.keywordRichAnchors.length).toBe(2);
  });

  test("tracks anchor text distribution", () => {
    const pages: PageAudit[] = [
      testPage("https://example.com/", [
        {
          url: "https://example.com/page1",
          text: "common text",
          isInternal: true,
        },
        {
          url: "https://example.com/page2",
          text: "common text",
          isInternal: true,
        },
        {
          url: "https://example.com/page3",
          text: "unique text",
          isInternal: true,
        },
      ]),
    ];

    const analysis = analyzeAnchorText(pages);
    expect(analysis.anchorDistribution.get("common text")).toBe(2);
    expect(analysis.anchorDistribution.get("unique text")).toBe(1);
  });
});

describe("Internal Link Validation", () => {
  test("warns about orphan pages", () => {
    const analysis = {
      totalInternalLinks: 10,
      totalExternalLinks: 5,
      orphanPages: [
        "https://example.com/orphan1",
        "https://example.com/orphan2",
      ],
      deepPages: [],
      crawlDepth: new Map(),
      linkEquity: new Map(),
      pagesWithFewLinks: [],
      pagesWithManyLinks: [],
    };

    const checks = validateInternalLinks(analysis);
    const orphanCheck = checks.find((c) => c.name === "internal-links-orphans");
    expect(orphanCheck?.status).toBe("warn");
  });

  test("passes with no orphan pages", () => {
    const analysis = {
      totalInternalLinks: 10,
      totalExternalLinks: 5,
      orphanPages: [],
      deepPages: [],
      crawlDepth: new Map(),
      linkEquity: new Map(),
      pagesWithFewLinks: [],
      pagesWithManyLinks: [],
    };

    const checks = validateInternalLinks(analysis);
    const orphanCheck = checks.find((c) => c.name === "internal-links-orphans");
    expect(orphanCheck?.status).toBe("pass");
  });

  test("warns about deep pages", () => {
    const analysis = {
      totalInternalLinks: 10,
      totalExternalLinks: 5,
      orphanPages: [],
      deepPages: [{ url: "https://example.com/deep", depth: 5 }],
      crawlDepth: new Map(),
      linkEquity: new Map(),
      pagesWithFewLinks: [],
      pagesWithManyLinks: [],
    };

    const checks = validateInternalLinks(analysis);
    const depthCheck = checks.find((c) => c.name === "internal-links-depth");
    expect(depthCheck?.status).toBe("warn");
  });

  test("calculates link ratio", () => {
    const analysis = {
      totalInternalLinks: 80,
      totalExternalLinks: 20,
      orphanPages: [],
      deepPages: [],
      crawlDepth: new Map(),
      linkEquity: new Map(),
      pagesWithFewLinks: [],
      pagesWithManyLinks: [],
    };

    const checks = validateInternalLinks(analysis);
    const ratioCheck = checks.find((c) => c.name === "internal-links-ratio");
    expect(ratioCheck?.status).toBe("pass");
    expect(ratioCheck?.message).toContain("80%");
  });
});

describe("Anchor Text Validation", () => {
  test("warns about generic anchors", () => {
    const analysis = {
      genericAnchors: Array(10).fill({
        url: "https://example.com",
        text: "Click here",
      }),
      emptyAnchors: [],
      imageOnlyLinks: [],
      keywordRichAnchors: [],
      anchorDistribution: new Map(),
    };

    const checks = validateAnchorText(analysis);
    const genericCheck = checks.find((c) => c.name === "anchor-text-generic");
    expect(genericCheck?.status).toBe("warn");
  });

  test("warns about empty anchors", () => {
    const analysis = {
      genericAnchors: [],
      emptyAnchors: ["https://example.com/page1", "https://example.com/page2"],
      imageOnlyLinks: [],
      keywordRichAnchors: [],
      anchorDistribution: new Map(),
    };

    const checks = validateAnchorText(analysis);
    const emptyCheck = checks.find((c) => c.name === "anchor-text-empty");
    expect(emptyCheck?.status).toBe("warn");
  });

  test("passes for keyword-rich anchors", () => {
    const analysis = {
      genericAnchors: [],
      emptyAnchors: [],
      imageOnlyLinks: [],
      keywordRichAnchors: [
        { url: "https://example.com/seo", text: "SEO guide" },
      ],
      anchorDistribution: new Map(),
    };

    const checks = validateAnchorText(analysis);
    const keywordCheck = checks.find((c) => c.name === "anchor-text-keyword");
    expect(keywordCheck?.status).toBe("pass");
  });
});
