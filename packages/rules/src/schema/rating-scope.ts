// schema/rating-scope - AggregateRating that is not about the page it sits on (#106)
//
// schema/review validates the SHAPE of AggregateRating (ratingValue, ratingCount)
// and nothing else, so a single sitewide "5/5 from 18 reviews" block emitted by a
// template passes on every page of the site — including the privacy policy. This
// rule asks the two questions the shape check cannot:
//
//   1. Can a reader see a rating on this page at all? Google requires the rating
//      to be visible in the page content; markup-only ratings are the classic
//      structured-data manual action, not a validation error.
//   2. Is the rated entity the subject of THIS page? A LocalBusiness rating on a
//      privacy policy, a terms page or a blog post is about the site, not the
//      page it is attached to.
//
// The honest half (#106): "AggregateRating appears on many pages" is NOT the
// signal. On most pages of a legitimate LocalBusiness site the review badge is
// genuinely on screen and the rating really is about the business the page is
// about — flagging repetition would flag every one of them. The signal is the
// RELATIONSHIP between the rating and the page, which is why both checks are
// page-local: a visible rating anywhere on the page clears the visibility check,
// and only page types where a rating cannot apply (privacy, terms, article) can
// fail the subject check.
//
// Deliberately conservative:
//   - A third-party review widget (Trustpilot, Yotpo, Judge.me, ...) means the
//     badge is rendered client-side, so a raw-HTML crawl cannot see it. Presence
//     of a widget clears the visibility check rather than accusing the page.
//   - On article pages only a BUSINESS/organization carrier is reported. An
//     article that reviews a Product legitimately carries that Product's rating,
//     so a non-business carrier is left alone.
//   - Structural validity is untouched: schema/review still owns ratingValue /
//     ratingCount and its messages are unchanged.

import { getPathname } from "@squirrelscan/utils";
import { EEAT_PAGE_PATTERNS, LOCAL_BUSINESS_TYPES } from "@squirrelscan/utils/constants";

import type { Document } from "linkedom";

import type { CheckItem } from "@squirrelscan/core-contracts";

import { isPrivacyPage } from "../shared/privacy-page";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const VISIBILITY_CHECK = "rating-visible";
const SUBJECT_CHECK = "rating-subject";

/** Cap on entities listed per check, so one listing page cannot spray a report. */
const MAX_ITEMS = 10;

/** Depth cap for the carrier walk — JSON-LD nests, adversarial JSON-LD nests a lot. */
const MAX_DEPTH = 6;

/**
 * Carrier @types that represent the SITE's own entity rather than the subject of
 * an individual page. A rating hanging off one of these on an article/blog post
 * is the sitewide review badge, not a rating of that post.
 */
const BUSINESS_CARRIER_TYPES = new Set(
  [
    ...LOCAL_BUSINESS_TYPES,
    "Organization",
    "Corporation",
    "OnlineBusiness",
    "OnlineStore",
    "NGO",
    "EducationalOrganization",
    "GovernmentOrganization",
    "PerformingGroup",
    "SportsOrganization",
    "Brand",
    "WebSite",
    "WebPage",
  ].map((t) => t.toLowerCase()),
);

/** Page kinds on which a rating cannot be about the page's subject. */
type IneligiblePageKind = "privacy" | "terms" | "article";

const PAGE_KIND_LABEL: Record<IneligiblePageKind, string> = {
  privacy: "privacy policy",
  terms: "terms",
  article: "article",
};

/** A rating found on the page, with the entity it is attached to. */
interface RatedEntity {
  /** Carrier @type as authored ("LocalBusiness", "AutoRepair", ...), or null. */
  type: string | null;
  /** Every carrier @type, lowercased — generators array-wrap @type freely. */
  types: string[];
  /** Carrier `name`, or null when the markup does not name the entity. */
  name: string | null;
  ratingValue: string | null;
  ratingCount: string | null;
}

/** Star glyphs — a rendered badge is often glyphs plus a number. */
const STAR_GLYPH_RE = /[★☆⭐✩✪✭✮]/;

/**
 * Rating phrasings a reader would recognize: "4.9 / 5", "4.9 out of 5",
 * "4.9 stars", "rated 4.9", "18 reviews". Matching ANY of these clears the
 * visibility check — a false "visible" is far cheaper than accusing a page that
 * shows its rating in wording this rule did not anticipate.
 */
