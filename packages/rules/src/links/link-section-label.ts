// Where on its source pages a link sat, for finding labels (#2307) and per-source rows (pub#837).

import {
  LINK_SECTION_PHRASE as PHRASE,
  linkSectionPhrase,
  pageRegions,
  type CheckItemSource,
  type LinkSection,
  type LinkSectionCounts,
} from "@squirrelscan/core-contracts";

export type SectionCounts = LinkSectionCounts;

/** Add one link's section to the counts; unknown and missing add nothing. */
export function countSection(counts: SectionCounts, section: LinkSection | undefined): void {
  if (!section || section === "unknown") return;
  counts[section] = (counts[section] ?? 0) + 1;
}

/** Per source page of one target, in the order the pages were met: its links there and their sections. */
export type SourceTally = Map<string, { links: number; sections: SectionCounts }>;

/** Count `links` links (one by default) from `page`; unknown and missing sections add links and no section. */
export function tallySource(
  tally: SourceTally,
  page: string,
  section: LinkSection | undefined,
  links = 1
): void {
  let entry = tally.get(page);
  if (!entry) tally.set(page, (entry = { links: 0, sections: {} }));
  entry.links += links;
  if (section && section !== "unknown") entry.sections[section] = (entry.sections[section] ?? 0) + links;
}

/**
 * An item's `sourcePages` (each page once), `sources` (its links and sections there), the sections
 * of all of them together (links per section), and `regions` (pages per section, pub#846), from a
 * target's tally.
 */
export function tallyFields(tally: SourceTally): {
  sourcePages: string[];
  sources: CheckItemSource[];
  sections: SectionCounts;
  regions: SectionCounts;
} {
  const sections: SectionCounts = {};
  const regions: SectionCounts = {};
  const sources: CheckItemSource[] = [];
  for (const [page, entry] of tally) {
    mergeSections(sections, entry.sections);
    for (const section of Object.keys(entry.sections) as (keyof SectionCounts)[]) {
      regions[section] = (regions[section] ?? 0) + 1;
    }
    sources.push({
      page,
      links: entry.links,
      ...(Object.keys(entry.sections).length > 0 ? { sections: entry.sections } : {}),
    });
  }
  return { sourcePages: [...tally.keys()], sources, sections, regions };
}

/** `{ regions }` for an item, or nothing when no page placed it in a section (pub#846). */
export function regionsField(regions: SectionCounts | undefined): { regions?: SectionCounts } {
  return regions && Object.keys(regions).length > 0 ? { regions } : {};
}

/**
 * `{ regions }` for a page-scope rule's item from where its elements sit on this page: one page
 * in each section (pub#846). Nothing when no element had a known section.
 */
export function pageRegionsField(
  sections: SectionCounts | Iterable<LinkSection | undefined> | undefined
): { regions?: SectionCounts } {
  if (!sections) return {};
  const keys =
    Symbol.iterator in sections
      ? (sections as Iterable<LinkSection | undefined>)
      : (Object.keys(sections) as LinkSection[]);
  return regionsField(pageRegions(keys));
}

/** "label, linked in the footer": the label with where its links sit; the label alone when no section is known. */
export function withSection(label: string, counts: SectionCounts | undefined): string {
  const phrase = counts ? linkSectionPhrase(counts) : "";
  return phrase ? `${label}, linked ${phrase}` : label;
}

/** `{ sections }` for an item's `meta`, or nothing when no section is known. */
export function sectionMeta(counts: SectionCounts | undefined): { sections?: SectionCounts } {
  return counts && Object.keys(counts).length > 0 ? { sections: counts } : {};
}

/** Add one link's section to the counts kept for `key`; unknown and missing add nothing. */
export function addSection(
  byKey: Map<string, SectionCounts>,
  key: string,
  section: LinkSection | undefined
): void {
  if (!section || section === "unknown") return;
  let counts = byKey.get(key);
  if (!counts) byKey.set(key, (counts = {}));
  countSection(counts, section);
}

/** Fold `from` into `into`. */
export function mergeSections(into: SectionCounts, from: SectionCounts): void {
  for (const key of Object.keys(from) as (keyof SectionCounts)[]) {
    into[key] = (into[key] ?? 0) + (from[key] ?? 0);
  }
}

/** "the footer, the navigation and the breadcrumbs": up to three names, then "and N more". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/**
 * Where the links to a page that only sitewide chrome points at sit (#2307), for
 * `links/no-contextual-inbound`. The decision that the page is chrome-only is the `isChrome`
 * flag (a `nav`, `header`, `footer` or `aside` ancestor); this says what the sections were.
 *
 * Every section but `content` is named. Links the section rules read as `content` are template
 * links: an anchor inside a post's own `<footer>` ("Back to the journal") is chrome by tag and
 * content by section. They are counted apart and never named as a place the page is linked
 * "only from".
 *
 * "linked only from the footer, the navigation and the breadcrumbs, and 22 template links inside
 * the page content". `complete` is true when every counted inbound link had a section; without it
 * the phrase drops "only". "" when there is nothing to say.
 */
