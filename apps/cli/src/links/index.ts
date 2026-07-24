// Internal link analysis - crawl depth, orphan pages, link equity
// Phase 4 enhancement for comprehensive link analysis

import { shouldSkipUrl } from "@squirrelscan/utils";
import { parseHTML } from "linkedom";

import type {
  CheckResult,
  EnhancedLinkData,
  InternalLinkAnalysis,
  AnchorTextAnalysis,
  PageAudit,
} from "@/types";

// Generic anchor text patterns
const GENERIC_ANCHORS = [
  "click here",
  "read more",
  "learn more",
  "here",
  "this",
  "link",
  "more",
  "continue",
  "see more",
  "find out more",
  "click",
  "go",
  "visit",
  "details",
  "more info",
  "more information",
];

export function extractEnhancedLinks(
  html: string,
  pageUrl: string
): EnhancedLinkData[] {
  const { document: doc } = parseHTML(html);
  const links: EnhancedLinkData[] = [];
  const pageOrigin = new URL(pageUrl).origin;

  const anchorElements = doc.querySelectorAll("a[href]");

  for (const anchor of anchorElements) {
    const href = anchor.getAttribute("href");
    if (!href) continue;

    // Skip javascript:, mailto:, tel:, etc.
    if (shouldSkipUrl(href)) {
      continue;
    }

    // Resolve relative URLs
    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, pageUrl).toString();
    } catch {
      continue; // Invalid URL
    }

    const isInternal = absoluteUrl.startsWith(pageOrigin);

    // Get rel attributes
    const relAttr = anchor.getAttribute("rel") || "";
    const relValues = relAttr.toLowerCase().split(/\s+/).filter(Boolean);

    // Determine anchor type
    let anchorType: EnhancedLinkData["anchorType"] = "text";
    const text = anchor.textContent?.trim() || "";
    const hasImage = anchor.querySelector("img") !== null;

    if (hasImage && !text) {
      anchorType = "image";
    } else if (!text && !hasImage) {
      anchorType = "empty";
    } else if (isGenericAnchor(text)) {
      anchorType = "generic";
    }

    links.push({
      url: absoluteUrl,
      text,
      isInternal,
      rel: relValues.length > 0 ? relValues : undefined,
      isNofollow: relValues.includes("nofollow"),
      isSponsored: relValues.includes("sponsored"),
      isUgc: relValues.includes("ugc"),
      hasNoopener: relValues.includes("noopener"),
      target: anchor.getAttribute("target") || undefined,
      anchorType,
    });
  }

  return links;
}

function isGenericAnchor(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return GENERIC_ANCHORS.some(
    (generic) => normalized === generic || normalized.includes(generic)
  );
}

export function analyzeInternalLinks(
  pages: PageAudit[],
  baseUrl: string
): InternalLinkAnalysis {
  const linkEquity = new Map<string, number>();
  const crawlDepth = new Map<string, number>();
  const allPageUrls = new Set(pages.map((p) => normalizeUrl(p.url)));
  const linkedPages = new Set<string>();

  let totalInternalLinks = 0;
  let totalExternalLinks = 0;

  // Build link graph
  for (const page of pages) {
    for (const link of page.links) {
      if (link.isInternal) {
        totalInternalLinks++;
        const normalizedLinkUrl = normalizeUrl(link.url);
        linkedPages.add(normalizedLinkUrl);

        // Count incoming links (link equity)
        const currentEquity = linkEquity.get(normalizedLinkUrl) || 0;
        linkEquity.set(normalizedLinkUrl, currentEquity + 1);
      } else {
        totalExternalLinks++;
      }
    }
  }

  // Calculate crawl depth via BFS
  const normalizedBaseUrl = normalizeUrl(baseUrl);
  crawlDepth.set(normalizedBaseUrl, 0);

  const queue: string[] = [normalizedBaseUrl];
  const visited = new Set<string>([normalizedBaseUrl]);

  while (queue.length > 0) {
    const currentUrl = queue.shift()!;
    const currentDepth = crawlDepth.get(currentUrl) || 0;

    // Find page with this URL
    const currentPage = pages.find((p) => normalizeUrl(p.url) === currentUrl);
    if (!currentPage) continue;

    for (const link of currentPage.links) {
      if (!link.isInternal) continue;

      const normalizedLinkUrl = normalizeUrl(link.url);
      if (!visited.has(normalizedLinkUrl)) {
        visited.add(normalizedLinkUrl);
        crawlDepth.set(normalizedLinkUrl, currentDepth + 1);
        queue.push(normalizedLinkUrl);
      }
    }
  }

  // Find orphan pages (not linked from any other page)
  const orphanPages: string[] = [];
  for (const pageUrl of allPageUrls) {
    if (pageUrl !== normalizedBaseUrl && !linkedPages.has(pageUrl)) {
      orphanPages.push(pageUrl);
    }
  }

  // Find deep pages (> 3 clicks from homepage)
  const deepPages: { url: string; depth: number }[] = [];
  for (const [url, depth] of crawlDepth) {
    if (depth > 3) {
      deepPages.push({ url, depth });
    }
  }

  // Find pages with few internal links
  const pagesWithFewLinks: { url: string; count: number }[] = [];
  const pagesWithManyLinks: { url: string; count: number }[] = [];

  for (const page of pages) {
    const internalLinkCount = page.links.filter((l) => l.isInternal).length;

    if (internalLinkCount < 3) {
      pagesWithFewLinks.push({ url: page.url, count: internalLinkCount });
    } else if (internalLinkCount > 100) {
      pagesWithManyLinks.push({ url: page.url, count: internalLinkCount });
    }
  }

  return {
    totalInternalLinks,
    totalExternalLinks,
    orphanPages,
    deepPages: deepPages.sort((a, b) => b.depth - a.depth),
    crawlDepth,
    linkEquity,
    pagesWithFewLinks,
    pagesWithManyLinks,
  };
}