const VISIBLE_RATING_PATTERNS: RegExp[] = [
  // Trailing `(?!\s*\/)` keeps a d/m/yyyy date ("1/5/2026") out of the match.
  /\b\d(?:[.,]\d+)?\s*(?:\/|out\s+of)\s*(?:5|10)\b(?!\s*\/)/i,
  /\b\d(?:[.,]\d+)?[\s-]*stars?\b/i,
  // "note" is deliberately NOT here: "Note: updated March 2026" is boilerplate on
  // exactly the legal pages this rule exists to catch.
  /\b(?:rated|rating|bewertung|calificaci[oó]n)\b[^.\n]{0,24}?\d(?:[.,]\d+)?/i,
  /\b\d{1,7}\s*\+?\s*(?:\w+\s+){0,2}(?:reviews?|ratings?)\b/i,
];

/**
 * Third-party review platforms. Their badge is injected client-side, so on a
 * raw-HTML crawl the rating is legitimately absent from the DOM text.
 */
const REVIEW_WIDGET_SRC_TOKENS = [
  "trustpilot",
  "trustindex",
  "trustmary",
  "reviews.io",
  "reviewsio",
  "reviewsonmywebsite",
  "yotpo",
  "judge.me",
  "judgeme",
  "feefo",
  "birdeye",
  "elfsight",
  "shopperapproved",
  "stamped.io",
  "okendo",
  "loox",
  "junip",
  "reputon",
  "nicejob",
  "podium",
  "sitejabber",
  "endorsal",
  "sociablekit",
];

/** Placeholder containers the same widgets hydrate into. */
const REVIEW_WIDGET_SELECTOR = [
  ".trustpilot-widget",
  ".ti-widget",
  ".yotpo",
  ".jdgm-widget",
  ".stamped-container",
  ".okendo-widget",
  ".loox-reviews",
  "[data-elfsight-app-lazy]",
  "[data-yotpo-instance-id]",
  "[data-reviews-io-widget]",
].join(", ");

export const ratingScopeRule: Rule = {
  meta: {
    id: "schema/rating-scope",
    name: "Rating Scope",
    description: "Checks AggregateRating is about the page's subject and visible to readers",
    solution:
      "AggregateRating must describe the thing THIS page is about, and the rating has to be visible to the reader in the page content. A single sitewide rating emitted by a template lands on pages that cannot be rated — privacy policies, terms, blog posts — where it is a self-serving rating of the site rather than markup about the page. Google treats invisible or off-topic rating markup as a structured-data policy violation and issues manual actions for it, which costs the whole site its rich results, not just this page. Move the rating onto the pages whose subject it actually describes (the LocalBusiness on the homepage or location pages, the Product on its product page) and make sure the same rating is on screen.",
    category: "schema",
    scope: "page",
    severity: "warning",
    weight: 4,
    // A soft-404 page serves the site template (rating block included) for a URL
    // that does not exist — don't argue about scope on a broken URL.
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const entities = collectRatedEntities(ctx);
    if (entities.length === 0) return { checks: [] };

    const checks: CheckResult[] = [];
    const kind = ineligiblePageKind(ctx);

    checks.push(buildVisibilityCheck(ctx, doc, entities, pageLabel(ctx, kind)));
    if (kind) checks.push(buildSubjectCheck(entities, kind));

    return { checks };
  },
};

// ============================================================================
// Rating collection
// ============================================================================

/**
 * Every AggregateRating on the page with the entity carrying it. Walks the
 * parsed schema nodes (already `@graph`-flattened) because a rating is usually
 * a property of a nested node, not a top-level one.
 */
