// Which part of the page an anchor sits in (#2307).
//
// `position` (./links.ts) is a descriptive label that falls back to class/id substrings; `isChrome`
// (./chrome.ts) is a landmark-only yes/no. This is the label a FINDING quotes ("broken link in the
// footer"): landmark tags and ARIA roles, plus one markup-only rule for comment threads, because a
// link there is worth far less than one in the article body and is where spam lands.
//
// Strict on purpose: a wrong section names the wrong part of the page in a fix, a missed one only
// leaves the link as "unknown". Class/id substrings drive only the comments rule, and only on
// names that mean a comment thread (never a bare `comment` that could be a comment *form* label).
//
// The walk is memoised per element: a footer with 300 links reads the footer's attributes once.

import type { ClassifierSource } from "@squirrelscan/core-contracts";
import type { Element } from "linkedom";

import type { LinkSection } from "./types";

/** Sections that name sitewide furniture; once an ancestor is one, nothing inside can override it. */
const CHROME: ReadonlySet<LinkSection> = new Set(["header", "footer", "navigation", "sidebar"]);

const ROLE_SECTION: Record<string, LinkSection> = {
  banner: "header",
  contentinfo: "footer",
  navigation: "navigation",
  complementary: "sidebar",
  main: "content",
};

// A comment THREAD container: WordPress (`comments`, `comment-list`, `commentlist`, `comments-area`),
// Disqus, Discourse-style threads, Facebook/Commento embeds. `respond`/`comment-form` is the reply
// box (no links worth reporting), so it does not count.
const COMMENTS_PATTERN =
  /(?:^|[\s_-])(?:comments|comment-?list|comment-?thread|comment-?section|comments-?area|disqus_thread|fb-comments|commento)(?:$|[\s_-])/;

function ownSection(element: Element): LinkSection | null {
  const tag = element.tagName?.toLowerCase();
  if (tag === "nav") return "navigation";
  if (tag === "aside") return "sidebar";
  if (tag === "header") return "header";
  if (tag === "footer") return "footer";
  if (tag === "main" || tag === "article") return "content";
  const role = element.getAttribute?.("role")?.toLowerCase();
  if (role && ROLE_SECTION[role]) return ROLE_SECTION[role]!;
  const id = element.getAttribute?.("id");
  const cls = element.getAttribute?.("class");
  if (id || cls) {
    if (id && COMMENTS_PATTERN.test(id.toLowerCase())) return "comments";
    if (cls && COMMENTS_PATTERN.test(cls.toLowerCase())) return "comments";
  }
  return null;
}

/** Make a section resolver for one document; call it for every anchor of that document. */
export function makeSectionResolver(): (element: Element) => LinkSection {
  const memo = new WeakMap<Element, LinkSection>();
  return (element: Element): LinkSection => {
    const cached = memo.get(element);
    if (cached) return cached;
    // Climb to the nearest ancestor already resolved, or past the root, in a loop: a page can nest
    // hundreds of thousands of elements, and one stack frame per level would overflow the stack.
    const chain: Element[] = [];
    let inherited: LinkSection = "unknown";
    for (let node: Element | null = element; node; node = node.parentElement) {
      const known = memo.get(node);
      if (known) {
        inherited = known;
        break;
      }
      chain.push(node);
    }
    // Then fold back down, outermost first, so each element reads its parent's answer.
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i]!;
      let section = inherited;
      if (!CHROME.has(inherited)) {
        const own = ownSection(node);
        if (own) {
          // A <header>/<footer> inside <main>/<article> or a comment is that block's own heading,
          // not the site's banner or contentinfo (HTML spec: they only scope to sectioning content).
          const scoped = (own === "header" || own === "footer") && inherited !== "unknown";
          if (!scoped) section = own;
        }
      }
      memo.set(node, section);
      inherited = section;
    }
    return inherited;
  };
}

/** One-off convenience; use {@link makeSectionResolver} when resolving many anchors of a page. */
export function linkSectionOf(element: Element): LinkSection {
  return makeSectionResolver()(element);
}

// ---------------------------------------------------------------------------
// The page classifier as a second source (#2307).
//
// The markup above answers first. Where it is silent, a caller that ran the page classifier can
// supply a placer and the model fills the gap. The parser takes the placer as a plain function so
// it never depends on the classifier (or its artifact): anything shaped like `elementPlacer`'s
// result works.
// ---------------------------------------------------------------------------

/** One answer of a placer: a label, how sure, and who gave it. Structural on purpose. */
export interface PlacedLabel {
  label: string;
  confidence: number;
  source: ClassifierSource;
}

/** Where the classifier puts one element: the region around it and the section purpose it sits in. */
export interface LinkPlacement {
  region: PlacedLabel | null;
  section: PlacedLabel | null;
  /**
   * The classifier found a comment thread above the anchor too far up to name. The answer is then
   * "unknown", never a region: a hostile page must not be able to turn a comment link into "page
   * content" by nesting the thread deeper than the walk cap.
   */
  truncated?: boolean;
}

