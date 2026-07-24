// Tests for pickHomepageSummary — the home-page title/description carried
// through the slimmed publish payload (pages[] is otherwise dropped).

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { pickHomepageSummary } from "../../src/controllers/report/publish";

function makeReport(
  baseUrl: string,
  pages: Array<{
    url: string;
    title?: string | null;
    description?: string | null;
  }>
): AuditReport {
  return {
    baseUrl,
    pages: pages.map((p) => ({
      url: p.url,
      meta: {
        title: p.title ?? null,
        description: p.description ?? null,
        canonical: null,
        robots: null,
      },
      og: {
        title: null,
        description: null,
        url: null,
        type: null,
        image: null,
        siteName: null,
      },
    })),
  } as unknown as AuditReport;
}

describe("pickHomepageSummary", () => {
  test("picks the audited origin's root page", () => {
    const report = makeReport("https://example.com", [
      {
        url: "https://example.com/about",
        title: "About",
        description: "about",
      },
      { url: "https://example.com/", title: "Home", description: "home page" },
    ]);
    expect(pickHomepageSummary(report)).toEqual({
      title: "Home",
      description: "home page",
    });
  });

  test("origin guard: prefers the audited root over a sibling domain's root", () => {
    // Multi-domain crawl (allowedDomains): a sibling "/" page appears first.
    // The pathname-only matcher would wrongly pick it; the origin guard must not.
    const report = makeReport("https://example.com", [
      {
        url: "https://other.com/",
        title: "Other Site",
        description: "wrong site",
      },
      {
        url: "https://example.com/",
        title: "Le Monde",
        description: "right site",
      },
    ]);
    expect(pickHomepageSummary(report)).toEqual({
      title: "Le Monde",
      description: "right site",
    });
  });

  test("falls back to an exact baseUrl match when no clean root path exists", () => {
    const report = makeReport("https://example.com/en", [
      { url: "https://other.com/", title: "Other", description: "wrong" },
      {
        url: "https://example.com/en",
        title: "Localised Home",
        description: "en home",
      },
    ]);
    expect(pickHomepageSummary(report)).toEqual({
      title: "Localised Home",
      description: "en home",
    });
  });

  test("returns undefined when the home page carries neither title nor description", () => {
    const report = makeReport("https://example.com", [
      { url: "https://example.com/", title: null, description: null },
    ]);
    expect(pickHomepageSummary(report)).toBeUndefined();
  });

  test("returns undefined for an empty crawl", () => {
    expect(
      pickHomepageSummary(makeReport("https://example.com", []))
    ).toBeUndefined();
  });

  test("unparseable baseUrl falls back to the first crawled page", () => {
    const report = makeReport("not a url", [
      { url: "https://example.com/", title: "Home", description: "home" },
    ]);
    expect(pickHomepageSummary(report)).toEqual({
      title: "Home",
      description: "home",
    });
  });
});