export function chromeSectionPhrase(counts: SectionCounts, complete: boolean): string {
  const named = (Object.keys(counts) as (keyof SectionCounts)[])
    .filter((section) => section !== "content" && (counts[section] ?? 0) > 0)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  const content = counts.content ?? 0;
  const template =
    content > 0
      ? `${content} template ${content === 1 ? "link" : "links"} inside the page content`
      : "";
  const lead = complete ? "linked only" : "linked";
  if (named.length === 0) return template ? `${lead} by ${template}` : "";
  const places = nameList(named.map((section) => PHRASE[section]));
  return `${lead} from ${places}${template ? `, and ${template}` : ""}`;
}

// A broken link in site-wide chrome (#1772) ----------------------------------------------------------------

/** The sections that are site-wide chrome: a link there sits on (nearly) every page a visitor sees. */
export const SITEWIDE_SECTIONS = ["header", "navigation", "footer"] as const;

/** A link counts as site-wide when at least this many pages carry it in chrome ... */
export const SITEWIDE_MIN_PAGES = 3;

/** ... and those pages are at least this share of the pages the audit crawled. A small site of a few pages: below three pages nothing is site-wide, and a link on every page of a 3 or 4 page site is. */
export const SITEWIDE_MIN_SHARE = 0.5;

/** How far a link reaches through chrome: the pages that carry it in a header, navigation or footer, and per section. */
export interface ChromeReach {
  /** Distinct source pages with the link in at least one chrome section. */
  pages: number;
  /** Pages per chrome section, most pages first. */
  sections: Array<{ section: (typeof SITEWIDE_SECTIONS)[number]; pages: number }>;
}

export function chromeReach(sources: readonly CheckItemSource[]): ChromeReach {
  const perSection = new Map<(typeof SITEWIDE_SECTIONS)[number], number>();
  let pages = 0;
  for (const source of sources) {
    let inChrome = false;
    for (const section of SITEWIDE_SECTIONS) {
      if ((source.sections?.[section] ?? 0) > 0) {
        inChrome = true;
        perSection.set(section, (perSection.get(section) ?? 0) + 1);
      }
    }
    if (inChrome) pages++;
  }
  return {
    pages,
    sections: [...perSection]
      .map(([section, n]) => ({ section, pages: n }))
      .sort((a, b) => b.pages - a.pages || a.section.localeCompare(b.section)),
  };
}

/** Whether a link that reaches `reach.pages` pages through chrome is site-wide on an audit of `crawledPages` pages. */
export function isSitewide(reach: ChromeReach, crawledPages: number): boolean {
  return (
    reach.pages >= SITEWIDE_MIN_PAGES &&
    crawledPages > 0 &&
    reach.pages / crawledPages >= SITEWIDE_MIN_SHARE
  );
}

/**
 * The message head of a site-wide broken-link check: "1 broken internal link in the footer of 71 pages", or
 * "2 broken internal links in the site-wide header and footer, each on at least 49 pages". `kind` is "internal"
 * or "external". Counts only the links of this check.
 */
export function sitewideMessageHead(kind: "internal" | "external", reaches: readonly ChromeReach[]): string {
  const n = reaches.length;
  const totals = new Map<(typeof SITEWIDE_SECTIONS)[number], number>();
  for (const reach of reaches) {
    for (const { section, pages } of reach.sections) totals.set(section, (totals.get(section) ?? 0) + pages);
  }
  const places = [...totals]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([section]) => PHRASE[section]);
  const where = nameList(places);
  if (n === 1) {
    return `1 broken ${kind} link in ${where} of ${reaches[0]!.pages} pages`;
  }
  const min = Math.min(...reaches.map((r) => r.pages));
  return `${n} broken ${kind} links in the site-wide ${where.replace(/the /g, "")}, each on at least ${min} pages`;
}

/**
 * Whether a link's placement counts toward "site-wide chrome" (#1772). A section named by the markup (a `header`,
 * `nav` or `footer` landmark) always counts. One named by the page classifier counts only at this confidence or
 * above, so the split into `broken-links-sitewide` does not move with `--no-classifier` or a model update on a
 * link the model was unsure of.
 */
export const CHROME_MIN_CONFIDENCE = 0.8;

/** The section of a link for the site-wide decision: its section when the markup or a confident model placed it, else none. */
export function chromeSectionOf(link: {
  section?: LinkSection;
  sectionSource?: string;
  sectionConfidence?: number;
}): LinkSection | undefined {
  if (link.sectionSource === "model" && (link.sectionConfidence ?? 0) < CHROME_MIN_CONFIDENCE) return undefined;
  return link.section;
}

/**
 * The pages an audit judged as pages, the denominator of the site-wide share: parsed HTML pages that answered
 * without an error. A redirect-source entry (#1762), an error page and a non-HTML file (a PDF, an image) are
 * not pages a visitor reads a footer on.
 */
export function htmlPageCount(
  pages: ReadonlyArray<{
    statusCode: number;
    redirectSource?: boolean;
    headers?: Record<string, string>;
  }>
): number {
  let n = 0;
  for (const p of pages) {
    if (p.redirectSource === true) continue;
    if (p.statusCode < 200 || p.statusCode >= 300) continue;
    const type = p.headers?.["content-type"] ?? p.headers?.["Content-Type"];
    if (type !== undefined && !/html|xml/i.test(type)) continue;
    n++;
  }
  return n;
}
