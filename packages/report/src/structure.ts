// Page structure (#2307): where the audited pages' links sit, and what type the page classifier
// says each page is.
//
// Report-only and non-scoring, like the Technologies block. Three jobs live here so the numbers
// and the sentences about them cannot drift apart:
//   1. `extractPageStructure` distills one parsed page into a few counters. The audit calls it
//      while the page's parse is live, and the result is stored with the page's other report
//      scalars, so building a report never re-reads a page.
//   2. `createStructureBuilder` folds those per-page counters into the report-level block.
//   3. The `structure*` helpers turn the block into the lines every output format prints.
//
// Nothing here imports the renderers or React: the audit engine pulls this file in through the
// `@squirrelscan/report/structure` subpath.

import type {
  LinkData,
  LinkSection,
  PageClassification,
  PageStructureScalars,
  ReportStructure,
  ReportStructurePageType,
  ReportStructureSection,
} from "@squirrelscan/core-contracts";

type PlacedSection = Exclude<LinkSection, "unknown">;

/** Every section the block reports on, in a fixed order that breaks ties between equal counts. */
const SECTIONS: readonly PlacedSection[] = [
  "header",
  "footer",
  "navigation",
  "sidebar",
  "comments",
  "content",
  "pagination",
  "breadcrumbs",
  "related_content",
  "business_info",
  "social_share",
  "account_login",
  "author_byline",
  "newsletter_signup",
];

const SECTION_SET: ReadonlySet<string> = new Set(SECTIONS);

/** Sitewide chrome: the sections `chrome.share` weighs against the page content. */
export const CHROME_SECTIONS: readonly PlacedSection[] = [
  "header",
  "footer",
  "navigation",
  "sidebar",
];

const CHROME_SET: ReadonlySet<string> = new Set(CHROME_SECTIONS);

/** A markup-rules page type answer counts only from this confidence up; a model answer always does. */
export const MIN_RULES_CONFIDENCE = 0.8;

const LABEL_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** What `extractPageStructure` reads off a parsed page. */
export interface StructureSource {
  links?: ReadonlyArray<Pick<LinkData, "isInternal" | "section">>;
  classification?: PageClassification;
}

/**
 * One page's contribution, or undefined when the page carries neither a link section nor a
 * classification, so an old parse adds nothing rather than a row of zeros.
 */
