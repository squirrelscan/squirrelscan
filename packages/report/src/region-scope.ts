// Findings in a shared page region name the region (pub#846): the same "Sign in" link in the
// header of a 53-page site reads "In the site header, on 49 of 53 pages" instead of a 49-row page
// list. Decided at report time from data the audit already stored: the item's pages per section
// (`regions`, or a check's `details.region`) against the pages that have that region
// (`structure.sections`). Nothing here changes a finding, its severity or the score.

import {
  linkSectionPhrase,
  type CheckItem,
  type LinkSectionCounts,
  type ReportStructure,
} from "@squirrelscan/core-contracts";

import { isRedundantPageItem } from "./affected-pages";
import { checkPageTypeScope, pageTypeScopeLine, type PageTypeScopeCheck } from "./page-type-scope";
import { structureNumber } from "./structure";

/**
 * An item is shown as one finding in a region when it sits there on at least this share of the
 * pages that HAVE the region. The denominator is those pages, not every page, so a footer missing
 * from a few pages does not hide a finding that is on every footer.
 */
export const REGION_SCOPE_MIN_SHARE = 0.8;

/** ...and on at least this many pages: a finding on one page reads better as that page. */
export const REGION_SCOPE_MIN_PAGES = 2;

/**
 * The template regions a site repeats across pages: the page frame, and the blocks that recur the
 * same on every page that has them (breadcrumbs, pagination and the widget sections the page
 * classifier names). Never one: the page content, comments, related content and the author
 * byline, which differ from page to page.
 */
export const TEMPLATE_REGIONS = [
  "header",
  "footer",
  "navigation",
  "sidebar",
  "breadcrumbs",
  "pagination",
  "newsletter_signup",
  "social_share",
  "business_info",
  "account_login",
] as const;
export type TemplateRegion = (typeof TEMPLATE_REGIONS)[number];

const REGION_NAME: Record<TemplateRegion, string> = {
  header: "the site header",
  footer: "the site footer",
  navigation: "the site navigation",
  sidebar: "the sidebar",
  breadcrumbs: "the breadcrumbs",
  pagination: "the pagination",
  newsletter_signup: "the newsletter signup",
  social_share: "the social share links",
  business_info: "the business details",
  account_login: "the account links",
};

export function isTemplateRegion(value: unknown): value is TemplateRegion {
  return typeof value === "string" && (TEMPLATE_REGIONS as readonly string[]).includes(value);
}

