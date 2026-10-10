// squirrelscan/repo#2656: every published report is capped at the source to
// PUBLISHED_REPORT_MAX_BYTES, whatever the crawl size and whatever fires. These
// pin the contract both publish producers rely on: the size bound (normal shape,
// every-class-fails worst case, and the last-resort admission), the per-class
// sample with its true counts, the tallies the server rescore reads instead of
// the dropped pass rows, and byte-identical output for the same report.

import { describe, expect, test } from "bun:test";

import type { CheckItem, CheckResult, CheckTallies } from "@squirrelscan/core-contracts";
import {
  ENTITY_MAP_FORMAT,
  ENTITY_MAP_VERSION,
  type EntityMap,
  type EntityMapNode,
} from "@squirrelscan/core-contracts/entity-map";
import { PUBLISHED_REPORT_MAX_BYTES, REPORT_CAPS } from "@squirrelscan/core-contracts/limits";
import { checkAffectedPages } from "@squirrelscan/report/affected-pages";
import { foldOverflowChecks } from "@squirrelscan/rules/fold";
import type { RuleRunResult } from "@squirrelscan/rules/types";
import { byteLength } from "@squirrelscan/utils/bytes";

import {
  buildCheckTallies,
  capReportForPublish,
  PublishedReportTooLargeError,
  type CappableReport,
} from "../src/publish-cap";
import {
  calculateHealthScore,
  calculateHealthScoreFromTallies,
  emptyTally,
  type RuleTally,
} from "../src/scoring";

const SITE = "https://shop.example.test";
const bytesOf = (v: unknown): number => (v === undefined ? 0 : byteLength(JSON.stringify(v)));

type Severity = "error" | "warning" | "info";
interface RuleSpec {
  id: string;
  category: string;
  severity: Severity;
  weight: number;
  names: string[];
}

// Page rules shaped like the real catalog: several check names per rule, a mix
// of statuses per page, items on the failing ones.
const PAGE_RULES: RuleSpec[] = [
  { id: "core/doctype", category: "core", severity: "warning", weight: 5, names: ["doctype"] },
  { id: "core/meta-title", category: "core", severity: "error", weight: 8, names: ["title-length", "title-present"] },
  { id: "a11y/link-text", category: "a11y", severity: "warning", weight: 4, names: ["link-text"] },
  { id: "a11y/button-name", category: "a11y", severity: "error", weight: 6, names: ["button-name"] },
  { id: "images/dimensions", category: "images", severity: "warning", weight: 3, names: ["img-dimensions", "img-lazy"] },
  { id: "images/alt-text", category: "images", severity: "error", weight: 6, names: ["alt-text"] },
  { id: "perf/cls-hints", category: "perf", severity: "warning", weight: 4, names: ["cls-hints"] },
  { id: "perf/render-blocking", category: "perf", severity: "warning", weight: 5, names: ["render-blocking-css", "render-blocking-js"] },
  { id: "security/new-tab", category: "security", severity: "info", weight: 2, names: ["new-tab"] },
  { id: "content/word-count", category: "content", severity: "warning", weight: 3, names: ["word-count", "thin-content"] },
  { id: "schema/faq", category: "schema", severity: "info", weight: 2, names: ["faq-questions", "faq-valid"] },
  { id: "links/internal-links", category: "links", severity: "warning", weight: 4, names: ["internal-links"] },
];

// As many page check classes as the real catalog has (227 on a real report).
const CATEGORIES = ["core", "a11y", "images", "perf", "security", "content", "schema", "links"];
const WIDE_RULES: RuleSpec[] = Array.from({ length: 115 }, (_, r) => ({
  id: `${CATEGORIES[r % CATEGORIES.length]}/wide-${String(r).padStart(3, "0")}`,
  category: CATEGORIES[r % CATEGORIES.length]!,
  severity: "warning" as const,
  weight: 4,
  names: ["first-check", "second-check"],
}));
/** A descriptive item label, as the heaviest real items carry (~350 bytes with the id). */
const LABEL = "An element with a long accessible description that the rule quotes back ".repeat(4);

