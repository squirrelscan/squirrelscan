// Seeded issue mix: explicit counts land exactly as configured, and each
// issue class actually produces the shape it claims to (thresholds, orphan
// zero-inbound-links, no field-conflict clobbering, etc).

import { describe, expect, test } from "bun:test";

import {
  LONG_H1_MIN_LENGTH,
  LONG_URL_MIN_LENGTH,
  OVERSIZE_DESCRIPTION_MIN_LENGTH,
  OVERSIZE_TITLE_MIN_LENGTH,
} from "../src/constants";
import { generateSiteModel } from "../src/page-model";

describe("seeded issue mix", () => {
  test("explicit issue counts land exactly as configured", () => {
    const model = generateSiteModel({
      seed: "issue-counts",
      pageCount: 2000,
      issues: {
        longH1: { count: 12 },
        oversizeTitle: { count: 8 },
        oversizeDescription: { count: 9 },
        longUrls: { count: 7 },
        orphanPages: { count: 6 },
        brokenLinks: { count: 11 },
        noindexInSitemap: { count: 5 },
        duplicateTitles: { groupCount: 4, groupSize: 3 },
        duplicateDescriptions: { groupCount: 3, groupSize: 4 },
        redirectChains: { count: 2, chainLength: 3 },
      },
    });

    expect(model.issueSummary["long-h1"]).toBe(12);
    expect(model.issueSummary["oversize-title"]).toBe(8);
    expect(model.issueSummary["oversize-description"]).toBe(9);
    expect(model.issueSummary["long-url"]).toBe(7);
    expect(model.issueSummary.orphan).toBe(6);
    expect(model.issueSummary["broken-link"]).toBe(11);
    expect(model.issueSummary["noindex-in-sitemap"]).toBe(5);
    expect(model.issueSummary["duplicate-title"]).toBe(12); // 4 groups * 3
    expect(model.issueSummary["duplicate-description"]).toBe(12); // 3 groups * 4
    expect(model.issueSummary["redirect-chain"]).toBe(6); // 2 chains * 3 hops
  });

  test("a false issue spec disables that class entirely", () => {
    const model = generateSiteModel({
      seed: "issue-disabled",
      pageCount: 500,
      issues: {
        longH1: false,
        oversizeTitle: false,
        oversizeDescription: false,
        longUrls: false,
        orphanPages: false,
        brokenLinks: false,
        noindexInSitemap: false,
        duplicateTitles: false,
        duplicateDescriptions: false,
        redirectChains: false,
      },
    });

    for (const [tag, count] of Object.entries(model.issueSummary)) {
      if (tag === "clean") continue;
      expect(count).toBe(0);
    }
    expect(model.issueSummary.clean).toBe(500);
    expect(model.pages.length).toBe(500);
  });

  test("orphan pages are in the sitemap but have zero incoming links from any page", () => {
    const model = generateSiteModel({
      seed: "orphan-invariant",
      pageCount: 400,
      issues: { orphanPages: { count: 15 } },
    });

    const orphanPaths = new Set(
      model.pages.filter((p) => p.issues.includes("orphan")).map((p) => p.path),
    );
    expect(orphanPaths.size).toBe(15);
    for (const path of orphanPaths) {
      expect(model.sitemapPaths).toContain(path);
    }

    for (const page of model.pages) {
      for (const href of page.outgoingLinks) {
        const targetPath = (href.split("?")[0] ?? href).split("#")[0]!;
        expect(orphanPaths.has(targetPath)).toBe(false);
      }
    }
  });

  test("long-h1 pages exceed the documented threshold", () => {
    const model = generateSiteModel({
      seed: "long-h1-threshold",
      pageCount: 300,
      issues: { longH1: { count: 20 } },
    });
    const longH1Pages = model.pages.filter((p) => p.issues.includes("long-h1"));
    expect(longH1Pages.length).toBe(20);
    for (const page of longH1Pages) {
      expect(page.h1.length).toBeGreaterThan(LONG_H1_MIN_LENGTH);
    }
  });

  test("oversize title/description issues exceed their documented thresholds", () => {
    const model = generateSiteModel({
      seed: "oversize-threshold",
      pageCount: 300,
      issues: { oversizeTitle: { count: 15 }, oversizeDescription: { count: 15 } },
    });
    for (const page of model.pages.filter((p) => p.issues.includes("oversize-title"))) {
      expect(page.title.length).toBeGreaterThan(OVERSIZE_TITLE_MIN_LENGTH);
    }
    for (const page of model.pages.filter((p) => p.issues.includes("oversize-description"))) {
      expect(page.description.length).toBeGreaterThan(OVERSIZE_DESCRIPTION_MIN_LENGTH);
    }
  });

  test("oversize-title and duplicate-title never both claim the same page (no silent clobber)", () => {
    const model = generateSiteModel({
      seed: "no-field-conflict",
      pageCount: 1500,
      issues: {
        oversizeTitle: { ratio: 0.1 },
        duplicateTitles: { groupCount: 20, groupSize: 5 },
        oversizeDescription: { ratio: 0.1 },
        duplicateDescriptions: { groupCount: 20, groupSize: 5 },
      },
    });

    const both = model.pages.filter(
      (p) => p.issues.includes("oversize-title") && p.issues.includes("duplicate-title"),
    );
    expect(both.length).toBe(0);
    const bothDesc = model.pages.filter(
      (p) =>
        p.issues.includes("oversize-description") && p.issues.includes("duplicate-description"),
    );
    expect(bothDesc.length).toBe(0);

    // And every tagged page's content actually reflects that tag.
    for (const page of model.pages.filter((p) => p.issues.includes("oversize-title"))) {
      expect(page.title.length).toBeGreaterThan(OVERSIZE_TITLE_MIN_LENGTH);
    }
  });

  test("long-url issue produces a linked href longer than 2048 characters", () => {
    const model = generateSiteModel({
      seed: "long-url-threshold",
      pageCount: 200,
      issues: { longUrls: { count: 10 } },
    });
    const sources = model.pages.filter((p) => p.issues.includes("long-url"));
    expect(sources.length).toBe(10);
    for (const page of sources) {
      const longest = Math.max(...page.outgoingLinks.map((l) => l.length));
      expect(longest).toBeGreaterThan(LONG_URL_MIN_LENGTH);
    }
  });

  test("duplicate title/description groups actually share identical text", () => {
    const model = generateSiteModel({
      seed: "duplicate-groups-share-text",
      pageCount: 300,
      issues: {
        duplicateTitles: { groupCount: 3, groupSize: 4 },
        duplicateDescriptions: { groupCount: 2, groupSize: 3 },
      },
    });

    const dupTitlePages = model.pages.filter((p) => p.issues.includes("duplicate-title"));
    const titleGroups = new Map<string, number>();
    for (const page of dupTitlePages) {
      titleGroups.set(page.title, (titleGroups.get(page.title) ?? 0) + 1);
    }
    expect([...titleGroups.values()].sort()).toEqual([4, 4, 4]);

    const dupDescPages = model.pages.filter((p) => p.issues.includes("duplicate-description"));
    const descGroups = new Map<string, number>();
    for (const page of dupDescPages) {
      descGroups.set(page.description, (descGroups.get(page.description) ?? 0) + 1);
    }
    expect([...descGroups.values()].sort()).toEqual([3, 3]);
  });

  test("duplicate groups clamp groupCount down rather than emitting partial groups", () => {
    // pageCount 20 (19 non-home candidates) can't fit 10 groups of 5 (needs
    // 50); it must fit fewer FULL groups, never a group with < groupSize members.
    const model = generateSiteModel({
      seed: "duplicate-groups-overcommit",
      pageCount: 20,
      issues: {
        duplicateTitles: { groupCount: 10, groupSize: 5 },
        duplicateDescriptions: false,
        orphanPages: false,
        redirectChains: false,
        brokenLinks: false,
        longUrls: false,
        longH1: false,
        oversizeTitle: false,
        oversizeDescription: false,
        noindexInSitemap: false,
      },
    });

    const dupPages = model.pages.filter((p) => p.issues.includes("duplicate-title"));
    const groups = new Map<string, number>();
    for (const page of dupPages) {
      groups.set(page.title, (groups.get(page.title) ?? 0) + 1);
    }
    // Every emitted group has exactly groupSize (5) members — none partial.
    for (const size of groups.values()) expect(size).toBe(5);
    // issueSummary reflects the ACTUAL (clamped) count exactly.
    expect(model.issueSummary["duplicate-title"]).toBe(groups.size * 5);
    expect(model.issueSummary["duplicate-title"]).toBeLessThan(10 * 5);
  });

  test("noindex-in-sitemap pages are both noindex and present in the sitemap (the conflict)", () => {
    const model = generateSiteModel({
      seed: "noindex-conflict",
      pageCount: 200,
      issues: { noindexInSitemap: { count: 8 } },
    });
    const conflicted = model.pages.filter((p) => p.issues.includes("noindex-in-sitemap"));
    expect(conflicted.length).toBe(8);
    for (const page of conflicted) {
      expect(page.noindex).toBe(true);
      expect(page.inSitemap).toBe(true);
      expect(model.sitemapPaths).toContain(page.path);
    }
  });

  test("broken-link pages link to a path with no corresponding page in the model", () => {
    const model = generateSiteModel({
      seed: "broken-link-target",
      pageCount: 200,
      issues: { brokenLinks: { count: 6 } },
    });
    const byPath = new Set(model.pages.map((p) => p.path));
    const sources = model.pages.filter((p) => p.issues.includes("broken-link"));
    expect(sources.length).toBe(6);
    for (const page of sources) {
      const brokenHref = page.outgoingLinks.find((l) => l.startsWith("/broken/"));
      expect(brokenHref).toBeDefined();
      expect(byPath.has(brokenHref!)).toBe(false);
    }
  });

  test("redirect chains resolve after exactly chainLength hops to a real 200 page", () => {
    const model = generateSiteModel({
      seed: "redirect-chain-resolves",
      pageCount: 200,
      issues: { redirectChains: { count: 3, chainLength: 4 } },
    });

    const byPath = new Map(model.pages.map((p) => [p.path, p]));
    for (let c = 0; c < 3; c++) {
      let current = byPath.get(`/redirect-chain/${c}/hop-0`);
      expect(current).toBeDefined();
      let hops = 0;
      while (current && current.statusCode >= 300 && current.statusCode < 400) {
        expect(current.issues).toContain("redirect-chain");
        current = byPath.get(current.redirectTo!);
        hops++;
        expect(hops).toBeLessThanOrEqual(4);
      }
      expect(hops).toBe(4);
      expect(current?.statusCode).toBe(200);
    }
  });

  test("templateCount produces that many distinct structural templates with stable fingerprints", () => {
    const model = generateSiteModel({
      seed: "template-clusters",
      pageCount: 300,
      templateCount: 6,
    });
    expect(model.templates.length).toBe(6);
    const fingerprints = new Set(model.templates.map((t) => t.fingerprint));
    expect(fingerprints.size).toBe(6); // every template has a distinct fingerprint

    const usedTemplateIds = new Set(model.pages.map((p) => p.templateId));
    for (const template of model.templates) {
      expect(usedTemplateIds.has(template.id)).toBe(true);
    }

    // Same templateId always carries the same fingerprint via `model.templates`.
    const fingerprintById = new Map(model.templates.map((t) => [t.id, t.fingerprint]));
    for (const page of model.pages) {
      if (page.templateId === "redirect-hop") continue;
      expect(fingerprintById.has(page.templateId)).toBe(true);
    }
  });

  test("cleanRatio-influenced defaults leave a meaningful share of pages issue-free", () => {
    const model = generateSiteModel({ seed: "clean-ratio-default", pageCount: 2000 });
    expect(model.issueSummary.clean).toBeGreaterThan(model.pages.length * 0.4);
  });

  test("cleanRatio actually moves the default (unconfigured) issue counts", () => {
    const mostlyClean = generateSiteModel({
      seed: "clean-ratio-high",
      pageCount: 2000,
      cleanRatio: 0.95,
    });
    const mostlyDirty = generateSiteModel({
      seed: "clean-ratio-high",
      pageCount: 2000,
      cleanRatio: 0.1,
    });

    // Same seed, only cleanRatio differs — dirtier config must inject strictly more issues.
    expect(mostlyDirty.issueSummary["long-h1"]).toBeGreaterThan(
      mostlyClean.issueSummary["long-h1"],
    );
    expect(mostlyDirty.issueSummary["broken-link"]).toBeGreaterThan(
      mostlyClean.issueSummary["broken-link"],
    );
    expect(mostlyDirty.issueSummary.clean).toBeLessThan(mostlyClean.issueSummary.clean);
  });

  test("cleanRatio: 1 produces (approximately) zero default-injected issues", () => {
    const model = generateSiteModel({ seed: "clean-ratio-one", pageCount: 500, cleanRatio: 1 });
    for (const [tag, count] of Object.entries(model.issueSummary)) {
      if (tag === "clean") continue;
      expect(count).toBe(0);
    }
  });

  test("templateCount: 1 does not crash and every page still gets a unique path", () => {
    // redirectChains disabled: it appends extra hop pages beyond pageCount,
    // which is irrelevant noise for what this test checks (template collisions).
    const model = generateSiteModel({
      seed: "single-template",
      pageCount: 300,
      templateCount: 1,
      issues: { redirectChains: false },
    });
    expect(model.templates.length).toBe(1);
    expect(model.pages.length).toBe(300);

    const paths = new Set(model.pages.map((p) => p.path));
    expect(paths.size).toBe(model.pages.length); // no path collisions

    const home = model.pages.find((p) => p.path === "/");
    expect(home).toBeDefined();
    // Only the homepage owns "/" — every other page has a distinct, non-root path.
    for (const page of model.pages) {
      if (page !== home) expect(page.path).not.toBe("/");
    }
  });

  test("home never appears twice in a page's outgoingLinks, even when it shares a template bucket", () => {
    // Regression: home is added via an unconditional "every page links home"
    // push AND was, before the fix, also eligible as a same-template
    // "sibling" pick (pickFewExcluding only excludes the current page, not
    // home specifically) — templateCount:1 forces every page including home
    // into the same bucket, guaranteeing the collision if it existed.
    const model = generateSiteModel({
      seed: "no-duplicate-home-link",
      pageCount: 300,
      templateCount: 1,
      issues: { redirectChains: false },
    });
    for (const page of model.pages) {
      if (page.path === "/") continue;
      const homeOccurrences = page.outgoingLinks.filter((l) => l === "/").length;
      expect(homeOccurrences).toBeLessThanOrEqual(1);
    }
  });

  test("no issue class ever links a page to itself (sibling wiring, long-urls, redirect chains)", () => {
    // Regression for pickFewExcluding's/pickExcluding's exclusion — a page
    // must never end up in its own outgoingLinks (sibling wiring, long-url
    // targets), and a redirect chain must never resolve back to the same
    // page that links into it.
    const model = generateSiteModel({
      seed: "no-self-links",
      pageCount: 500,
      templateCount: 3,
      issues: {
        longUrls: { ratio: 0.3 },
        redirectChains: { count: 20, chainLength: 2 },
      },
    });
    for (const page of model.pages) {
      const targetPaths = page.outgoingLinks.map((l) => (l.split("?")[0] ?? l).split("#")[0]);
      expect(targetPaths).not.toContain(page.path);
    }

    const byPath = new Map(model.pages.map((p) => [p.path, p]));
    for (let c = 0; c < 20; c++) {
      const source = model.pages.find((p) =>
        p.outgoingLinks.includes(`/redirect-chain/${c}/hop-0`),
      );
      let current = byPath.get(`/redirect-chain/${c}/hop-0`);
      while (current && current.statusCode >= 300 && current.statusCode < 400) {
        current = byPath.get(current.redirectTo!);
      }
      // The chain's final destination is never the same page that links into it.
      expect(current?.path).not.toBe(source?.path);
    }
  });
});
