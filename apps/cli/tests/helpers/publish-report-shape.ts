// Synthetic audit reports for the publish-body tests (repo#2667), shaped like a
// real catalog run: several check names per page rule, a mix of statuses per
// page, items on the failing ones, site checks, the display sections, and the
// crawled `pages[]` the capper builds the scoring transport from.

import type { AuditReport, CheckResult } from "@/types";

type Severity = "error" | "warning" | "info";
interface RuleSpec {
  id: string;
  category: string;
  severity: Severity;
  names: string[];
}

const SITE = "https://shop.example.test";

const PAGE_RULES: RuleSpec[] = [
  {
    id: "core/doctype",
    category: "core",
    severity: "warning",
    names: ["doctype"],
  },
  {
    id: "core/meta-title",
    category: "core",
    severity: "error",
    names: ["title-length", "title-present"],
  },
  {
    id: "a11y/link-text",
    category: "a11y",
    severity: "warning",
    names: ["link-text"],
  },
  {
    id: "a11y/button-name",
    category: "a11y",
    severity: "error",
    names: ["button-name"],
  },
  {
    id: "images/dimensions",
    category: "images",
    severity: "warning",
    names: ["img-dimensions", "img-lazy"],
  },
  {
    id: "images/alt-text",
    category: "images",
    severity: "error",
    names: ["alt-text"],
  },
  {
    id: "perf/render-blocking",
    category: "perf",
    severity: "warning",
    names: ["render-blocking-css", "render-blocking-js"],
  },
  {
    id: "content/word-count",
    category: "content",
    severity: "warning",
    names: ["word-count", "thin-content"],
  },
  {
    id: "schema/faq",
    category: "schema",
    severity: "info",
    names: ["faq-valid"],
  },
  {
    id: "links/internal-links",
    category: "links",
    severity: "warning",
    names: ["internal-links"],
  },
];

const CATEGORIES = [
  "core",
  "a11y",
  "images",
  "perf",
  "security",
  "content",
  "schema",
  "links",
];
/** As many page check classes as the real catalog has, for the worst case. */
const WIDE_RULES: RuleSpec[] = Array.from({ length: 230 }, (_, r) => ({
  id: `${CATEGORIES[r % CATEGORIES.length]}/wide-${String(r).padStart(3, "0")}`,
  category: CATEGORIES[r % CATEGORIES.length]!,
  severity: "warning" as const,
  names: ["first-check", "second-check"],
}));

/** Deterministic pseudo-random in [0, 1) from a string. */
function unit(key: string): number {
  return Number(BigInt(Bun.hash(key)) % 1_000_003n) / 1_000_003;
}

function statusFor(key: string): CheckResult["status"] {
  const r = unit(key);
  if (r < 0.55) return "pass";
  if (r < 0.72) return "warn";
  if (r < 0.84) return "fail";
  if (r < 0.94) return "info";
  return "skipped";
}

export interface ReportShape {
  /** Every page check class of 230 rules fails on every page, with this many items. */
  everyClassFails?: number;
  /** Write every site-controlled string in this character (multi-byte in UTF-8). */
  char?: string;
}

export const pageUrl = (i: number): string =>
  `${SITE}/products/item-${String(i).padStart(5, "0")}`;

/** A finished CLI report of `pages` pages, before it is published. */
export function publishReportShape(
  pages: number,
  shape: ReportShape = {}
): AuditReport {
  const text = (s: string): string =>
    shape.char ? shape.char.repeat(s.length) : s;
  const url = (i: number): string =>
    shape.char ? `${pageUrl(i)}/${text("slug-text")}` : pageUrl(i);
  const ruleResults: Record<string, { meta: unknown; checks: CheckResult[] }> =
    {};
  const specs = shape.everyClassFails ? WIDE_RULES : PAGE_RULES;
  for (const spec of specs) {
    const checks: CheckResult[] = [];
    for (let p = 0; p < pages; p++) {
      for (const name of spec.names) {
        const key = `${spec.id}|${name}|${p}`;
        const status = shape.everyClassFails ? "fail" : statusFor(key);
        const itemCount =
          shape.everyClassFails ??
          (status === "warn" || status === "fail"
            ? Math.floor(unit(`${key}#n`) * 12)
            : 0);
        const items = Array.from({ length: itemCount }, (_, k) => ({
          id:
            k % 4 === 0
              ? `${SITE}/assets/shared-${name}-${k}.css`
              : `${url(p)}#${name}-${k}`,
          label: text(
            `An element the rule quotes back, number ${k}, on this page`
          ),
        }));
        checks.push({
          name,
          status,
          message: text(`${name} ${status} on this page`),
          pageUrl: url(p),
          ...(items.length > 0 ? { items } : {}),
          ...(status === "skipped" ? { skipReason: "no data" } : {}),
        } as CheckResult);
      }
    }
    ruleResults[spec.id] = {
      meta: {
        id: spec.id,
        name: spec.id.split("/")[1]!.replace(/-/g, " "),
        description: `Checks ${spec.id} on every page.`,
        category: spec.category,
        scope: "page",
        severity: spec.severity,
        weight: 4,
      },
      checks,
    };
  }
  const siteChecks: CheckResult[] = [
    {
      name: "broken-links",
      status: "fail",
      message: text("Broken links found"),
      items: Array.from({ length: 40 }, (_, k) => ({
        id: `${SITE}/gone-${k}`,
        sourcePages: Array.from({ length: 5 }, (_, s) =>
          url((k * 5 + s) % Math.max(pages, 1))
        ),
      })),
    } as CheckResult,
    {
      name: "sitemap-exists",
      status: "pass",
      message: "Sitemap found",
    } as CheckResult,
  ];
  ruleResults["links/broken-links"] = {
    meta: {
      id: "links/broken-links",
      name: "broken links",
      description: "Checks for links that return an error.",
      category: "links",
      scope: "site",
      severity: "error",
      weight: 9,
    },
    checks: [siteChecks[0]!],
  };
  return {
    crawlId: "crawl-shape",
    baseUrl: `${SITE}/`,
    timestamp: "2026-10-12T00:00:00.000Z",
    totalPages: pages,
    passed: 0,
    warnings: 0,
    failed: 0,
    pages: Array.from({ length: pages }, (_, i) => ({
      url: url(i),
      statusCode: i % 41 === 7 ? 404 : 200,
      meta: { title: text(`Page ${i}`), description: text(`About page ${i}`) },
    })),
    siteChecks,
    summary: {
      missingTitles: [],
      missingDescriptions: Array.from({ length: Math.min(pages, 30) }, (_, i) =>
        url(i)
      ),
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
    sitemapUrlStatuses: Array.from(
      { length: Math.min(pages, 150) },
      (_, i) => ({
        url: url(i),
        status: 200,
        error: null,
      })
    ),
    rulesCache: { pagesReplayed: 0, pagesEvaluated: pages },
    ruleResults,
  } as unknown as AuditReport;
}