const SITE_RULES: RuleSpec[] = [
  { id: "crawl/robots-txt", category: "crawl", severity: "error", weight: 10, names: ["robots-txt-exists", "robots-txt-disallow"] },
  { id: "crawl/sitemap-exists", category: "crawl", severity: "error", weight: 8, names: ["sitemap-exists"] },
  { id: "links/broken-links", category: "links", severity: "error", weight: 9, names: ["broken-links"] },
  { id: "crawl/sitemap-coverage", category: "crawl", severity: "warning", weight: 4, names: ["sitemap-coverage"] },
  { id: "security/https", category: "security", severity: "error", weight: 10, names: ["https"] },
];

const pageUrl = (i: number): string => `${SITE}/products/item-${String(i).padStart(5, "0")}`;

/** Deterministic pseudo-random in [0, 1) from a string. */
function unit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h / 0x100000000;
}

function statusFor(key: string): CheckResult["status"] {
  const r = unit(key);
  if (r < 0.55) return "pass";
  if (r < 0.72) return "warn";
  if (r < 0.84) return "fail";
  if (r < 0.94) return "info";
  return "skipped";
}

function meta(spec: RuleSpec, scope: "page" | "site") {
  return {
    id: spec.id,
    name: spec.id.split("/")[1]!.replace(/-/g, " "),
    description: `Checks ${spec.id} across the site so every page is consistent and fast.`,
    solution: `Fix ${spec.id} on every affected page. `.repeat(12),
    category: spec.category,
    scope,
    severity: spec.severity,
    weight: spec.weight,
  };
}

function entityMap(nodes: number): EntityMap {
  const list: EntityMapNode[] = Array.from({ length: nodes }, (_, i) => ({
    key: `node-${String(i).padStart(5, "0")}`,
    id: null,
    types: ["Product"],
    name: `Product number ${i} with a long descriptive name`,
    properties: { description: `A description of product ${i} `.repeat(4) },
    occurrences: 1 + (i % 7),
    pages: [pageUrl(i)],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
    pageLocal: false,
  }));
  return {
    format: ENTITY_MAP_FORMAT,
    version: ENTITY_MAP_VERSION,
    site: `${SITE}/`,
    generatedAt: "2026-10-11T00:00:00.000Z",
    summary: {
      nodeCount: nodes,
      edgeCount: 0,
      danglingCount: 0,
      pagesTotal: nodes,
      pagesWithoutEntities: 0,
      nodesWithStableId: 0,
      stableIdShare: 0,
      countsByType: { Product: nodes },
    },
    nodes: list,
    edges: [],
    pages: [],
  };
}

type Report = CappableReport & Record<string, unknown>;

interface Shape {
  /** Every page-scope class fails on every page, with this many items. */
  everyClassFails?: number;
  /** Max-length URLs, messages, ids and labels everywhere. */
  maxStrings?: boolean;
  /** Page rules to emit (defaults to all). */
  rules?: RuleSpec[];
}

