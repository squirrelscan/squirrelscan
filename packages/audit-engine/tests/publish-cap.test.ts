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
import {
  PUBLISHED_REPORT_MAX_BYTES,
  REPORT_CAPS,
  RESOLUTION_PUBLISH_LIMITS,
} from "@squirrelscan/core-contracts/limits";
import { decodeResolutionSignal } from "@squirrelscan/rules/resolution-decode";
import { checkAffectedPages } from "@squirrelscan/report/affected-pages";
import { capMixedRuleChecksForPublish, foldOverflowChecks } from "@squirrelscan/rules/fold";
import {
  buildResolutionSignal,
  PAGE_STATUSES_KEY_BYTES,
  RESOLUTION_SIGNAL_KEY_BYTES,
} from "@squirrelscan/rules/resolution";
import type { RuleRunResult } from "@squirrelscan/rules/types";
import { byteLength } from "@squirrelscan/utils/bytes";
import { decodeLinkTargetSet, linkTargetHash } from "@squirrelscan/utils/link-target-set";

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
      // A lazy image's deferred pages are bounded like its source pages (#1252).
      images: [
        {
          url: `${SITE}/assets/lazy.jpg`,
          status: 200,
          error: null,
          contentType: "image/jpeg",
          sizeBytes: 90_000,
          sourcePages: Array.from({ length: 20 }, (_, s) => url(s)),
          deferredPages: Array.from({ length: 20 }, (_, s) => url(s)),
        },
      ],
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
      sizes[pages] = bytesOf({ ...capped, resolutionSignalCompact: undefined, pageStatuses: undefined });
    }
    // A lighter shape for 10,000 pages (two rules), so the test stays cheap.
    const light = (pages: number) => {
      const capped = capReportForPublish(report(pages, { rules: PAGE_RULES.slice(0, 2) }));
      // The whole body too, transport included, at any page count (repo#2658).
      expect(bytesOf(capped)).toBeLessThanOrEqual(reportBudget);
      return bytesOf({ ...capped, resolutionSignalCompact: undefined, pageStatuses: undefined });
    };
    const light2k = light(2_000);
    const light10k = light(10_000);
    // Everything but the crawled-page transport is flat in pages.
    expect(Math.abs(sizes[2_000]! - sizes[500]!)).toBeLessThan(8 * 1024);
    expect(Math.abs(light10k - light2k)).toBeLessThan(8 * 1024);
  }, SLOW);

  test("every class failing on every page fills breadth first and keeps every class", () => {
    // Twice the wide rules: with the transport bounded, the body has the room
    // the raw signal used to take, and one set of them now fits at tier 0.
    const rules = [...WIDE_RULES, ...WIDE_RULES.map((rule) => ({ ...rule, id: `${rule.id}-b` }))];
    const capped = capReportForPublish(report(100, { rules, everyClassFails: 10 }));
    // The whole body, transport included, fits (repo#2658 bounds the signal),
    // and the transport stays inside its own share.
    expect(bytesOf(capped)).toBeLessThanOrEqual(reportBudget);
    const transport =
      bytesOf(capped.resolutionSignalCompact) +
      RESOLUTION_SIGNAL_KEY_BYTES +
      (capped.pageStatuses ? bytesOf(capped.pageStatuses) + PAGE_STATUSES_KEY_BYTES : 0);
    expect(capped.resolutionSignalCompact).toBeDefined();
    expect(transport).toBeLessThanOrEqual(REPORT_CAPS.signalMaxBytes);
    expect(capped.detail.tier).toBe(1);
    expect(capped.detail.classesDropped).toBeUndefined();
    // Every failing class has a row: 2 per wide rule, plus sitemap-exists and broken-links.
    const classes = classesOf(capped).filter((c) => c.status === "fail");
    expect(classes).toHaveLength(rules.length * 2 + 2);
    // Some kept the full sample, some a smaller one.
    const sampled = classes.filter((c) => c.details?.aggregated === true);
    expect(sampled.some((c) => c.pages?.length === 10 && c.items?.length === 5)).toBe(true);
    expect(sampled.some((c) => (c.pages?.length ?? 0) < 10)).toBe(true);
    expect(capped.detail.classesReduced).toBeGreaterThan(0);
  }, SLOW);

  test("max-length strings everywhere still give every class a row", () => {
    const capped = capReportForPublish(
      report(12, { rules: WIDE_RULES, everyClassFails: 5, maxStrings: true }),
    );
    expect(bytesOf(capped)).toBeLessThanOrEqual(reportBudget);
    // 2 KiB URLs fill even the capped display sections: they go to their
    // minimum, the entity map goes, and every class still gets a row.
    expect(capped.detail.tier).toBe(2);
    expect(capped.detail.entityMapDropped).toBe(true);
    expect(capped.detail.classesDropped).toBeUndefined();
    expect(classesOf(capped).filter((c) => c.status === "fail")).toHaveLength(WIDE_RULES.length * 2 + 2);
  }, SLOW);

  test("multi-byte text is bounded in bytes, clamped in UTF-16 units, never split", () => {
    // CJK is 3 UTF-8 bytes per unit; the leading "x" puts every emoji pair
    // across an odd cut, where a plain slice would orphan a surrogate.
    const cjk = "検査結果の詳細説明".repeat(120);
    const emoji = `x${"😀".repeat(600)}`;
    const rules: RuleSpec[] = WIDE_RULES.slice(0, 60);
    const base = report(20, { rules, everyClassFails: 6 });
    const input: Report = {
      ...base,
      ruleResults: Object.fromEntries(
        Object.entries(base.ruleResults).map(([id, r]) => [
          id,
          {
            ...r,
            checks: r.checks.map((c, i) => ({
              ...c,
              message: i % 2 === 0 ? cjk : emoji,
              ...(c.items
                ? { items: c.items.map((item, k) => ({ id: `${item.id}-${cjk.slice(0, 40)}`, label: k % 2 ? cjk : emoji })) }
                : {}),
            })),
          },
        ]),
      ),
    };
    const capped = capReportForPublish(input);
    const json = JSON.stringify(capped);
    expect(byteLength(json)).toBeLessThanOrEqual(reportBudget);
    // No lone surrogate anywhere: JSON.stringify escapes one as \udXXX.
    expect(json).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const messages = classesOf(capped).map((c) => c.message);
    const longest = REPORT_CAPS.tiers[0]!.messageChars + " (+19 more pages)".length;
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(longest);
    // The unit cap is not a byte cap: the fitter is what holds the size.
    expect(messages.some((m) => byteLength(m) > m.length * 2)).toBe(true);
    expect(capped.detail.classesDropped).toBeUndefined();
  }, SLOW);

  test("the fill gives the full sample to the classes that matter most", () => {
    // One failing and one warning class, same shape: just under the size that
    // fits both at the full sample, the warning one is the one cut.
    const rules: RuleSpec[] = [
      { id: "a11y/fails", category: "a11y", severity: "warning", weight: 4, names: ["fails"] },
      { id: "a11y/warns", category: "a11y", severity: "warning", weight: 4, names: ["warns"] },
    ];
    const base = report(60, { rules, everyClassFails: 8 });
    // Only these two classes, so nothing else competes for the last bytes.
    const warned: Report = {
      ...base,
      siteChecks: [],
      ruleResults: {
        "a11y/fails": base.ruleResults["a11y/fails"]!,
        "a11y/warns": {
          ...base.ruleResults["a11y/warns"]!,
          checks: base.ruleResults["a11y/warns"]!.checks.map((c) => ({ ...c, status: "warn" as const })),
        },
      },
    };
    const roomy = capReportForPublish(warned);
    expect(roomy.detail.tier).toBe(0);
    const transport =
      (roomy.resolutionSignalCompact
        ? bytesOf(roomy.resolutionSignalCompact) + RESOLUTION_SIGNAL_KEY_BYTES
        : 0) + (roomy.pageStatuses ? bytesOf(roomy.pageStatuses) + PAGE_STATUSES_KEY_BYTES : 0);
    const body = bytesOf({ ...roomy, resolutionSignalCompact: undefined, pageStatuses: undefined });
    const tight = capReportForPublish(warned, {
      maxBytes: body - 1 + REPORT_CAPS.envelopeBytes + transport,
    });
    expect(tight.detail.tier).toBe(1);
    expect(tight.detail.classesReduced).toBe(1);
    // Before and after (repo#2669): the full-sample size is the roomy body's.
    expect(roomy.detail.fullSampleBytes).toBeUndefined();
    expect(Math.abs(tight.detail.fullSampleBytes! - bytesOf(roomy))).toBeLessThanOrEqual(4);
    expect(tight.detail.fullSampleBytes!).toBeGreaterThan(bytesOf(tight));
    const fails = tight.ruleResults["a11y/fails"]!.checks[0]!;
    const warns = tight.ruleResults["a11y/warns"]!.checks[0]!;
    expect(fails.pages).toHaveLength(REPORT_CAPS.tiers[0]!.pagesPerClass);
    expect(warns.pages).toHaveLength(REPORT_CAPS.tiers[1]!.pagesPerClass);
    // 60 pages, 2 of them 404 this run (7 and 48), which no class counts (repo#2657).
    expect(warns.details?.pagesTruncated).toBe(58);
  }, SLOW);

  test("past the fill, classes are admitted by byte budget and the body still fits", () => {
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
    expect(capped.detail.tier).toBe(3);
    expect(capped.detail.classesDropped).toBeGreaterThan(0);
    expect(capped.detail.entityMapDropped).toBe(true);
    // The scorer's critical-penalty checks survive any cut.
    const sitemap = capped.ruleResults["crawl/sitemap-exists"]!.checks;
    expect(sitemap.map((c) => [c.name, c.status])).toEqual([["sitemap-exists", "fail"]]);
    // Dropped classes are still counted.
    expect(capped.checkTallies["content/many-59"]).toBeDefined();
  }, SLOW);

  test("a not-checked skip survives the byte-budget cut (repo#2729)", () => {
    const rules: RuleSpec[] = Array.from({ length: 60 }, (_, r) => ({
      id: `content/many-${String(r).padStart(2, "0")}`,
      category: "content",
      severity: "warning" as const,
      weight: 3,
      names: Array.from({ length: 25 }, (_, n) => `check-${n}`),
    }));
    const input = report(4, { rules, everyClassFails: 1, maxStrings: true });
    input.ruleResults["links/broken-external-links"] = {
      meta: meta(
        { id: "links/broken-external-links", category: "links", severity: "warning", weight: 5, names: [] },
        "site",
      ),
      checks: [
        {
          name: "broken-external-links",
          status: "skipped",
          message: "External link checking was off for this audit, so external links were not checked",
          skipReason: "external-links-not-checked",
        },
      ],
    };
    const capped = capReportForPublish(input, { maxBytes: 256 * 1024 });
    expect(capped.detail.classesDropped).toBeGreaterThan(0);
    const kept = capped.ruleResults["links/broken-external-links"]!.checks;
    expect(kept.map((c) => [c.status, c.skipReason])).toEqual([["skipped", "external-links-not-checked"]]);
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

  test("the typed error carries sizes, counts and section names only (repo#2669)", () => {
    let caught: unknown;
    try {
      capReportForPublish(report(10), { maxBytes: REPORT_CAPS.envelopeBytes + 2 * 1024 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PublishedReportTooLargeError);
    const err = caught as PublishedReportTooLargeError;
    expect(err.part).toBe("skeleton");
    expect(err.tier).toBe(3);
    expect(err.pages).toBe(10);
    expect(err.bytes).toBeGreaterThan(err.budgetBytes);
    // What a producer reports: no URL, no report text.
    const reported = JSON.stringify({
      bytes: err.bytes,
      budgetBytes: err.budgetBytes,
      part: err.part,
      tier: err.tier,
      pages: err.pages,
      largestSections: err.largestSections,
    });
    expect(reported).not.toContain(SITE.replace("https://", ""));
    for (const section of Object.keys(err.largestSections)) expect(section).toMatch(/^[A-Za-z]+$/);
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
    // A page that 404'd this run is in no class (repo#2657).
    const removed = new Set(input.pages!.filter((p) => p.statusCode === 404).map((p) => p.url));
    expect(removed.size).toBeGreaterThan(0);
    for (const status of ["warn", "fail"] as const) {
      const members = rule.checks.filter(
        (c) => c.name === "img-dimensions" && c.status === status && !removed.has(c.pageUrl!),
      );
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

  test("a not-checked site skip keeps its status, reason and message (repo#2729)", () => {
    // The server's issue sync and the dashboard read these from the capped body:
    // a dropped skip would read as a clean rule and resolve open issues again.
    const skip: CheckResult = {
      name: "broken-links",
      status: "skipped",
      message: "1 of 3 internal link target(s) were not fetched because this audit did not follow links, so they were not checked for broken links",
      skipReason: "link-targets-not-fetched",
      value: 1,
      details: { linkTargets: 3, unfetchedTargets: 1 },
    };
    const input: Report = {
      ruleResults: {
        "links/broken-links": { meta: meta(SITE_RULES[2]!, "site"), checks: [skip] },
      },
      siteChecks: [skip],
    };
    const check = capReportForPublish(input).ruleResults["links/broken-links"]!.checks[0]!;
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("link-targets-not-fetched");
    expect(check.message).toBe(skip.message);
  });

  test("broken-links coverage survives the full sample and a counts-only row (pub#794)", () => {
    // Comparing two audits' broken links reads what each covered; the large
    // reports that get a counts row are the ones it matters most on.
    const coverage = {
      linkTargets: 2_400,
      unfetchedTargets: 7,
      probedTargets: 40,
      notFetched: { overLimit: 5, skipped: 2 },
    };
    const fail: CheckResult = {
      name: "broken-links",
      status: "fail",
      message: "1500 broken internal link(s) (4xx/5xx)",
      items: Array.from({ length: 1_500 }, (_, k) => ({
        id: `${pageUrl(k)}/gone`,
        sourcePages: [pageUrl(k)],
        meta: { statusCode: 404, linkedFrom: 1 },
      })),
      details: coverage,
    };
    const input: Report = {
      ruleResults: {
        "links/broken-links": { meta: meta(SITE_RULES[2]!, "site"), checks: [fail] },
      },
    };
    const full = capReportForPublish(input).ruleResults["links/broken-links"]!.checks[0]!;
    expect(full.items!.length).toBeGreaterThan(0);
    expect(full.details).toMatchObject(coverage);

    // The smallest body that still carries the check holds it as counts only.
    const kept = (maxBytes: number): CheckResult | undefined => {
      try {
        return capReportForPublish(input, { maxBytes }).ruleResults["links/broken-links"]?.checks[0];
      } catch (err) {
        if (err instanceof PublishedReportTooLargeError) return undefined;
        throw err;
      }
    };
    let lo = REPORT_CAPS.envelopeBytes;
    let hi = REPORT_CAPS.envelopeBytes + 64 * 1024;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (kept(mid)) hi = mid;
      else lo = mid;
    }
    const counts = kept(hi)!;
    expect(counts.items).toBeUndefined();
    expect(counts.details).toMatchObject({ ...coverage, additional: 1_500 });
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
    // The top-level copy repeats the rule's check, so it is left out.
    expect(capped.siteChecks).toEqual([]);
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

  test("an entity map that cannot be projected is left out and stamped apart from a budget drop", () => {
    const broken = { ...input, entityMap: { format: "broken", nodes: null } as unknown as EntityMap };
    const out = capReportForPublish(broken);
    expect((out as unknown as Record<string, unknown>).entityMap).toBeUndefined();
    expect(out.detail.entityMapFailed).toBe(true);
    expect(out.detail.entityMapDropped).toBeUndefined();
    expect(capped.detail.entityMapFailed).toBeUndefined();
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
    expect(loose.resourceSizes.images[0].deferredPages).toHaveLength(REPORT_CAPS.resourceSourcePages);
    expect(loose.sitemapUrlStatuses).toHaveLength(100);
    expect(bytesOf(loose.entityMap)).toBeLessThanOrEqual(REPORT_CAPS.entityMapMaxBytes);
    expect(loose.pageStatuses.every((p: { status: number }) => p.status === 404)).toBe(true);
    expect(loose.resolutionSignal).toBeUndefined();
  });

  test("the scoring transport is the compact signal, built from every crawled page", async () => {
    const signal = await decodeResolutionSignal(capped.resolutionSignalCompact!);
    expect(signal.crawledUrls).toHaveLength(500);
    expect(signal.crawledComplete).toBeUndefined();
    expect(signal.removedPages?.every((p) => p.status === 404)).toBe(true);
    expect(
      bytesOf({ pageStatuses: capped.pageStatuses, resolutionSignalCompact: capped.resolutionSignalCompact }),
    ).toBeLessThanOrEqual(RESOLUTION_PUBLISH_LIMITS.maxBytes);
  });

  test("a smaller ceiling shrinks the transport's share with it", () => {
    // 3,000 pages with long unique paths: a signal several times this ceiling's
    // room if it kept the full share, and a skeleton of one small rule.
    const urls = Array.from(
      { length: 3_000 },
      (_, i) =>
        `${SITE}/${((i * 2_654_435_761) >>> 0).toString(36)}-${((i * 40_503) >>> 0).toString(16)}-${(i * 97 + 13).toString(36)}`,
    );
    const spec: RuleSpec = { id: "content/noisy", category: "content", severity: "warning", weight: 3, names: ["c"] };
    const heavy: Report = {
      ruleResults: {
        [spec.id]: {
          meta: meta(spec, "page"),
          checks: urls.map((pageUrl, i) => ({
            name: "c",
            status: i % 2 ? ("fail" as const) : ("pass" as const),
            message: "m",
            pageUrl,
          })),
        },
      },
      pages: urls.map((url) => ({ url, statusCode: 200 })),
    };
    const maxBytes = 64 * 1024;
    const small = capReportForPublish(heavy, { maxBytes });
    expect(bytesOf(small)).toBeLessThanOrEqual(maxBytes - REPORT_CAPS.envelopeBytes);
    const transport =
      bytesOf(small.resolutionSignalCompact) +
      RESOLUTION_SIGNAL_KEY_BYTES +
      (small.pageStatuses ? bytesOf(small.pageStatuses) + PAGE_STATUSES_KEY_BYTES : 0);
    expect(transport).toBeLessThanOrEqual(REPORT_CAPS.signalMaxBytes / 16);
    // At the full ceiling the same crawl keeps a bigger signal.
    expect(bytesOf(capReportForPublish(heavy).resolutionSignalCompact)).toBeGreaterThan(transport);
  }, SLOW);

  test("a report without pages publishes its statuses but no signal", () => {
    const statuses = [{ url: pageUrl(3), status: 404 }];
    const out = capReportForPublish({ ...input, pages: [], pageStatuses: statuses });
    expect(out.resolutionSignalCompact).toBeUndefined();
    expect(out.pageStatuses).toEqual(statuses);
  });

  test("a page listed twice keeps its removal, whatever the row order", () => {
    const rows = (statuses: number[]) => ({
      ...input,
      pages: statuses.map((statusCode) => ({ url: pageUrl(1), statusCode })),
    });
    const a = capReportForPublish(rows([404, 200]));
    const b = capReportForPublish(rows([200, 404]));
    expect(a.pageStatuses).toEqual([{ url: pageUrl(1), status: 404 }]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("a signal already on the input never rides along, raw or compact", () => {
    const raw = buildResolutionSignal(input.ruleResults, ["https://elsewhere.test/"]);
    const out = capReportForPublish(
      { ...input, resolutionSignal: raw, resolutionSignalCompact: { v: 1, data: "c3RhbGU=" } },
      { fullDetail: "local" },
    ) as unknown as Record<string, unknown>;
    expect(out.resolutionSignal).toBeUndefined();
    // The one it carries is built from this report's pages, the same as without.
    expect(out.resolutionSignalCompact).toEqual(capped.resolutionSignalCompact);
    expect(Object.keys(out).filter((key) => key.startsWith("resolutionSignal"))).toEqual([
      "resolutionSignalCompact",
    ]);
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
    // Every page live: with no 404 to take out, nothing is reopened.
    const base = report(600, { rules: PAGE_RULES.slice(0, 1) });
    const input: Report = { ...base, pages: base.pages!.map((p) => ({ ...p, statusCode: 200 })) };
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

  test("an already folded class naming a 404 page drops it; its total stays a floor", () => {
    const input = report(600, { rules: PAGE_RULES.slice(0, 1) });
    const removed = new Set(input.pages!.filter((p) => p.statusCode === 404).map((p) => p.url));
    const rule = input.ruleResults["core/doctype"]!;
    const prefolded: Report = {
      ...input,
      ruleResults: { "core/doctype": { ...rule, checks: foldOverflowChecks(rule.checks) } },
    };
    const fresh = capReportForPublish(input).ruleResults["core/doctype"]!.checks;
    const again = capReportForPublish(prefolded).ruleResults["core/doctype"]!.checks;
    expect(again.map((c) => [c.name, c.status])).toEqual(fresh.map((c) => [c.name, c.status]));
    again.forEach((c, i) => {
      for (const page of c.pages ?? []) expect(removed.has(page)).toBe(false);
      for (const item of c.items ?? []) {
        for (const page of item.sourcePages ?? []) expect(removed.has(page)).toBe(false);
      }
      // The earlier fold clipped some 404 pages out of its sample, so its count
      // of them cannot come off: at least the live pages, at most all of them.
      const total = c.details?.pagesTruncated as number;
      expect(total).toBeGreaterThanOrEqual(fresh[i]!.details?.pagesTruncated as number);
      expect(total).toBeLessThanOrEqual((fresh[i]!.details?.pagesTruncated as number) + removed.size);
    });
  });

  test("a class whose every page 404'd leaves the report, and the tallies", () => {
    const gone = [pageUrl(1), pageUrl(2)];
    const fail = (url: string): CheckResult => ({ name: "x", status: "fail", message: "x", pageUrl: url });
    const spec: RuleSpec = { id: "core/x", category: "core", severity: "warning", weight: 2, names: ["x"] };
    const perPage: Report = {
      ruleResults: {
        "core/x": {
          meta: meta(spec, "page"),
          checks: [
            ...gone.map(fail),
            { name: "x", status: "warn", message: "y", pageUrl: pageUrl(3) },
            { name: "x", status: "pass", message: "ok", pageUrl: pageUrl(4) },
          ],
        },
      },
      pages: [1, 2, 3, 4].map((n) => ({ url: pageUrl(n), statusCode: n <= 2 ? 404 : 200 })),
    };
    const prefolded: Report = {
      ...perPage,
      ruleResults: {
        "core/x": {
          ...perPage.ruleResults["core/x"]!,
          checks: [
            {
              name: "x",
              status: "fail",
              message: "x (+1 more pages)",
              pages: gone,
              details: { aggregated: true, occurrences: 2 },
            },
            ...perPage.ruleResults["core/x"]!.checks.slice(2),
          ],
        },
      },
    };
    for (const input of [perPage, prefolded]) {
      const capped = capReportForPublish(input);
      expect(capped.ruleResults["core/x"]!.checks.map((c) => c.status)).toEqual(["warn"]);
      expect(capped.checkTallies["core/x"]).toEqual({ x: { passed: 1, warnings: 1, warnUnits: 1 } });
    }
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

  test("items on the most pages lead the sample, with their true page count", () => {
    // Each page's own images sort first by id; two shared ones sort last.
    const checks: CheckResult[] = Array.from({ length: 30 }, (_, i) => ({
      name: "img-dimensions",
      status: "fail" as const,
      message: "Images without dimensions",
      pageUrl: pageUrl(i),
      items: [
        ...Array.from({ length: 3 }, (_, k) => ({ id: `${pageUrl(i)}#img-${k}` })),
        ...(i % 3 === 0 ? [{ id: `${SITE}/y-banner.png` }] : []),
        ...(i % 2 === 0 ? [{ id: `${SITE}/z-logo.png` }] : []),
      ],
    }));
    const input: Report = {
      ruleResults: { "images/dimensions": { meta: meta(PAGE_RULES[4]!, "page"), checks } },
    };
    const agg = capReportForPublish(input).ruleResults["images/dimensions"]!.checks[0]!;
    expect(agg.items!.map((i) => [i.id, i.pageCount])).toEqual([
      [`${SITE}/z-logo.png`, 15],
      [`${SITE}/y-banner.png`, 10],
      [`${pageUrl(0)}#img-0`, undefined],
      [`${pageUrl(0)}#img-1`, undefined],
      [`${pageUrl(0)}#img-2`, undefined],
    ]);
    for (const item of agg.items!) expect(item.sourcePages).toHaveLength(1);
    expect(agg.details?.additional).toBe(30 * 3 + 2 - 5);
  });

  test("a site check's items are ranked by their source pages too", () => {
    // Source pages listed newest first: the sample keeps the first in URL order.
    const items: CheckItem[] = Array.from({ length: 8 }, (_, k) => ({
      id: `${SITE}/gone-${k}`,
      sourcePages: Array.from({ length: k + 1 }, (_, s) => pageUrl(k - s)),
    }));
    const input: Report = {
      ruleResults: {
        "links/broken-links": {
          meta: meta(SITE_RULES[2]!, "site"),
          checks: [{ name: "broken-links", status: "fail", message: "Broken links found", items }],
        },
      },
    };
    const check = capReportForPublish(input).ruleResults["links/broken-links"]!.checks[0]!;
    expect(check.items!.map((i) => [i.id, i.pageCount])).toEqual(
      [7, 6, 5, 4, 3].map((k) => [`${SITE}/gone-${k}`, k + 1]),
    );
    for (const item of check.items!) expect(item.sourcePages).toEqual([pageUrl(0)]);
    expect(check.details?.additional).toBe(3);
  });

  test("the most widespread item survives an items array past the per-check cap", () => {
    // 1,200 items, one on 40 pages near the end: the items cap must not cut it.
    const items: CheckItem[] = Array.from({ length: 1_200 }, (_, k) => ({
      id: `${SITE}/gone-${String(k).padStart(4, "0")}`,
      sourcePages: k === 1_150 ? Array.from({ length: 40 }, (_, s) => pageUrl(s)) : [pageUrl(k % 50)],
    }));
    const check: CheckResult = { name: "broken-links", status: "fail", message: "Broken links found", items };
    const input: Report = {
      ruleResults: {
        "links/broken-links": { meta: meta(SITE_RULES[2]!, "site"), checks: [check] },
      },
      // The producer's top-level copy, clamped (first 1,000 items) the way report-stream clamps it.
      siteChecks: capMixedRuleChecksForPublish([check], 500),
    };
    const capped = capReportForPublish(input);
    const out = capped.ruleResults["links/broken-links"]!.checks[0]!;
    expect(out.items![0]).toEqual({ id: `${SITE}/gone-1150`, sourcePages: [pageUrl(0)], pageCount: 40 });
    expect((out.items?.length ?? 0) + (out.details?.additional as number)).toBe(1_200);
    // Still recognised as the same check as the clamped top-level copy.
    expect(capped.siteChecks).toEqual([]);
  });

  test("the page a class hits hardest leads its page sample", () => {
    const checks: CheckResult[] = Array.from({ length: 30 }, (_, i) => ({
      name: "alt-text",
      status: "fail" as const,
      message: "Images without alt text",
      pageUrl: pageUrl(i),
      items: Array.from({ length: i === 17 ? 9 : 1 }, (_, k) => ({ id: `${pageUrl(i)}#img-${k}` })),
    }));
    const input: Report = { ruleResults: { "images/alt-text": { meta: meta(PAGE_RULES[5]!, "page"), checks } } };
    const agg = capReportForPublish(input).ruleResults["images/alt-text"]!.checks[0]!;
    expect(agg.pages).toEqual([pageUrl(17), ...Array.from({ length: 9 }, (_, i) => pageUrl(i))]);
    expect(agg.details?.pagesTruncated).toBe(30);
    // No page outweighs another: the sample stays in URL order.
    const even: Report = {
      ruleResults: {
        "images/alt-text": {
          meta: meta(PAGE_RULES[5]!, "page"),
          checks: checks.map((c) => ({ ...c, items: c.items!.slice(0, 1) })),
        },
      },
    };
    const flat = capReportForPublish(even).ruleResults["images/alt-text"]!.checks[0]!;
    expect(flat.pages).toEqual(Array.from({ length: 10 }, (_, i) => pageUrl(i)));
    // An aggregate built elsewhere: only one of its pages has items.
    const pages = Array.from({ length: 30 }, (_, i) => pageUrl(i));
    const prefolded: Report = {
      ruleResults: {
        "images/alt-text": {
          meta: meta(PAGE_RULES[5]!, "page"),
          checks: [
            {
              name: "alt-text",
              status: "fail",
              message: "Images without alt text (+29 more pages)",
              pages,
              items: [0, 1].map((k) => ({ id: `${pageUrl(23)}#img-${k}`, sourcePages: [pageUrl(23)] })),
              details: { aggregated: true, occurrences: 30 },
            },
          ],
        },
      },
    };
    expect(capReportForPublish(prefolded).ruleResults["images/alt-text"]!.checks[0]!.pages![0]).toBe(pageUrl(23));
  });

  test("top-level site checks that repeat a rule's check are left out", () => {
    const input = report(50);
    expect(input.siteChecks!.length).toBeGreaterThan(0);
    expect(capReportForPublish(input).siteChecks).toEqual([]);
    // A site check no rule carries stays.
    const orphan: CheckResult = { name: "orphan-check", status: "warn", message: "Only here" };
    const withOrphan: Report = { ...input, siteChecks: [...input.siteChecks!, orphan] };
    expect(capReportForPublish(withOrphan).siteChecks).toEqual([orphan]);
    // Key order does not hide a copy.
    const reordered: Report = {
      ...input,
      siteChecks: input.siteChecks!.map((c) => Object.fromEntries(Object.entries(c).reverse()) as CheckResult),
    };
    expect(capReportForPublish(reordered).siteChecks).toEqual([]);
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
    // Every row the server's rescore scores: not the ones on a page that 404'd
    // this run, whose findings it stales instead (repo#2657).
    const removed = new Set(input.pages!.filter((p) => p.statusCode === 404).map((p) => p.url));
    expect(removed.size).toBeGreaterThan(0);
    const full = new Map<string, RuleRunResult>(
      Object.entries(input.ruleResults).map(([id, r]) => [
        id,
        {
          ...r,
          checks: r.checks.filter((c) => !(c.pageUrl && removed.has(c.pageUrl))),
        } as unknown as RuleRunResult,
      ]),
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

describe("capReportForPublish: rule page counts (repo#2935)", () => {
  /** A rule with one class per entry of `classes`, each failing on its own pages. */
  function rule(classes: Array<{ name: string; pages: number[] }>): Report {
    const checks: CheckResult[] = classes.flatMap(({ name, pages }) =>
      pages.map((i) => ({ name, status: "fail" as const, message: `${name} fails`, pageUrl: pageUrl(i) })),
    );
    return { ruleResults: { "perf/cache-headers": { meta: meta(PAGE_RULES[0]!, "page"), checks } } };
  }
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

  test("two disjoint classes count every page, where the samples can only show the larger", () => {
    const capped = capReportForPublish(
      rule([
        { name: "cache-control", pages: range(0, 46) },
        { name: "cache-headers-missing", pages: range(46, 50) },
      ]),
    );
    expect(capped.rulePageCounts).toEqual({ "perf/cache-headers": 50 });
    // What a reader of the rows alone gets: the largest class, 46.
    const largest = Math.max(
      ...capped.ruleResults["perf/cache-headers"]!.checks.map((c) =>
        Math.max((c.details?.pagesTruncated as number | undefined) ?? 0, c.pages?.length ?? 1),
      ),
    );
    expect(largest).toBe(46);
  });

  test("classes on the same pages need no count, and none is published", () => {
    const capped = capReportForPublish(
      rule([
        { name: "cache-control", pages: range(0, 40) },
        { name: "cache-headers-missing", pages: range(10, 20) },
      ]),
    );
    expect(capped.rulePageCounts).toBeUndefined();
  });

  test("replayed findings are left out of the count, as the tallies leave them out", () => {
    const input = rule([
      { name: "cache-control", pages: range(0, 46) },
      { name: "cache-headers-missing", pages: range(46, 50) },
    ]);
    // The 4-page class was carried over from an earlier audit.
    for (const c of input.ruleResults["perf/cache-headers"]!.checks) {
      if (c.name === "cache-headers-missing") c.provenance = "carried";
    }
    expect(capReportForPublish(input).rulePageCounts).toBeUndefined();
  });

  test("a rule with an input aggregate that was already sampled publishes no count", () => {
    const input = rule([{ name: "cache-headers-missing", pages: range(600, 604) }]);
    input.ruleResults["perf/cache-headers"]!.checks.push({
      name: "cache-control",
      status: "fail",
      message: "cache-control fails",
      pages: range(0, 100).map(pageUrl),
      details: { aggregated: true, occurrences: 600, pagesTruncated: 600 },
    });
    expect(capReportForPublish(input).rulePageCounts).toBeUndefined();
  });

  test("a count on the input is never trusted", () => {
    const input = {
      ...rule([{ name: "cache-control", pages: range(0, 30) }]),
      rulePageCounts: { "perf/cache-headers": 9_999, "made/up": 1 },
    };
    expect(capReportForPublish(input).rulePageCounts).toBeUndefined();
  });

  test("on a real-shaped report, each count is the union of its rule's failing pages", () => {
    const input = report(300);
    const capped = capReportForPublish(input);
    const removed = new Set(input.pages!.filter((p) => p.statusCode === 404).map((p) => p.url));
    for (const [ruleId, count] of Object.entries(capped.rulePageCounts ?? {})) {
      const pages = new Set<string>();
      for (const c of input.ruleResults[ruleId]!.checks) {
        const replayed = c.provenance === "carried" || c.provenance === "unrendered";
        if ((c.status === "fail" || c.status === "warn") && c.pageUrl && !removed.has(c.pageUrl) && !replayed) {
          pages.add(c.pageUrl);
        }
      }
      expect({ ruleId, count }).toEqual({ ruleId, count: pages.size });
    }
    expect(Object.keys(capped.rulePageCounts ?? {}).length).toBeGreaterThan(0);
  });
});

describe("capReportForPublish: link target sets (repo#2861)", () => {
  const linkMeta = (id: string) => ({
    id,
    name: id,
    category: "links",
    scope: "site" as const,
    severity: "error" as const,
    weight: 5,
  });
  const targets = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
  const row = (name: string, status: CheckResult["status"], ids: string[], extra: Partial<CheckResult> = {}) => ({
    name,
    status,
    message: `${ids.length} ${name}`,
    items: ids.map((id) => ({ id, sourcePages: [`${SITE}/`] })),
    ...extra,
  });
  const has = (set: unknown, url: string) => decodeLinkTargetSet(set)?.has(linkTargetHash(url)) ?? false;

  test("every target a link rule lists, though its rows publish a sample", () => {
    const broken = targets(40, `${SITE}/gone-`);
    const refused = targets(3, `${SITE}/walled-`);
    const input: Report = {
      ruleResults: {
        "links/broken-links": {
          meta: linkMeta("links/broken-links"),
          checks: [row("broken-links", "fail", broken), row("refused-links", "info", refused)],
        },
      },
    };
    const capped = capReportForPublish(input);
    const items = capped.ruleResults["links/broken-links"]!.checks.find((c) => c.name === "broken-links")!.items!;
    expect(items.length).toBeLessThan(40);
    const sets = capped.linkTargetSets!["links/broken-links"]!;
    expect(sets.broken).toMatchObject({ count: 40, complete: true });
    expect(sets.unverified).toMatchObject({ count: 3, complete: true });
    for (const url of broken) expect(has(sets.broken, url)).toBe(true);
    for (const url of refused) expect(has(sets.unverified, url)).toBe(true);
    // Query-blind: a trailing slash, the host's case, a query and a fragment do not matter.
    expect(has(sets.broken, `${SITE.toUpperCase()}/gone-000/?utm_source=x#top`)).toBe(true);
    expect(has(sets.broken, `${SITE}/fine`)).toBe(false);
  });

  test("a rule that passed carries empty sets; one that did not run carries none", () => {
    const input: Report = {
      ruleResults: {
        "links/broken-links": {
          meta: linkMeta("links/broken-links"),
          checks: [{ name: "broken-links", status: "pass", message: "none broken" }],
        },
        "links/broken-external-links": {
          meta: linkMeta("links/broken-external-links"),
          checks: [{ name: "broken-external-links", status: "skipped", message: "checks off" }],
        },
      },
    };
    const capped = capReportForPublish(input);
    expect(capped.linkTargetSets).toEqual({
      "links/broken-links": {
        broken: { hashes: "", count: 0, complete: true },
        unverified: { hashes: "", count: 0, complete: true },
      },
    });
  });

  test("a row the rule itself sampled, and a set over its cap, say they are not complete", () => {
    const input: Report = {
      ruleResults: {
        "links/broken-external-links": {
          meta: linkMeta("links/broken-external-links"),
          checks: [
            row("broken-external-links", "warn", targets(2, "https://vendor.test/dead-")),
            row("not-requested-external-links", "info", targets(5, "https://vendor.test/logout-"), {
              value: 12,
              details: { notRequested: 12, listed: 5 },
            }),
          ],
        },
        "links/broken-links": {
          meta: linkMeta("links/broken-links"),
          checks: [row("broken-links", "fail", targets(2100, `${SITE}/gone-`))],
        },
      },
    };
    const capped = capReportForPublish(input);
    const external = capped.linkTargetSets!["links/broken-external-links"]!;
    expect(external.broken).toMatchObject({ count: 2, complete: true });
    expect(external.unverified).toMatchObject({ count: 5, complete: false });
    const internal = capped.linkTargetSets!["links/broken-links"]!.broken;
    expect(internal).toMatchObject({ count: 2100, complete: false });
    expect(decodeLinkTargetSet(internal)?.size).toBe(2000);
  });

  test("an input row that was already sampled (`additional`) is not complete, whatever page it sits on", () => {
    const input: Report = {
      pages: [{ url: `${SITE}/a`, statusCode: 404 }],
      ruleResults: {
        "links/broken-links": {
          meta: linkMeta("links/broken-links"),
          checks: [
            row("broken-links", "fail", targets(2, `${SITE}/gone-`), {
              pageUrl: `${SITE}/a`,
              details: { additional: 5 },
            }),
          ],
        },
      },
    };
    expect(capReportForPublish(input).linkTargetSets!["links/broken-links"]!.broken.complete).toBe(
      false,
    );
  });

  test("a rule whose only rows are replayed did not run; a fresh one keeps its replayed rows' targets", () => {
    const carried = row("broken-links", "fail", [`${SITE}/old-gone`], {
      pageUrl: `${SITE}/b`,
      provenance: "carried",
    });
    const only: Report = {
      ruleResults: {
        "links/broken-links": { meta: linkMeta("links/broken-links"), checks: [carried] },
      },
    };
    expect(capReportForPublish(only).linkTargetSets).toBeUndefined();
    const mixed: Report = {
      ruleResults: {
        "links/broken-links": {
          meta: linkMeta("links/broken-links"),
          checks: [row("broken-links", "fail", [`${SITE}/new-gone`], { pageUrl: `${SITE}/c` }), carried],
        },
      },
    };
    const set = capReportForPublish(mixed).linkTargetSets!["links/broken-links"]!.broken;
    expect(set.count).toBe(2);
    expect(has(set, `${SITE}/old-gone`)).toBe(true);
  });

  test("four full sets are priced in the body: a full report still fits its ceiling", () => {
    // A row lists at most REPORT_LIMITS.maxItemsPerCheck items (one more reads
    // as capped), so a set fed by one row holds up to 999 targets; two rows of
    // a rule fill it towards LINK_TARGET_SET_MAX_HASHES.
    const full = (prefix: string) => [targets(999, `${prefix}a-`), targets(999, `${prefix}b-`)];
    const [goneA, goneB] = full(`${SITE}/gone-`);
    const [walledA, walledB] = full(`${SITE}/walled-`);
    const [deadA, deadB] = full("https://vendor.test/dead-");
    const [wafA, wafB] = full("https://vendor.test/walled-");
    const input = report(300);
    input.ruleResults["links/broken-links"] = {
      meta: linkMeta("links/broken-links"),
      checks: [
        row("broken-links", "fail", goneA!, { pageUrl: `${SITE}/x` }),
        row("broken-links", "fail", goneB!, { pageUrl: `${SITE}/y` }),
        row("refused-links", "info", walledA!),
        row("rate-limited-links", "info", walledB!),
      ],
    };
    input.ruleResults["links/broken-external-links"] = {
      meta: linkMeta("links/broken-external-links"),
      checks: [
        row("broken-external-links", "warn", deadA!, { pageUrl: `${SITE}/x` }),
        row("broken-external-links", "warn", deadB!, { pageUrl: `${SITE}/y` }),
        row("waf-blocked-external-links", "info", wafA!),
        row("rate-limited-external-links", "info", wafB!),
      ],
    };
    const capped = capReportForPublish(input);
    expect(bytesOf(capped)).toBeLessThanOrEqual(PUBLISHED_REPORT_MAX_BYTES - REPORT_CAPS.envelopeBytes);
    for (const sets of Object.values(capped.linkTargetSets!)) {
      expect(sets.broken).toMatchObject({ count: 1998, complete: true });
      expect(sets.unverified).toMatchObject({ count: 1998, complete: true });
    }
    // The sets are part of what the fill measures, not added on top of it.
    expect(bytesOf(capped.linkTargetSets)).toBeGreaterThan(80_000);
  }, SLOW);

  test("kept whole when the fill reduces the report, and never taken from the input", () => {
    const rules: RuleSpec[] = Array.from({ length: 60 }, (_, r) => ({
      id: `content/many-${String(r).padStart(2, "0")}`,
      category: "content",
      severity: "warning" as const,
      weight: 3,
      names: Array.from({ length: 25 }, (_, n) => `check-${n}`),
    }));
    const input = report(4, { rules, everyClassFails: 1, maxStrings: true });
    input.ruleResults["links/broken-links"] = {
      meta: linkMeta("links/broken-links"),
      checks: [row("broken-links", "fail", targets(300, `${SITE}/gone-`))],
    };
    (input as Record<string, unknown>).linkTargetSets = { "made/up": { broken: { hashes: "x", count: 1, complete: true } } };
    const capped = capReportForPublish(input, { maxBytes: 256 * 1024 });
    expect(capped.detail.tier).toBeGreaterThan(0);
    expect(Object.keys(capped.linkTargetSets ?? {})).toEqual(["links/broken-links"]);
    expect(capped.linkTargetSets!["links/broken-links"]!.broken).toMatchObject({ count: 300, complete: true });
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