export function analyzeAnchorText(
  pages: PageAudit[],
  keyword?: string
): AnchorTextAnalysis {
  const genericAnchors: { url: string; text: string }[] = [];
  const emptyAnchors: string[] = [];
  const imageOnlyLinks: string[] = [];
  const keywordRichAnchors: { url: string; text: string }[] = [];
  const anchorDistribution = new Map<string, number>();

  for (const page of pages) {
    // We need enhanced link data - for now, analyze from raw links
    for (const link of page.links) {
      const text = link.text.toLowerCase().trim();

      // Track anchor text distribution
      if (text) {
        const currentCount = anchorDistribution.get(text) || 0;
        anchorDistribution.set(text, currentCount + 1);
      }

      // Check for generic anchors
      if (isGenericAnchor(text)) {
        genericAnchors.push({ url: link.url, text: link.text });
      }

      // Check for empty anchors
      if (!text) {
        emptyAnchors.push(link.url);
      }

      // Check for keyword presence
      if (keyword && text.includes(keyword.toLowerCase())) {
        keywordRichAnchors.push({ url: link.url, text: link.text });
      }
    }
  }

  return {
    genericAnchors,
    emptyAnchors,
    imageOnlyLinks, // Would need enhanced extraction
    keywordRichAnchors,
    anchorDistribution,
  };
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    if (path.endsWith("/") && path !== "/") {
      path = path.slice(0, -1);
    }
    return `${parsed.protocol}//${parsed.host}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function validateInternalLinks(
  analysis: InternalLinkAnalysis
): CheckResult[] {
  const checks: CheckResult[] = [];

  // Orphan pages
  if (analysis.orphanPages.length > 0) {
    const severity = analysis.orphanPages.length > 5 ? "fail" : "warn";
    checks.push({
      name: "internal-links-orphans",
      status: severity,
      message: `${analysis.orphanPages.length} orphan page(s) with no internal links`,
      value: analysis.orphanPages.slice(0, 3).join(", "),
    });
  } else {
    checks.push({
      name: "internal-links-orphans",
      status: "pass",
      message: "No orphan pages detected",
      value: null,
    });
  }

  // Deep pages
  if (analysis.deepPages.length > 0) {
    checks.push({
      name: "internal-links-depth",
      status: "warn",
      message: `${analysis.deepPages.length} page(s) more than 3 clicks from homepage`,
      value: analysis.deepPages
        .slice(0, 3)
        .map((p) => `${p.url} (${p.depth} clicks)`)
        .join(", "),
    });
  }

  // Pages with few links
  if (analysis.pagesWithFewLinks.length > 0) {
    checks.push({
      name: "internal-links-few",
      status: "warn",
      message: `${analysis.pagesWithFewLinks.length} page(s) with fewer than 3 internal links`,
      value: analysis.pagesWithFewLinks
        .slice(0, 3)
        .map((p) => p.url)
        .join(", "),
    });
  }

  // Pages with too many links
  if (analysis.pagesWithManyLinks.length > 0) {
    checks.push({
      name: "internal-links-many",
      status: "warn",
      message: `${analysis.pagesWithManyLinks.length} page(s) with more than 100 links`,
      value: analysis.pagesWithManyLinks
        .slice(0, 3)
        .map((p) => `${p.url} (${p.count})`)
        .join(", "),
    });
  }

  // Link ratio
  const ratio =
    analysis.totalInternalLinks /
    (analysis.totalInternalLinks + analysis.totalExternalLinks || 1);
  checks.push({
    name: "internal-links-ratio",
    status: ratio > 0.5 ? "pass" : "warn",
    message: `Internal link ratio: ${Math.round(ratio * 100)}%`,
    value: `${analysis.totalInternalLinks} internal, ${analysis.totalExternalLinks} external`,
  });

  return checks;
}

export function validateAnchorText(
  analysis: AnchorTextAnalysis
): CheckResult[] {
  const checks: CheckResult[] = [];

  // Generic anchors
  if (analysis.genericAnchors.length > 5) {
    checks.push({
      name: "anchor-text-generic",
      status: "warn",
      message: `${analysis.genericAnchors.length} generic anchor text(s) like "click here"`,
      value: analysis.genericAnchors
        .slice(0, 3)
        .map((a) => a.text)
        .join(", "),
    });
  }

  // Empty anchors
  if (analysis.emptyAnchors.length > 0) {
    checks.push({
      name: "anchor-text-empty",
      status: "warn",
      message: `${analysis.emptyAnchors.length} link(s) with empty anchor text`,
      value: analysis.emptyAnchors.slice(0, 3).join(", "),
    });
  }

  // Keyword-rich anchors (positive)
  if (analysis.keywordRichAnchors.length > 0) {
    checks.push({
      name: "anchor-text-keyword",
      status: "pass",
      message: `${analysis.keywordRichAnchors.length} keyword-rich anchor(s) found`,
      value: analysis.keywordRichAnchors
        .slice(0, 3)
        .map((a) => a.text)
        .join(", "),
    });
  }

  return checks;
}