function report(pages: number, shape: Shape = {}): Report {
  const url = (i: number): string =>
    shape.maxStrings ? `${pageUrl(i)}/${"p".repeat(2048)}`.slice(0, 2048) : pageUrl(i);
  const message = (text: string): string => (shape.maxStrings ? text.padEnd(1000, "m") : text);
  const ruleResults: Report["ruleResults"] = {};
  for (const spec of shape.rules ?? PAGE_RULES) {
    const checks: CheckResult[] = [];
    for (let p = 0; p < pages; p++) {
      for (const name of spec.names) {
        const key = `${spec.id}|${name}|${p}`;
        const status = shape.everyClassFails ? "fail" : statusFor(key);
        const itemCount = shape.everyClassFails ?? (status === "warn" || status === "fail" ? Math.floor(unit(`${key}#n`) * 12) : 0);
        const items: CheckItem[] = Array.from({ length: itemCount }, (_, k) => {
          // Every fourth item is a shared asset seen on many pages.
          const id = k % 4 === 0 ? `${SITE}/assets/shared-${name}-${k}.css` : `${url(p)}#${name}-${k}`;
          const fullId = shape.maxStrings ? id.padEnd(1000, "i") : id;
          const label = shape.maxStrings ? "l".repeat(1000) : shape.everyClassFails ? LABEL : fullId;
          return { id: fullId, label };
        });
        checks.push({
          name,
          status,
          message: message(`${name} ${status} on this page`),
          pageUrl: url(p),
          ...(items.length > 0 ? { items } : {}),
          ...(status === "skipped" ? { skipReason: "no data" } : {}),
        });
      }
    }
    ruleResults[spec.id] = { meta: meta(spec, "page"), checks };
  }
  const siteChecks: CheckResult[] = [];
  for (const spec of SITE_RULES) {
    const checks: CheckResult[] = spec.names.map((name) => {
      if (name === "broken-links") {
        return {
          name,
          status: "fail" as const,
          message: "Broken links found",
          items: Array.from({ length: 40 }, (_, k) => ({
            id: `${SITE}/gone-${k}`,
            sourcePages: Array.from({ length: 5 }, (_, s) => url((k * 5 + s) % Math.max(pages, 1))),
          })),
        };
      }
      if (name === "sitemap-coverage") {
        return {
          name,
          status: "warn" as const,
          message: "Pages missing from the sitemap",
          items: Array.from({ length: Math.min(pages, 300) }, (_, k) => ({ id: url(k) })),
        };
      }
      return {
        name,
        status: name === "sitemap-exists" ? ("fail" as const) : ("pass" as const),
        message: `${name} checked`,
      };
    });
    ruleResults[spec.id] = { meta: meta(spec, "site"), checks };
    siteChecks.push(...checks);
  }
  return {
    baseUrl: `${SITE}/`,
    timestamp: "2026-10-11T00:00:00.000Z",
    totalPages: pages,
    passed: 0,
    warnings: 0,
    failed: 0,
    pages: Array.from({ length: pages }, (_, i) => ({ url: url(i), statusCode: i % 41 === 7 ? 404 : 200 })),
    siteChecks,
    summary: {
      missingTitles: [],
      missingDescriptions: Array.from({ length: 30 }, (_, i) => url(i)),
      urlIssues: Array.from({ length: 30 }, (_, i) => ({ url: url(i), issues: Array.from({ length: 20 }, (_, k) => `issue ${k}`) })),
    },
    sitemaps: {
      discovered: Array.from({ length: 80 }, (_, s) => ({
        url: `${SITE}/sitemap-${s}.xml`,
        type: "urlset",
        urls: Array.from({ length: 40 }, (_, i) => ({ loc: url(i) })),
        childSitemaps: Array.from({ length: 70 }, (_, c) => `${SITE}/sitemap-${s}-${c}.xml`),
        errors: [],
        urlCount: 40,
      })),
      sources: { robotsTxt: [], commonLocations: [] },
      totalUrls: 3200,
      orphanPages: Array.from({ length: 40 }, (_, i) => url(i)),
      missingPages: [],
      failed: [],
    },
    robotsTxt: {
      exists: true,
      url: `${SITE}/robots.txt`,
      content: "User-agent: *\nDisallow: /private\n".repeat(400),
      sizeBytes: 12_800,
      sitemaps: [`${SITE}/sitemap.xml`],
      rules: Array.from({ length: 3 }, (_, g) => ({
        userAgent: `bot-${g}`,
        rules: Array.from({ length: 40 }, (_, r) => ({ type: "disallow", path: `/p${g}/${r}` })),
      })),
      errors: [],
    },
    resourceSizes: {
      css: Array.from({ length: 40 }, (_, i) => ({
        url: `${SITE}/assets/style-${i}.css`,
        status: 200,
        error: null,
        contentType: "text/css",
        sizeBytes: 40_000 + i,
        sourcePages: Array.from({ length: 20 }, (_, s) => url(s)),
      })),
      images: [],
    },
    sitemapUrlStatuses: Array.from({ length: 150 }, (_, i) => ({ url: url(i), status: 200, error: null })),
    entityMap: entityMap(2_000),
    rulesCache: { pagesReplayed: 0, pagesEvaluated: pages },
    ruleResults,
  };
}