function collectRatedEntities(ctx: RuleContext): RatedEntity[] {
  const found: RatedEntity[] = [];
  const seen = new Set<string>();

  const push = (entity: RatedEntity): void => {
    const key = `${entity.type}|${entity.name}|${entity.ratingValue}|${entity.ratingCount}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(entity);
  };

  for (const node of ctx.parsed.schemas.all) {
    walkForRatings(node, null, 0, push);
  }

  return found;
}

/**
 * Depth-bounded walk collecting `aggregateRating` properties and standalone
 * `AggregateRating` nodes, attributing each to the nearest enclosing typed node.
 */
function walkForRatings(
  value: unknown,
  carrier: Record<string, unknown> | null,
  depth: number,
  push: (entity: RatedEntity) => void,
): void {
  if (depth > MAX_DEPTH || !value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) walkForRatings(item, carrier, depth + 1, push);
    return;
  }

  const node = value as Record<string, unknown>;
  const isRatingNode = typeNames(node).some((t) => t === "aggregaterating");
  const nextCarrier = isRatingNode ? carrier : hasType(node) ? node : carrier;

  if (isRatingNode) {
    push(toEntity(nextCarrier, node));
  } else if (node["aggregateRating"]) {
    const rating = firstObject(node["aggregateRating"]);
    if (rating) push(toEntity(node, rating));
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === "aggregateRating" || key.startsWith("@")) continue;
    walkForRatings(child, nextCarrier, depth + 1, push);
  }
}

function toEntity(
  carrier: Record<string, unknown> | null,
  rating: Record<string, unknown>,
): RatedEntity {
  return {
    type: carrier ? (typeNames(carrier, false)[0] ?? null) : null,
    types: carrier ? typeNames(carrier) : [],
    name: carrier ? readString(carrier["name"]) : null,
    ratingValue: readString(rating["ratingValue"]),
    ratingCount: readString(rating["ratingCount"] ?? rating["reviewCount"]),
  };
}

/** `@type` values, lowercased by default (some generators array-wrap @type). */
function typeNames(node: Record<string, unknown>, lower = true): string[] {
  const raw = node["@type"];
  const list: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  return list
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map((t) => (lower ? t.toLowerCase() : t));
}

function hasType(node: Record<string, unknown>): boolean {
  return typeNames(node).length > 0;
}

/** Some generators array-wrap AggregateRating (#721); take the first object. */
function firstObject(raw: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(raw)
    ? raw.find((r) => r && typeof r === "object" && !Array.isArray(r))
    : raw;
  return candidate && typeof candidate === "object"
    ? (candidate as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// ============================================================================
// Visibility
// ============================================================================

function buildVisibilityCheck(
  ctx: RuleContext,
  doc: Document,
  entities: RatedEntity[],
  label: string | null,
): CheckResult {
  if (hasReviewWidget(doc)) {
    return {
      name: VISIBILITY_CHECK,
      status: "pass",
      message: "AggregateRating backed by a third-party review widget on the page",
      details: { pageType: label, ratedEntities: entities.length },
    };
  }

  const text = visibleText(ctx, doc);
  if (hasVisibleRating(text, entities)) {
    return {
      name: VISIBILITY_CHECK,
      status: "pass",
      message: "AggregateRating has a rating visible on the page",
      details: { pageType: label, ratedEntities: entities.length },
    };
  }

  const primary = entities[0];
  return {
    name: VISIBILITY_CHECK,
    status: "warn",
    message:
      `${describeRating(primary)} on ${describeEntity(primary)} is not visible anywhere on ` +
      `${pagePhrase(label)} — a rating readers cannot see is a structured-data policy violation ` +
      "and risks a manual action, not just a lost rich result",
    details: {
      pageType: label,
      ratedEntityType: primary.type,
      ratedEntityName: primary.name,
      ratingValue: primary.ratingValue,
      ratingCount: primary.ratingCount,
      reason: "no-visible-rating",
    },
    items: toItems(entities),
  };
}

/**
 * Rendered page text plus the attributes a badge is commonly rendered into.
 * `content.textContent` drops `<svg>`, so a star-glyph SVG badge would otherwise
 * read as "no rating on the page".
 */
function visibleText(ctx: RuleContext, doc: Document): string {
  const parts = [ctx.parsed.content?.textContent ?? ""];
  for (const el of doc.querySelectorAll("[alt], [aria-label], [title]")) {
    parts.push(
      el.getAttribute("alt") ?? "",
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("title") ?? "",
    );
  }
  return parts.join(" ");
}

function hasVisibleRating(text: string, entities: RatedEntity[]): boolean {
  if (STAR_GLYPH_RE.test(text)) return true;
  if (VISIBLE_RATING_PATTERNS.some((p) => p.test(text))) return true;

  // A decimal rating value printed verbatim ("4.7", "4,7") is unambiguous on its
  // own. A whole-number one ("5") is not, and is left to the patterns above.
  return entities.some((e) => {
    const value = e.ratingValue;
    if (!value || !/^\d+[.,]\d+$/.test(value)) return false;
    const alternates = new Set([value, value.replace(".", ","), value.replace(",", ".")]);
    return [...alternates].some((v) => new RegExp(`(?<!\\d)${escapeRe(v)}(?!\\d)`).test(text));
  });
}

function hasReviewWidget(doc: Document): boolean {
  for (const el of doc.querySelectorAll("script[src], iframe[src], link[href]")) {
    const src = (el.getAttribute("src") ?? el.getAttribute("href") ?? "").toLowerCase();
    if (REVIEW_WIDGET_SRC_TOKENS.some((token) => src.includes(token))) return true;
  }
  try {
    return doc.querySelector(REVIEW_WIDGET_SELECTOR) !== null;
  } catch {
    // Skip selectors the parser rejects.
    return false;
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Subject
// ============================================================================

function buildSubjectCheck(entities: RatedEntity[], kind: IneligiblePageKind): CheckResult {
  const label = PAGE_KIND_LABEL[kind];
  // Legal pages have no rateable subject at all, so every rating on them is out
  // of scope. An article's subject CAN be rateable (a product review), so only
  // the sitewide business entity is reported there.
  const offenders =
    kind === "article" ? entities.filter((e) => isBusinessCarrier(e.types)) : entities;

  if (offenders.length === 0) {
    return {
      name: SUBJECT_CHECK,
      status: "pass",
      message: `AggregateRating on this ${label} page rates the page's own subject`,
      details: { pageType: label, ratedEntities: entities.length },
    };
  }

  const primary = offenders[0];
  return {
    name: SUBJECT_CHECK,
    status: "warn",
    message:
      `AggregateRating on ${describeEntity(primary)} is not the subject of this ${label} page — ` +
      "sitewide rating markup on a page that cannot be rated is a structured-data policy " +
      "violation and risks a manual action, not just a lost rich result",
    details: {
      pageType: label,
      ratedEntityType: primary.type,
      ratedEntityName: primary.name,
      ratingValue: primary.ratingValue,
      ratingCount: primary.ratingCount,
      reason: "entity-not-page-subject",
    },
    items: toItems(offenders),
  };
}