/** Place one anchor on the page, or null when the classifier has nothing to say. */
export type LinkPlacer = (element: Element) => LinkPlacement | null;

/** A link's section with its provenance. `sectionSource` is set only for a model answer. */
export interface ResolvedLinkSection {
  section: LinkSection;
  sectionSource?: ClassifierSource;
  sectionConfidence?: number;
}

// Section purposes the model may name for a link. Comment threads are separate: see COMMENT_LABELS.
const PURPOSE_SECTION: Readonly<Record<string, LinkSection>> = {
  pagination: "pagination",
  breadcrumbs: "breadcrumbs",
  related_content: "related_content",
  business_info: "business_info",
  social_share: "social_share",
  account_login: "account_login",
  author_byline: "author_byline",
  newsletter_signup: "newsletter_signup",
};

// The classifier's comment threads are read from markup (its `comments` rule, source "rules"). Its
// section head also has a comments class, which the audits found far too unreliable to name a
// link's place, so a comments answer counts only when it comes from the rule. This is the one
// answer whose source matters; everything else is taken at its label and confidence.
const COMMENT_LABELS: ReadonlySet<string> = new Set(["comments", "reviews"]);

// Region answers that name a link section. `site_chrome` (furniture, which of the four unsure),
// form, search and dialog name no part of the page a finding could quote, so they stay unknown.
const REGION_SECTION: Readonly<Record<string, LinkSection>> = {
  site_header: "header",
  footer: "footer",
  navigation: "navigation",
  sidebar: "sidebar",
  main_content: "content",
  content_block: "content",
  article_chrome: "content",
};

/** Sections the markup names for certain: the site's header and footer, and comment threads. */
const MARKUP_FINAL: ReadonlySet<LinkSection> = new Set(["header", "footer", "comments"]);

/**
 * Landmarks a model section purpose may refine: a `nav` that is the pagination or the breadcrumbs
 * reads "the pagination" or "the breadcrumbs", and a related-posts `aside` reads "a related-content
 * block". Only a purpose does: a region answer never replaces them, and a comments answer is
 * ignored (a thread inside furniture is the furniture, as in the markup rule).
 */
const MARKUP_REFINABLE: ReadonlySet<LinkSection> = new Set(["navigation", "sidebar"]);

/**
 * Combine the markup's answer with the classifier's, for one anchor.
 *
 * Precedence: the site's header or footer and comment threads in the markup win outright (the
 * placer is not asked). A section purpose (pagination, breadcrumbs, related content, ...) refines a
 * navigation or sidebar landmark and beats the markup's weak `content` (inside `<main>` or
 * `<article>`, where those blocks usually sit); a region fills a markup `unknown`. The answer's `source` is carried through to be displayed; the only place it
 * decides anything is the comments exception above.
 */
export function mergeLinkSection(
  markup: LinkSection,
  place: () => LinkPlacement | null,
): ResolvedLinkSection {
  if (MARKUP_FINAL.has(markup)) return { section: markup };
  let placement: LinkPlacement | null;
  try {
    placement = place();
  } catch {
    return { section: markup };
  }
  if (!placement) return { section: markup };
  // Fail closed: an element in a thread of unknown extent reads "unknown", even where the markup
  // alone would have said "content".
  if (placement.truncated) return { section: markup === "content" ? "unknown" : markup };
  const named = placement.section;
  if (MARKUP_REFINABLE.has(markup)) {
    const refined = named ? PURPOSE_SECTION[named.label] : undefined;
    return refined && named ? answer(refined, named) : { section: markup };
  }
  const purpose = named
    ? COMMENT_LABELS.has(named.label)
      ? named.source === "rules"
        ? "comments"
        : undefined
      : PURPOSE_SECTION[named.label]
    : undefined;
  if (purpose && named) return answer(purpose, named);
  if (markup === "unknown" && placement.region) {
    const region = REGION_SECTION[placement.region.label];
    if (region) return answer(region, placement.region);
  }
  return { section: markup };
}

// Confidence is stored on every model-named link, so three decimals: enough to read, short to keep.
function answer(section: LinkSection, from: PlacedLabel): ResolvedLinkSection {
  return from.source === "model"
    ? {
        section,
        sectionSource: "model",
        sectionConfidence: Math.round(from.confidence * 1000) / 1000,
      }
    : { section };
}

/**
 * Make a per-document resolver for the link extractors. Without a placer this is the markup rule
 * alone, bit for bit what `makeSectionResolver` gives.
 */
export function makeLinkSectionResolver(
  placeLink?: LinkPlacer,
): (element: Element) => ResolvedLinkSection {
  const markup = makeSectionResolver();
  if (!placeLink) return (element) => ({ section: markup(element) });
  return (element) => mergeLinkSection(markup(element), () => placeLink(element));
}