function classesOf(capped: ReturnType<typeof capReportForPublish>): CheckResult[] {
  return Object.values(capped.ruleResults).flatMap((rule) => rule.checks);
}

const reportBudget = PUBLISHED_REPORT_MAX_BYTES - REPORT_CAPS.envelopeBytes;
/** Large inputs take seconds to build on a loaded machine; bun's default is 5s. */
const SLOW = 60_000;

describe("capReportForPublish: size", () => {
  test("a normal shape fits at the first tier, flat from 50 to 10,000 pages", () => {
    const sizes: Record<number, number> = {};
    for (const pages of [50, 500, 2_000]) {
      const capped = capReportForPublish(report(pages));
      expect(bytesOf(capped)).toBeLessThanOrEqual(reportBudget);
      expect(capped.detail.tier).toBe(0);
      sizes[pages] = bytesOf({ ...capped, resolutionSignal: undefined, pageStatuses: undefined });
    }
    // A lighter shape for 10,000 pages (two rules), so the test stays cheap.
    const light = (pages: number) => {
      const capped = capReportForPublish(report(pages, { rules: PAGE_RULES.slice(0, 2) }));
      return bytesOf({ ...capped, resolutionSignal: undefined, pageStatuses: undefined });
    };
    const light2k = light(2_000);
    const light10k = light(10_000);
    // Everything but the crawled-page transport is flat in pages.
    expect(Math.abs(sizes[2_000]! - sizes[500]!)).toBeLessThan(8 * 1024);
    expect(Math.abs(light10k - light2k)).toBeLessThan(8 * 1024);
  }, SLOW);

  test("every class failing on every page fits at a later tier", () => {
    const capped = capReportForPublish(report(100, { rules: WIDE_RULES, everyClassFails: 10 }));
    expect(bytesOf(capped)).toBeLessThanOrEqual(reportBudget);
    expect(capped.detail.tier).toBe(1);
  }, SLOW);

  test("max-length strings everywhere fit at the counts-only tier", () => {
    const capped = capReportForPublish(
      report(12, { rules: WIDE_RULES, everyClassFails: 5, maxStrings: true }),
    );
    expect(bytesOf(capped)).toBeLessThanOrEqual(reportBudget);
    expect(capped.detail.tier).toBe(REPORT_CAPS.tiers.length - 1);
    expect(capped.detail.classesDropped).toBeUndefined();
  }, SLOW);

  test("past the tiers, classes are admitted by byte budget and the body still fits", () => {
    // 60 rules x 25 distinct classes x long messages: no sample tier is enough.
    const rules: RuleSpec[] = Array.from({ length: 60 }, (_, r) => ({
      id: `content/many-${String(r).padStart(2, "0")}`,
      category: "content",
      severity: "warning" as const,
      weight: 3,
      names: Array.from({ length: 25 }, (_, n) => `check-${n}`),
    }));
    const input = report(4, { rules, everyClassFails: 1, maxStrings: true });
    const capped = capReportForPublish(input, { maxBytes: 256 * 1024 });
    expect(bytesOf(capped)).toBeLessThanOrEqual(256 * 1024 - REPORT_CAPS.envelopeBytes);
    expect(capped.detail.classesDropped).toBeGreaterThan(0);
    expect(capped.detail.entityMapDropped).toBe(true);
    // The scorer's critical-penalty checks survive any cut.
    const sitemap = capped.ruleResults["crawl/sitemap-exists"]!.checks;
    expect(sitemap.map((c) => [c.name, c.status])).toEqual([["sitemap-exists", "fail"]]);
    // Dropped classes are still counted.
    expect(capped.checkTallies["content/many-59"]).toBeDefined();
  }, SLOW);

  test("a skeleton that fits is published even with every class left out", () => {
    const input = report(3, { rules: PAGE_RULES.slice(0, 3) });
    const fits = (maxBytes: number): boolean => {
      try {
        capReportForPublish(input, { maxBytes });
        return true;
      } catch (err) {
        if (err instanceof PublishedReportTooLargeError) return false;
        throw err;
      }
    };
    let lo = REPORT_CAPS.envelopeBytes;
    let hi = REPORT_CAPS.envelopeBytes + 64 * 1024;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    const capped = capReportForPublish(input, { maxBytes: hi });
    expect(bytesOf(capped)).toBeLessThanOrEqual(hi - REPORT_CAPS.envelopeBytes);
    expect(classesOf(capped)).toHaveLength(0);
    expect(capped.siteChecks).toHaveLength(0);
  });

  test("a skeleton over budget is refused with a typed error", () => {
    const maxBytes = REPORT_CAPS.envelopeBytes + 2 * 1024;
    expect(() => capReportForPublish(report(10), { maxBytes })).toThrow(
      PublishedReportTooLargeError,
    );
  });
});

