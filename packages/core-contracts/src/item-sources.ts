// Where a link sits on the pages that carry it (#2307, pub#837): the section phrases the link
// rules put on their items, and the per-source detail every report format prints, so a finding
// reads the same in each of them.

import type { CheckItem, CheckItemSource, LinkSection, LinkSectionCounts } from "./index";

/**
 * How a section reads in a finding: "in the footer", "in the page content", "in the
 * pagination", ... The first six come from page markup; the rest are section purposes the page
 * classifier names where the markup says nothing.
 */
export const LINK_SECTION_PHRASE: Record<Exclude<LinkSection, "unknown">, string> = {
  header: "the header",
  footer: "the footer",
  navigation: "the navigation",
  sidebar: "the sidebar",
  comments: "the comments",
  content: "the page content",
  pagination: "the pagination",
  breadcrumbs: "the breadcrumbs",
  related_content: "a related-content block",
  business_info: "the business details",
  social_share: "the social sharing links",
  account_login: "the account and login links",
  author_byline: "the author byline",
  newsletter_signup: "the newsletter signup",
};

/**
 * A placed section name this version knows: not `unknown`, and an own key of the phrase table, so
 * a stored key such as "constructor" never reads as a section.
 */
export function isLinkSection(value: unknown): value is Exclude<LinkSection, "unknown"> {
  return typeof value === "string" && Object.hasOwn(LINK_SECTION_PHRASE, value);
}

/** "the footer and the page content", most links first; "" when no section is known. */
export function linkSectionList(counts: LinkSectionCounts): string {
  const names = (Object.keys(counts) as (keyof LinkSectionCounts)[])
    .filter((section) => isLinkSection(section) && (counts[section] ?? 0) > 0)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b))
    .map((section) => LINK_SECTION_PHRASE[section]);
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** "in the footer" / "in the footer and the page content"; "" when no section is known. */
export function linkSectionPhrase(counts: LinkSectionCounts): string {
  const list = linkSectionList(counts);
  return list ? `in ${list}` : "";
}

/**
 * What one source page adds to its row: "2 links, in the footer", "in the page content", "3
 * links". "" for a single link whose section is unknown, which says nothing the page does not.
 */
export function itemSourceDetail(source: CheckItemSource): string {
  const parts: string[] = [];
  if (source.links !== undefined && source.links > 1) parts.push(`${source.links} links`);
  const where = source.sections ? linkSectionPhrase(source.sections) : "";
  if (where) parts.push(where);
  return parts.join(", ");
}

/**
 * The sections an item has on one page, as page counts: each known section once (pub#846). What a
 * page-scope rule sets as its item's `regions`; undefined when no section is known.
 */
export function pageRegions(
  sections: Iterable<LinkSection | undefined>
): LinkSectionCounts | undefined {
  const regions: LinkSectionCounts = {};
  let any = false;
  for (const section of sections) {
    if (!section || !isLinkSection(section)) continue;
    regions[section] = 1;
    any = true;
  }
  return any ? regions : undefined;
}

/** `into` plus `from`, section by section; `into` when `from` adds nothing. A new object otherwise. */
export function addRegions(
  into: LinkSectionCounts | undefined,
  from: LinkSectionCounts | undefined
): LinkSectionCounts | undefined {
  if (!from) return into;
  const out: LinkSectionCounts = { ...into };
  for (const key of Object.keys(from) as (keyof LinkSectionCounts)[]) {
    const n = from[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
    if (!isLinkSection(key)) continue;
    out[key] = (out[key] ?? 0) + n;
  }
  return Object.keys(out).length > 0 ? out : into;
}

/**
 * `item` with `sources` kept only for pages `sourcePages` still lists. A publish cap that clips
 * `sourcePages` clips this with it, so the payload stays the size the cap means. The same object
 * when nothing changes.
 */
export function alignItemSources<T extends CheckItem>(item: T): T {
  if (!item.sources) return item;
  const listed = new Set(item.sourcePages ?? []);
  const kept = item.sources.filter((source) => listed.has(source.page));
  if (kept.length === item.sources.length) return item;
  const next = { ...item };
  if (kept.length > 0) next.sources = kept;
  else delete next.sources;
  return next;
}
