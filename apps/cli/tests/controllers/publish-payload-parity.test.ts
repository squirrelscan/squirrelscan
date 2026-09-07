// #1938: the CLI's report stopped carrying per-page fields nothing read. The
// publish payload is the one consumer that could have depended on one quietly,
// so this pins the whole body rather than trusting a grep.
//
// It builds a report the way `reconstructReport` does now, runs it through the
// real publish transform, and compares against the same report with the dropped
// fields put back. If the payload were to depend on any of them, the two bodies
// would differ and this fails.

import { describe, expect, test } from "bun:test";

import type { AuditReport, PageAudit } from "@/types";

import { slimForPublish } from "../../src/controllers/report/publish";

const BASE = "https://example.com";

function baseReport(pages: PageAudit[]): AuditReport {
  return {
    crawlId: "crawl-1",
    baseUrl: BASE,
    timestamp: new Date(0).toISOString(),
    pages,
    summary: {
      missingTitles: [],
      missingDescriptions: [],
      missingOgTags: [],
      missingTwitterCards: [],
      missingSchemas: [],
      missingAltText: [],
      multipleH1s: [],
      thinContentPages: [],
      urlIssues: [],
      redirectChains: [],
      securityIssues: [],
    },
    ruleResults: {},
    siteChecks: [],
    healthScore: {
      overall: 90,
      grade: "A",
      groups: [],
      passed: 1,
      warnings: 0,
      failed: 0,
      total: 1,
    },
  } as unknown as AuditReport;
}

/** What reconstructReport builds today. */
function leanPage(url: string, statusCode = 200): PageAudit {
  return {
    url,
    statusCode,
    meta: {
      title: `Title ${url}`,
      description: `Desc ${url}`,
      canonical: null,
      robots: null,
    },
    og: {
      title: `OG ${url}`,
      description: null,
      url: null,
      type: null,
      image: null,
      siteName: null,
    },
    checks: [],
  } as unknown as PageAudit;
}

/** The same page with every field #1938 stopped populating put back. */
function fatPage(url: string, statusCode = 200): PageAudit {
  return {
    ...leanPage(url, statusCode),
    loadTime: 123,
    twitter: { card: "summary", title: "t", description: "d", image: "i" },
    schema: {
      types: ["Article"],
      valid: true,
      errors: [],
      raw: JSON.stringify({ "@type": "Article", body: "x".repeat(500) }),
    },
    links: [
      { url: `${BASE}/other`, text: "other", isInternal: true },
      { url: "https://out.test/a", text: "out", isInternal: false },
    ],
    images: [{ src: `${BASE}/a.png`, alt: "a", width: null, height: null }],
    h1Count: 1,
    h1Text: ["Heading"],
    responseHeaders: { server: "nginx", contentType: "text/html" },
    security: {
      isHttps: true,
      hasMixedContent: false,
      mixedContentUrls: [],
      insecureFormActions: [],
      headers: {},
      httpToHttpsRedirect: false,
    },
  } as unknown as PageAudit;
}

const urls = [`${BASE}/`, `${BASE}/a`, `${BASE}/b`];

describe("publish payload after #1938", () => {
  test("is byte-identical with and without the dropped page fields", () => {
    const lean = slimForPublish(baseReport(urls.map((u) => leanPage(u))));
    const fat = slimForPublish(baseReport(urls.map((u) => fatPage(u))));

    expect(JSON.stringify(lean)).toBe(JSON.stringify(fat));
  });

  test("still carries the home page title and description", () => {
    // pickHomepageSummary reads meta/og off the home page to seed the website
    // record. That is why those two are the fields #1938 KEPT.
    const slim = slimForPublish(baseReport(urls.map((u) => leanPage(u))));
    expect(slim.homepage).toEqual({
      title: `Title ${BASE}/`,
      description: `Desc ${BASE}/`,
    });
  });

  test("still reports non-2xx page statuses", () => {
    const pages = [leanPage(`${BASE}/`), leanPage(`${BASE}/gone`, 404)];
    const slim = slimForPublish(baseReport(pages)) as unknown as {
      pageStatuses?: Array<{ url: string; status: number }>;
      pages: unknown[];
    };
    expect(slim.pageStatuses).toEqual([{ url: `${BASE}/gone`, status: 404 }]);
    // And pages[] is still emptied, as it always was.
    expect(slim.pages).toEqual([]);
  });
});