describe("capReportForPublish: the sample and its counts", () => {
  const input = report(500);
  const capped = capReportForPublish(input, { fullDetail: "local" });

  test("each class keeps at most 10 pages and 5 items, with 1 source page each", () => {
    for (const check of classesOf(capped)) {
      expect(check.pages?.length ?? 0).toBeLessThanOrEqual(10);
      expect(check.items?.length ?? 0).toBeLessThanOrEqual(5);
      for (const item of check.items ?? []) {
        expect(item.sourcePages?.length ?? 0).toBeLessThanOrEqual(1);
        expect(item.label === undefined || item.label !== item.id).toBe(true);
      }
    }
  });

  test("true page, item and occurrence totals are recoverable from details", () => {
    const rule = input.ruleResults["images/dimensions"]!;
    const out = capped.ruleResults["images/dimensions"]!.checks;
    for (const status of ["warn", "fail"] as const) {
      const members = rule.checks.filter((c) => c.name === "img-dimensions" && c.status === status);
      const pages = new Set(members.map((c) => c.pageUrl));
      const items = new Set(members.flatMap((c) => (c.items ?? []).map((i) => i.id)));
      const agg = out.find((c) => c.name === "img-dimensions" && c.status === status)!;
      expect(agg.details?.aggregated).toBe(true);
      expect(agg.details?.occurrences).toBe(members.length);
      expect(agg.details?.pagesTruncated).toBe(pages.size);
      expect((agg.items?.length ?? 0) + (agg.details?.additional as number)).toBe(items.size);
      expect(agg.message).toBe(`img-dimensions ${status} on this page (+${members.length - 1} more pages)`);
    }
  });

  test("per-page pass rows are dropped; site checks of every status stay", () => {
    for (const check of classesOf(capped)) {
      if (check.status === "pass") expect(check.pageUrl ?? check.details?.aggregated).toBeUndefined();
    }
    const robots = capped.ruleResults["crawl/robots-txt"]!.checks;
    expect(robots.map((c) => c.status)).toEqual(["pass", "pass"]);
  });

  test("a site check sampled through its items records the pages it named", () => {
    const coverage = capped.ruleResults["crawl/sitemap-coverage"]!.checks[0]!;
    expect(coverage.items).toHaveLength(5);
    expect(coverage.details?.pagesTruncated).toBe(300);
    expect(coverage.details?.additional).toBe(295);
    const links = capped.ruleResults["links/broken-links"]!.checks[0]!;
    const named = checkAffectedPages(input.ruleResults["links/broken-links"]!.checks[0]!).size;
    expect(links.details?.pagesTruncated).toBe(named);
  });

  test("pages named by more items than a check may carry are all counted", () => {
    const items = Array.from({ length: 1_500 }, (_, k) => ({ id: pageUrl(k) }));
    const input: Report = {
      ruleResults: {
        "crawl/sitemap-coverage": {
          meta: meta(SITE_RULES[3]!, "site"),
          checks: [{ name: "sitemap-coverage", status: "warn", message: "missing", items }],
        },
      },
      siteChecks: [{ name: "sitemap-coverage", status: "warn", message: "missing", items }],
    };
    const capped = capReportForPublish(input);
    const check = capped.ruleResults["crawl/sitemap-coverage"]!.checks[0]!;
    expect(check.details?.pagesTruncated).toBe(1_500);
    expect(check.details?.additional).toBe(1_495);
    expect(capped.siteChecks[0]!.details?.pagesTruncated).toBe(1_500);
  });

  test("members naming different pages through their items all count", () => {
    const aggregate = (from: number): CheckResult => ({
      name: "sitemap-coverage",
      status: "warn",
      message: "missing",
      items: Array.from({ length: 800 }, (_, k) => ({ id: pageUrl(from + k) })),
      details: { aggregated: true, occurrences: 800 },
    });
    const input: Report = {
      ruleResults: {
        "crawl/sitemap-coverage": {
          meta: meta(SITE_RULES[3]!, "site"),
          checks: [aggregate(0), aggregate(800)],
        },
      },
    };
    const check = capReportForPublish(input).ruleResults["crawl/sitemap-coverage"]!.checks[0]!;
    expect(check.details?.pagesTruncated).toBe(1_600);
    expect(check.details?.occurrences).toBe(1_600);
  });

  test("rule text leaves the body; identity and scoring fields stay", () => {
    const m = capped.ruleResults["core/meta-title"]!.meta;
    expect(m).toEqual({
      id: "core/meta-title",
      name: "meta title",
      description: "",
      category: "core",
      scope: "page",
      severity: "error",
      weight: 8,
    });
  });

  test("the detail stamp says the report is capped and where the rest is", () => {
    expect(capped.detail).toEqual({
      capped: true,
      tier: 0,
      caps: { ...REPORT_CAPS.tiers[0], classesPerRule: REPORT_CAPS.classesPerRule },
      fullDetail: "local",
    });
  });

  test("display sections are capped and local-only fields dropped", () => {
    const loose = capped as unknown as Record<string, any>;
    expect(loose.pages).toEqual([]);
    expect(loose.rulesCache).toBeUndefined();
    expect(loose.summary.missingDescriptions).toHaveLength(10);
    expect(loose.summary.urlIssues[0].issues).toHaveLength(10);
    expect(loose.sitemaps.discovered).toHaveLength(REPORT_CAPS.sitemapEntries);
    expect(loose.sitemaps.discovered[0].childSitemaps).toHaveLength(REPORT_CAPS.sitemapChildren);
    expect(loose.robotsTxt.rules.flatMap((g: any) => g.rules)).toHaveLength(REPORT_CAPS.robotsDirectives);
    expect(loose.robotsTxt.content.length).toBeLessThanOrEqual(5000);
    expect(loose.resourceSizes.css).toHaveLength(REPORT_CAPS.resourceRowsPerCategory);
    expect(loose.resourceSizes.css[0].sourcePages).toHaveLength(REPORT_CAPS.resourceSourcePages);
    expect(loose.sitemapUrlStatuses).toHaveLength(100);
    expect(bytesOf(loose.entityMap)).toBeLessThanOrEqual(REPORT_CAPS.entityMapMaxBytes);
    expect(loose.pageStatuses.every((p: { status: number }) => p.status === 404)).toBe(true);
    expect(loose.resolutionSignal.crawledUrls).toHaveLength(500);
  });
});

