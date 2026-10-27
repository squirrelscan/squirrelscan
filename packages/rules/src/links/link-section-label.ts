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
