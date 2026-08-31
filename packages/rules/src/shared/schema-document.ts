// Shared JSON-LD vocabulary for the rules that read a DATE off a page's schema
// (content/date-agreement, crawl/sitemap-lastmod-drift).
//
// The trap both rules exist to avoid: a date belongs to the node that describes
// the DOCUMENT. A sitewide SoftwareApplication / Product / Organization / WebSite
// node carries its own datePublished or dateModified (a release date, a founding
// date, a template's build date) and WordPress SEO plugins emit one on every page
// of the site — Yoast and Rank Math put it FIRST in `@graph`, ahead of the
// Article. Taking the first dated node in the document therefore attributes one
// sitewide date to every post, and makes a verdict depend on `@graph` node order.
//
// Both rules pick their own node once classified — they want different fields —
// but the classification itself lives here so the two can never drift apart.

/**
 * Schema `@type`s that stand for a dated piece of CONTENT. These are the types a
 * reader expects a visible date on, so `content/date-agreement` also treats them
 * as the only ones that can raise `visible-date-missing`.
 */
const ARTICLE_TYPES = new Set(
  [
    "Article",
    "AdvertiserContentArticle",
    "BlogPosting",
    "DiscussionForumPosting",
    "LiveBlogPosting",
    "NewsArticle",
    "ReportageNewsArticle",
    "ScholarlyArticle",
    "SocialMediaPosting",
    "TechArticle",
  ].map((t) => t.toLowerCase()),
);

/**
 * Page-level `@type`s: they describe the document without being dated content in
 * their own right. Their dates are comparable, but a page node carrying dates is
 * usually CMS boilerplate (emitted on every page of a site, contact form
 * included), so it never has to render a visible date — demanding one would warn
 * on every page of every WordPress site.
 */
const PAGE_TYPES = new Set(
  [
    "Report",
    "WebPage",
    "AboutPage",
    "CheckoutPage",
    "CollectionPage",
    "ContactPage",
    "FAQPage",
    "ItemPage",
    "MedicalWebPage",
    "ProfilePage",
    "QAPage",
    "SearchResultsPage",
    "Recipe",
    "HowTo",
  ].map((t) => t.toLowerCase()),
);

/** `@type` values as authored; generators array-wrap `@type` freely. */
export function typeNames(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  const list: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  return list.filter((t): t is string => typeof t === "string" && t.length > 0);
}

/**
 * A `@type` reduced to the bare term the sets are keyed on. JSON-LD lets a type
 * be written as the full IRI (`https://schema.org/Article`) or against a compact
 * prefix (`schema:Article`); both name the same type as the bare `Article` most
 * generators emit.
 */
function typeTerm(type: string): string {
  // One alternation, not two passes: stripping in sequence would reduce the
  // nonsense `https://schema.org/schema:Article` to a type it does not name.
  return type.trim().replace(/^(?:https?:\/\/schema\.org\/|schema:)/i, "").toLowerCase();
}

/** Whether a `@type` (as authored) is a dated piece of content rather than a page shell. */
export function isArticleType(type: string): boolean {
  return ARTICLE_TYPES.has(typeTerm(type));
}

/**
 * The node's document-describing `@type`s as authored, in the order written — the
 * page itself or the single piece of content it exists to publish. Empty when the
 * node describes something the page merely mentions. A date on a document node is
 * a claim about when THIS page was published or updated; everything else
 * (SoftwareApplication, Product, Organization, WebSite, Person, ...) dates a
 * different thing entirely.
 *
 * A list rather than one winner because callers disagree about what to do with a
 * node claiming several (`["WebPage", "BlogPosting"]`): whether the Article half
 * outranks the page half is a per-rule policy, not part of the vocabulary.
 */
export function documentTypes(node: Record<string, unknown>): string[] {
  return typeNames(node).filter((t) => {
    const term = typeTerm(t);
    return ARTICLE_TYPES.has(term) || PAGE_TYPES.has(term);
  });
}

/**
 * A JSON-LD date property: a plain string, a `{"@value": ...}` wrapper, or a list
 * of either.
 *
 * `accept` narrows what counts as a hit, so a caller that can only use a
 * parseable date skips a malformed entry and keeps looking instead of taking it
 * and failing later. It defaults to accepting any non-empty string, which is
 * what a caller that validates downstream wants.
 */
export function schemaDateString(
  value: unknown,
  accept: (date: string) => boolean = () => true,
): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && accept(trimmed) ? trimmed : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = (value as Record<string, unknown>)["@value"];
    if (typeof inner === "string") {
      const trimmed = inner.trim();
      return trimmed && accept(trimmed) ? trimmed : null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = schemaDateString(entry, accept);
      if (found) return found;
    }
  }
  return null;
}