describe("capReportForPublish: classes", () => {
  test("a rule past 25 classes keeps the failing ones and stamps the total", () => {
    const names = Array.from({ length: 30 }, (_, n) => `c-${String(n).padStart(2, "0")}`);
    const checks: CheckResult[] = names.map((name, n) => ({
      name,
      status: n < 10 ? "info" : "fail",
      message: name,
      pageUrl: pageUrl(n),
    }));
    const input: Report = {
      ruleResults: {
        "content/wide": { meta: meta({ id: "content/wide", category: "content", severity: "warning", weight: 2, names }, "page"), checks },
      },
    };
    const out = capReportForPublish(input).ruleResults["content/wide"]!.checks;
    expect(out).toHaveLength(REPORT_CAPS.classesPerRule);
    expect(out.filter((c) => c.status === "fail")).toHaveLength(20);
    expect(out.at(-1)!.details?.checksTruncated).toBe(30);
  });

  test("an already folded report folds once more without stacking the suffix", () => {
    const input = report(600, { rules: PAGE_RULES.slice(0, 1) });
    const rule = input.ruleResults["core/doctype"]!;
    const prefolded: Report = {
      ...input,
      ruleResults: { "core/doctype": { ...rule, checks: foldOverflowChecks(rule.checks) } },
    };
    const fresh = capReportForPublish(input).ruleResults["core/doctype"]!.checks;
    const again = capReportForPublish(prefolded).ruleResults["core/doctype"]!.checks;
    expect(again).toEqual(fresh);
    for (const c of again) expect(c.message).not.toMatch(/more pages\).*more pages\)/);
  });

  test("an aggregate and more pages of its class fold into one, with one suffix", () => {
    const input = report(600, { rules: PAGE_RULES.slice(0, 1) });
    const rule = input.ruleResults["core/doctype"]!;
    const late = report(620, { rules: PAGE_RULES.slice(0, 1) }).ruleResults["core/doctype"]!.checks.slice(600);
    const mixed: Report = {
      ruleResults: {
        "core/doctype": { ...rule, checks: [...foldOverflowChecks(rule.checks), ...late] },
      },
    };
    const expected = capReportForPublish({
      ruleResults: { "core/doctype": { ...rule, checks: [...rule.checks, ...late] } },
    }).ruleResults["core/doctype"]!.checks;
    const out = capReportForPublish(mixed).ruleResults["core/doctype"]!.checks;
    expect(out).toEqual(expected);
    const fail = out.find((c) => c.status === "fail")!;
    expect(fail.message).toMatch(/^doctype fail on this page \(\+\d+ more pages\)$/);
  });

  test("a class of one page stays that page's check", () => {
    const input: Report = {
      ruleResults: {
        "core/doctype": {
          meta: meta(PAGE_RULES[0]!, "page"),
          checks: [
            { name: "doctype", status: "fail", message: "Missing doctype", pageUrl: pageUrl(1), value: "none" },
            { name: "doctype", status: "pass", message: "ok", pageUrl: pageUrl(2) },
          ],
        },
      },
    };
    const out = capReportForPublish(input).ruleResults["core/doctype"]!.checks;
    expect(out).toEqual([{ name: "doctype", status: "fail", message: "Missing doctype", pageUrl: pageUrl(1), value: "none" }]);
  });

  test("carried and fresh findings of one class stay apart", () => {
    const checks: CheckResult[] = [1, 2, 3, 4].map((i) => ({
      name: "doctype",
      status: "fail" as const,
      message: "Missing doctype",
      pageUrl: pageUrl(i),
      ...(i > 2 ? { provenance: "carried" as const, lastSeenAt: 1_000 + i } : {}),
    }));
    const input: Report = { ruleResults: { "core/doctype": { meta: meta(PAGE_RULES[0]!, "page"), checks } } };
    const out = capReportForPublish(input).ruleResults["core/doctype"]!.checks;
    expect(out.map((c) => [c.provenance, c.details?.occurrences])).toEqual([
      [undefined, 2],
      ["carried", 2],
    ]);
    // Replays are the server's to count, not this run's.
    expect(capReportForPublish(input).checkTallies["core/doctype"]).toEqual({
      doctype: { failed: 2, failUnits: 2 },
    });
  });
});