export interface RegionScope {
  region: TemplateRegion;
  /** Pages the item sits on in the region. */
  pages: number;
  /** Audited pages that have the region: the denominator. */
  regionPages: number;
  /** Pages the item is on outside the region; 0 when the region is the only place it is. */
  otherPages: number;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Audited pages with at least one link in the region; 0 when the report has no structure. */
function regionPagesOf(structure: ReportStructure | undefined, region: TemplateRegion): number {
  if (!structure || !Array.isArray(structure.sections)) return 0;
  return count(structure.sections.find((s) => s?.section === region)?.pages);
}

function scopeOf(
  region: TemplateRegion,
  pages: number,
  totalPages: number,
  structure: ReportStructure | undefined,
): RegionScope | undefined {
  const havingRegion = regionPagesOf(structure, region);
  if (pages < REGION_SCOPE_MIN_PAGES || havingRegion === 0) return undefined;
  // A page can carry the item in the region without a link there (a copyright line in a footer
  // with no links): never print "on 50 of 48 pages".
  const regionPages = Math.max(havingRegion, pages);
  if (pages / regionPages < REGION_SCOPE_MIN_SHARE) return undefined;
  return { region, pages, regionPages, otherPages: Math.max(0, totalPages - pages) };
}

/** Pages an item is on: its listed pages, or the count a capped list keeps beside them. */
function itemTotalPages(item: CheckItem): number {
  return Math.max(count(item.pageCount), new Set(item.sourcePages ?? []).size);
}

/**
 * The region an item is scoped to, or undefined to keep its page list. Of the template regions it
 * sits in on enough of the pages that have them, the one with the most pages; the same item in
 * another part of the page stays on its own pages. Undefined without `regions` or structure, as on
 * an older stored crawl or with the classifier off.
 */
export function itemRegionScope(
  item: CheckItem,
  structure: ReportStructure | undefined,
): RegionScope | undefined {
  const regions = item.regions;
  if (!regions || typeof regions !== "object" || !structure) return undefined;
  let best: RegionScope | undefined;
  for (const region of TEMPLATE_REGIONS) {
    const pages = count(Object.hasOwn(regions, region) ? regions[region] : 0);
    if (pages === 0) continue;
    const scope = scopeOf(region, pages, Math.max(itemTotalPages(item), pages), structure);
    if (scope && (!best || scope.pages > best.pages)) best = scope;
  }
  return best;
}

/**
 * The region a whole check is scoped to: a check that only ever looks in one region names it in
 * `details.region` (content/stale-copyright reads the footer), and `pages` is how many pages it
 * fired on. Undefined when it names none or fires on too few of the pages with that region.
 */
export function checkRegionScope(
  check: { details?: Record<string, unknown> },
  pages: number,
  structure: ReportStructure | undefined,
): RegionScope | undefined {
  const region = check.details?.region;
  if (!isTemplateRegion(region)) return undefined;
  return scopeOf(region, count(pages), count(pages), structure);
}

/**
 * True when a check's page list gives way to its findings' regions: the check is scoped to a
 * region or a page type (pub#857), or an item it shows is scoped to a region, and every item
 * carries its own pages (its rows, or its region line and the pages it is on outside it). The
 * compact formats then leave the check's list out, and HTML keeps it collapsed. A check with an
 * item that IS a page keeps the list, which is where that page is shown.
 */
export function checkPagesScopedAway(
  check: PageTypeScopeCheck & { items?: CheckItem[] },
  pages: number,
  structure: ReportStructure | undefined,
): boolean {
  if (checkRegionScope(check, pages, structure)) return true;
  if (checkPageTypeScope(check, pages, structure)) return true;
  const items = check.items ?? [];
  if (items.length === 0 || items.some(isRedundantPageItem)) return false;
  return items.some((item) => itemRegionScope(item, structure) !== undefined);
}

/**
 * The one line that stands in for a whole check's page list, or undefined to keep the list: the
 * shared region it sits in (pub#846), else the page type every one of its pages is (pub#857).
 */
export function checkScopeLine(
  check: PageTypeScopeCheck,
  pages: number,
  structure: ReportStructure | undefined,
): string | undefined {
  const region = checkRegionScope(check, pages, structure);
  if (region) return regionScopeLine(region);
  const type = checkPageTypeScope(check, pages, structure);
  return type ? pageTypeScopeLine(type) : undefined;
}

/** "In the site footer, on 49 of 53 pages", and ", and on 3 other pages" when it is elsewhere too. */
export function regionScopeLine(scope: RegionScope): string {
  const other =
    scope.otherPages > 0
      ? `, and on ${structureNumber(scope.otherPages)} other ${scope.otherPages === 1 ? "page" : "pages"}`
      : "";
  return `In ${REGION_NAME[scope.region]}, on ${structureNumber(scope.pages)} of ${structureNumber(scope.regionPages)} ${scope.regionPages === 1 ? "page" : "pages"}${other}`;
}

/**
 * The label a format prints for an item, or undefined when it has none of its own. An item shown
 * in a region drops the ", linked in the footer" phrase its rule added from `meta.sections`: the
 * region line says where it is. Any other label, and every unscoped item's, is as the rule wrote it.
 */
export function itemLabel(item: CheckItem, scope: RegionScope | undefined): string | undefined {
  const label = item.label;
  if (!label || !scope) return label;
  const sections = item.meta?.sections;
  if (!sections || typeof sections !== "object") return label;
  const phrase = linkSectionPhrase(sections as LinkSectionCounts);
  const suffix = phrase ? `, linked ${phrase}` : "";
  if (!suffix || !label.endsWith(suffix)) return label;
  const bare = label.slice(0, -suffix.length);
  return bare && bare !== item.id ? bare : undefined;
}

/** The scope as data for JSON and XML: `{ region, pages, regionPages, otherPages }`. */
export function regionScopeData(scope: RegionScope): RegionScope {
  return {
    region: scope.region,
    pages: scope.pages,
    regionPages: scope.regionPages,
    otherPages: scope.otherPages,
  };
}