export function extractPageStructure(page: StructureSource): PageStructureScalars | undefined {
  const sections: Partial<Record<LinkSection, number>> = {};
  let chromeInternal = 0;
  let contentInternal = 0;
  let placed = false;
  for (const link of page.links ?? []) {
    const section = link.section;
    if (!section) continue;
    placed = true;
    sections[section] = (sections[section] ?? 0) + 1;
    if (!link.isInternal) continue;
    if (CHROME_SET.has(section)) chromeInternal++;
    else if (section === "content") contentInternal++;
  }
  const classification = page.classification;
  if (!placed && !classification) return undefined;
  const answer = classification?.pageType;
  return {
    sections,
    chromeInternal,
    contentInternal,
    pageType: answer
      ? { label: answer.label, confidence: answer.confidence, source: answer.source }
      : null,
    degraded: Boolean(classification?.degraded),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A page type label the report may print: lowercase words, no markup, and not the no-answer label. */
function standingLabel(scalars: PageStructureScalars): string | null {
  const answer = scalars.pageType;
  if (!answer || typeof answer.label !== "string") return null;
  if (answer.label === "unknown" || !LABEL_PATTERN.test(answer.label)) return null;
  if (answer.source === "model") return answer.label;
  if (answer.source === "rules" && answer.confidence >= MIN_RULES_CONFIDENCE) return answer.label;
  return null;
}

export interface StructureBuilder {
  /** Fold one audited page in. Pages with no structure data are ignored. */
  add: (scalars: PageStructureScalars | null | undefined) => void;
  /** The block, or undefined when no page carried any data. The builder is not reusable after. */
  build: () => ReportStructure | undefined;
}

export function createStructureBuilder(): StructureBuilder {
  let pages = 0;
  const sectionPages = new Map<PlacedSection, number>();
  const sectionLinks = new Map<PlacedSection, number>();
  let unknownLinks = 0;
  let chromeLinks = 0;
  let contentLinks = 0;
  const labelPages = new Map<string, number>();
  let notClassified = 0;
  let byModel = 0;
  let degraded = 0;

  return {
    add(scalars) {
      if (!scalars) return;
      pages++;
      for (const [key, raw] of Object.entries(scalars.sections ?? {})) {
        const links = count(raw);
        if (links === 0) continue;
        if (key === "unknown") {
          unknownLinks += links;
        } else if (SECTION_SET.has(key)) {
          const section = key as PlacedSection;
          sectionPages.set(section, (sectionPages.get(section) ?? 0) + 1);
          sectionLinks.set(section, (sectionLinks.get(section) ?? 0) + links);
        }
      }
      chromeLinks += count(scalars.chromeInternal);
      contentLinks += count(scalars.contentInternal);
      const label = standingLabel(scalars);
      if (label) {
        labelPages.set(label, (labelPages.get(label) ?? 0) + 1);
        if (scalars.pageType?.source === "model") byModel++;
      } else {
        notClassified++;
      }
      if (scalars.degraded) degraded++;
    },

    build() {
      if (pages === 0) return undefined;
      const sections: ReportStructureSection[] = SECTIONS.filter((s) => sectionLinks.has(s))
        .map((section) => ({
          section,
          pages: sectionPages.get(section) ?? 0,
          links: sectionLinks.get(section) ?? 0,
        }))
        .sort((a, b) => b.links - a.links || SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));
      let totalLinks = unknownLinks;
      for (const row of sections) totalLinks += row.links;
      const counts: ReportStructurePageType[] = [...labelPages]
        .map(([label, n]) => ({ label, pages: n }))
        .sort((a, b) => b.pages - a.pages || (a.label < b.label ? -1 : 1));
      const placedInternal = chromeLinks + contentLinks;
      return {
        pages,
        sections,
        unknownLinks,
        totalLinks,
        chrome: {
          links: chromeLinks,
          contentLinks,
          share: placedInternal > 0 ? Math.round((chromeLinks / placedInternal) * 1000) / 1000 : null,
        },
        pageTypes: { counts, notClassified, byModel, degraded },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Wording, shared by every output format.
// ---------------------------------------------------------------------------------------------

const SECTION_NAME: Record<PlacedSection, string> = {
  header: "Header",
  footer: "Footer",
  navigation: "Navigation",
  sidebar: "Sidebar",
  comments: "Comments",
  content: "Content",
  pagination: "Pagination",
  breadcrumbs: "Breadcrumbs",
  related_content: "Related content",
  business_info: "Business details",
  social_share: "Social sharing",
  account_login: "Account and login",
  author_byline: "Author byline",
  newsletter_signup: "Newsletter signup",
};

/** The display name of a section, e.g. "Related content"; undefined for a name this version does not know. */
export function structureSectionName(section: string): string | undefined {
  return SECTION_SET.has(section) ? SECTION_NAME[section as PlacedSection] : undefined;
}

const PAGE_TYPE_NOUN: Record<string, [singular: string, plural: string]> = {
  homepage: ["homepage", "homepages"],
  product_detail: ["product page", "product pages"],
  product_listing: ["product listing", "product listings"],
  article: ["article", "articles"],
  blog_post: ["blog post", "blog posts"],
  about: ["about page", "about pages"],
  contact: ["contact page", "contact pages"],
  docs: ["documentation page", "documentation pages"],
  legal: ["legal page", "legal pages"],
  pricing: ["pricing page", "pricing pages"],
  listing_index: ["listing page", "listing pages"],
  other: ["other page", "other pages"],
};

/**
 * A number for an XML attribute: the value when it is a finite number, else 0. A report loaded
 * from a hand-edited file may carry anything in a count, and an attribute must not carry markup.
 */
export function structureAttr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** "1,204", with a fixed grouping so the output does not depend on the machine's locale. */
export function structureNumber(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * "20 product pages", "1 blog post". A label this version has no wording for reads as its own
 * words, so a newer classifier's label still prints. A label that is not plain lowercase words
 * (a report file someone edited) returns undefined rather than reaching an output.
 */
export function pageTypePhrase(label: unknown, pages: number): string | undefined {
  if (typeof label !== "string" || !LABEL_PATTERN.test(label)) return undefined;
  const words = label.replace(/_/g, " ");
  // An own-property lookup: "constructor" is a plain label to this pattern, not a table entry.
  const noun = Object.hasOwn(PAGE_TYPE_NOUN, label)
    ? PAGE_TYPE_NOUN[label]!
    : [`${words} page`, `${words} pages`];
  return `${structureNumber(pages)} ${pages === 1 ? noun[0] : noun[1]}`;
}

/**
 * "Page types: 20 product pages, 6 blog posts; 30 not classified." Null when the classifier
 * labelled no page, because "30 not classified" alone says nothing a reader can act on.
 */
export function structurePageTypesLine(structure: ReportStructure): string | null {
  const { counts, notClassified } = structure.pageTypes;
  if (counts.length === 0) return null;
  const phrases = counts.flatMap((c) => pageTypePhrase(c.label, c.pages) ?? []);
  if (phrases.length === 0) return null;
  const labelled = phrases.join(", ");
  return `Page types: ${labelled}${notClassified > 0 ? `; ${structureNumber(notClassified)} not classified` : ""}.`;
}

/** "88% of internal links sit in the header, footer, navigation and sidebar; 12% in the page content." */
export function structureChromeLine(structure: ReportStructure): string | null {
  const share = structure.chrome.share;
  if (share === null) return null;
  const chromePercent = Math.round(share * 100);
  return `${chromePercent}% of internal links sit in the header, footer, navigation and sidebar; ${100 - chromePercent}% in the page content.`;
}

/** Table rows: section, pages, links, most links first. Sections with no links are not rows. */
export function structureRows(
  structure: ReportStructure,
): Array<{ section: string; pages: number; links: number }> {
  return structure.sections.flatMap((s) => {
    const section = structureSectionName(s.section);
    return section ? [{ section, pages: s.pages, links: s.links }] : [];
  });
}

/** "3,784 links on 88 pages", "1 link on 1 page": one row of the table as a phrase. */
export function structureRowDetail(row: { pages: number; links: number }): string {
  const links = `${structureNumber(row.links)} ${row.links === 1 ? "link" : "links"}`;
  const pages = `${structureNumber(row.pages)} ${row.pages === 1 ? "page" : "pages"}`;
  return `${links} on ${pages}`;
}

/** "1,204 links counted; 96 could not be placed in a section." Null when there are no links. */
export function structureTotalsLine(structure: ReportStructure): string | null {
  if (structure.totalLinks === 0) return null;
  const unknown =
    structure.unknownLinks > 0
      ? `; ${structureNumber(structure.unknownLinks)} could not be placed in a section`
      : "";
  return `${structureNumber(structure.totalLinks)} links counted${unknown}.`;
}

/** "3 pages fell back to the markup rules for part of their classification." Null when none did. */
export function structureDegradedLine(structure: ReportStructure): string | null {
  const n = structure.pageTypes.degraded;
  if (n === 0) return null;
  return `${structureNumber(n)} ${n === 1 ? "page" : "pages"} fell back to the markup rules for part of the classification.`;
}