describe("capReportForPublish: tallies", () => {
  /** Rule tallies from the published per-name tallies, as a server reader sums them. */
  function ruleTallies(tallies: CheckTallies, input: Report): Map<string, RuleTally> {
    const out = new Map<string, RuleTally>();
    for (const [ruleId, rule] of Object.entries(input.ruleResults)) {
      const tally = emptyTally();
      for (const t of Object.values(tallies[ruleId] ?? {})) {
        tally.passed += t.passed ?? 0;
        tally.warnings += t.warnings ?? 0;
        tally.failed += t.failed ?? 0;
        tally.warnUnits += t.warnUnits ?? 0;
        tally.failUnits += t.failUnits ?? 0;
      }
      out.set(ruleId, { meta: rule.meta as unknown as RuleTally["meta"], tally });
    }
    return out;
  }

  test("the score from the tallies equals the score from every row", () => {
    const input = report(300);
    const capped = capReportForPublish(input);
    const full = new Map<string, RuleRunResult>(
      Object.entries(input.ruleResults).map(([id, r]) => [id, r as unknown as RuleRunResult]),
    );
    const penalty = new Map<string, RuleRunResult>(
      ["crawl/robots-txt", "crawl/sitemap-exists"].map((id) => [
        id,
        capped.ruleResults[id] as unknown as RuleRunResult,
      ]),
    );
    const expected = calculateHealthScore({ results: full });
    expect(calculateHealthScoreFromTallies(ruleTallies(capped.checkTallies, input), penalty)).toEqual(
      expected,
    );
    expect(expected.overall).toBeGreaterThan(0);
  }, SLOW);

  test("an input already folded by the adapter tallies to the same score", () => {
    const input = report(300);
    const prefolded: Report = {
      ...input,
      ruleResults: Object.fromEntries(
        Object.entries(input.ruleResults).map(([id, r]) => [id, { ...r, checks: foldOverflowChecks(r.checks) }]),
      ),
    };
    // Rules with two check names cross the 500-row fold at 300 pages.
    expect(prefolded.ruleResults["core/meta-title"]!.checks.length).toBeLessThan(10);
    expect(buildCheckTallies(prefolded.ruleResults)).toEqual(buildCheckTallies(input.ruleResults));
  }, SLOW);

  test("tallies are bounded by rules x check names, not pages", () => {
    const small = bytesOf(buildCheckTallies(report(50).ruleResults));
    const large = bytesOf(buildCheckTallies(report(2_000).ruleResults));
    // Only the digits grow.
    expect(large - small).toBeLessThan(2 * 1024);
  }, SLOW);
});