function isBusinessCarrier(types: string[]): boolean {
  return types.some((t) => BUSINESS_CARRIER_TYPES.has(t));
}

/**
 * Page kind on which a rating cannot be about the page's subject. Legal pages
 * are matched slug- and heading-first (a `/legal/privacy` page is still a
 * privacy policy); articles come from the parser's page-type classifier.
 */
function ineligiblePageKind(ctx: RuleContext): IneligiblePageKind | null {
  const page = { url: ctx.page.url, parsed: ctx.parsed };
  if (isPrivacyPage(page)) return "privacy";
  if (isTermsPage(ctx)) return "terms";
  if (ctx.parsed.pageType === "article") return "article";
  return null;
}

const TERMS_HEADING_RE =
  /^(?:terms(?:\s*(?:&|and)\s*conditions|\s+of\s+(?:service|use|sale))?|terms|conditions\s+of\s+use|allgemeine\s+gesch[aä]ftsbedingungen|nutzungsbedingungen|t[eé]rminos\s+y\s+condiciones|conditions\s+g[eé]n[eé]rales(?:\s+d['’]utilisation)?)$/i;
const TITLE_SEPARATORS = /[|–—\-:·•]+/;

function isTermsPage(ctx: RuleContext): boolean {
  const path = getPathname(ctx.page.url) || ctx.page.url;
  if (EEAT_PAGE_PATTERNS.terms.some((p) => p.test(path))) return true;

  const headings = [ctx.parsed.meta?.title ?? "", ...(ctx.parsed.h1?.texts ?? [])];
  return headings.some((heading) =>
    heading.split(TITLE_SEPARATORS).some((seg) => TERMS_HEADING_RE.test(seg.trim())),
  );
}

// ============================================================================
// Reporting
// ============================================================================

/**
 * Page label used in both the message and `details.pageType`: the legal kind,
 * else the classified page type, else null when the classifier could not name it.
 */
function pageLabel(ctx: RuleContext, kind: IneligiblePageKind | null): string | null {
  if (kind) return PAGE_KIND_LABEL[kind];
  const pageType = ctx.parsed.pageType;
  return !pageType || pageType === "unknown" ? null : pageType;
}

function pagePhrase(label: string | null): string {
  return label ? `this ${label} page` : "this page";
}

function describeEntity(entity: RatedEntity): string {
  if (entity.type && entity.name) return `${entity.type} "${entity.name}"`;
  if (entity.type) return entity.type;
  if (entity.name) return `"${entity.name}"`;
  return "an untyped entity";
}

function describeRating(entity: RatedEntity): string {
  if (!entity.ratingValue) return "AggregateRating";
  const count = entity.ratingCount ? ` from ${entity.ratingCount} reviews` : "";
  return `AggregateRating ${entity.ratingValue}${count}`;
}

function toItems(entities: RatedEntity[]): CheckItem[] {
  return entities.slice(0, MAX_ITEMS).map((entity, index) => ({
    id: `rated-entity-${index + 1}`,
    label: `${describeRating(entity)} on ${describeEntity(entity)}`,
    meta: {
      ratedEntityType: entity.type,
      ratedEntityName: entity.name,
      ratingValue: entity.ratingValue,
      ratingCount: entity.ratingCount,
    },
  }));
}