describe("capReportForPublish: determinism", () => {
  test("the same report caps to the same bytes, whatever order it was built in", () => {
    const input = report(200);
    const once = JSON.stringify(capReportForPublish(input));
    expect(JSON.stringify(capReportForPublish(input))).toBe(once);
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as Report;
    reordered.ruleResults = Object.fromEntries(Object.entries(input.ruleResults).reverse());
    expect(JSON.stringify(capReportForPublish(reordered))).toBe(once);
  }, SLOW);

  test("the order a crawl met the pages in does not change the output", () => {
    const input = report(120);
    const reversed: Report = {
      ...input,
      ruleResults: Object.fromEntries(
        Object.entries(input.ruleResults).map(([id, r]) => [
          id,
          { ...r, checks: r.meta.scope === "page" ? [...r.checks].reverse() : r.checks },
        ]),
      ),
      pages: [...(input.pages ?? [])].reverse(),
    };
    expect(JSON.stringify(capReportForPublish(reversed))).toBe(JSON.stringify(capReportForPublish(input)));
  }, SLOW);

  test("an aggregate built elsewhere is sampled the same whatever its page order", () => {
    const pages = Array.from({ length: 30 }, (_, i) => pageUrl(i));
    const aggregate = (list: string[]): Report => ({
      ruleResults: {
        "core/doctype": {
          meta: meta(PAGE_RULES[0]!, "page"),
          checks: [
            {
              name: "doctype",
              status: "fail",
              message: "Missing doctype (+29 more pages)",
              pages: list,
              details: { aggregated: true, occurrences: 30 },
            },
          ],
        },
      },
    });
    const sorted = capReportForPublish(aggregate(pages));
    expect(JSON.stringify(capReportForPublish(aggregate([...pages].reverse())))).toBe(
      JSON.stringify(sorted),
    );
    expect(sorted.ruleResults["core/doctype"]!.checks[0]!.pages).toEqual(pages.slice(0, 10));
  });

  test("the input is not mutated", () => {
    const input = report(60);
    const before = JSON.stringify(input);
    capReportForPublish(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
