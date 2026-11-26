// core/og-tags - Validates Open Graph tags

import { pageTypeFromUrl } from "@squirrelscan/parser";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  DEFAULT_MIN_CONFIDENCE,
  VETO_TYPES,
  declaredTypes,
  isArticleType,
} from "../schema/expected-type";

// og:type values the Open Graph protocol defines (ogp.me), lowercase.
const KNOWN_OG_TYPES = new Set([
  "website",
  "article",
  "book",
  "profile",
  "product",
  "product.item",
  "product.group",
  "place",
  "business.business",
  "music.song",
  "music.album",
  "music.playlist",
  "music.radio_station",
  "video.movie",
  "video.episode",
  "video.tv_show",
  "video.other",
]);

type DetectedKind =
  | "pricing"
  | "contact"
  | "legal"
  | "listing"
  | "homepage"
  | "article";

interface Detected {
  readonly kind: DetectedKind;
  /** Where the label came from, named in the message. */
  readonly source: "schema" | "URL pattern" | "page classifier";
}

const PRICING_PATH = /\/(?:pricing|plans|plans-and-pricing)\/?$/;
const LEGAL_PATH =
  /\/(?:privacy(?:-policy)?|terms(?:-of-(?:service|use))?|terms-and-conditions|legal|cookies?(?:-policy)?|disclaimer)\/?$/;

/** Page kinds read from the URL path alone. Bounded: the path is matched by anchored alternations. */
function kindFromUrl(url: string): DetectedKind | null {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase().slice(0, 512);
  } catch {
    return null;
  }
  if (PRICING_PATH.test(path)) return "pricing";
  if (LEGAL_PATH.test(path)) return "legal";
  const generic = pageTypeFromUrl(url);
  if (generic === "contact") return "contact";
  if (generic === "home") return "homepage";
  if (generic === "category") return "listing";
  if (generic === "article") return "article";
  return null;
}

// The classifier's labels that name a kind og:type=article contradicts, or an article. The
// keys other than pricing and legal (model-only labels) are the FAMILIES labels.
const CLASSIFIER_KIND: Readonly<Record<string, DetectedKind>> = {
  pricing: "pricing",
  legal: "legal",
  contact: "contact",
  listing_index: "listing",
  product_listing: "listing",
  article: "article",
  blog_post: "article",
};

const KIND_NOUN: Readonly<Record<DetectedKind, string>> = {
  pricing: "pricing page",
  contact: "contact page",
  legal: "legal page",
  listing: "listing page",
  homepage: "homepage",
  article: "blog post",
};

/**
 * What the page is, from the strongest witness first: schema, then URL pattern, then a
 * confident MODEL label. A rules-sourced classifier label is read from the schema and og:type
 * themselves, so it is never used to judge og:type (it would be circular).
 */
function detectPageKind(ctx: RuleContext, url: string): Detected | null {
  const declared = declaredTypes(ctx);
  // The schema may veto: a page that declares an article type is an article.
  const topListing = [...declared.topLevel.keys()].some((k) =>
    VETO_TYPES.has(k)
  );
  if ([...declared.all.keys()].some(isArticleType))
    return { kind: "article", source: "schema" };
  if (declared.topLevel.has("contactpage"))
    return { kind: "contact", source: "schema" };
  if (topListing) return { kind: "listing", source: "schema" };

  const fromUrl = kindFromUrl(url);
  if (fromUrl) return { kind: fromUrl, source: "URL pattern" };

  const pageType = ctx.parsed.classification?.pageType;
  if (
    pageType &&
    pageType.source === "model" &&
    pageType.confidence >= DEFAULT_MIN_CONFIDENCE
  ) {
    const kind = CLASSIFIER_KIND[pageType.label];
    if (kind) return { kind, source: "page classifier" };
  }
  return null;
}

function judgeOgType(ctx: RuleContext, ogType: string): CheckResult | null {
  const declaredValue = ogType.trim().toLowerCase().slice(0, 128);
  if (!KNOWN_OG_TYPES.has(declaredValue)) {
    return {
      name: "og-type-unknown",
      status: "info",
      message: "og:type is not a type the Open Graph protocol defines",
      value: ogType.trim().slice(0, 64),
    };
  }
  if (ctx.parsed.isSoft404) return null;
  if (declaredValue !== "article" && declaredValue !== "website") return null;

  const detected = detectPageKind(ctx, ctx.page.url);
  if (!detected) return null;

  if (declaredValue === "article") {
    if (detected.kind === "article") return null;
    // Article on a non-article page: only schema and URL evidence may warn.
    const strong = detected.source !== "page classifier";
    return {
      name: "og-type-mismatch",
      status: strong ? "warn" : "info",
      message: `og:type is article but the page reads as a ${KIND_NOUN[detected.kind]} (from ${detected.source})`,
      value: `article -> ${detected.kind}`,
      details: { declared: "article", detected: detected.kind },
    };
  }

  // og:type=website on a clear blog post is a missed opportunity, never a warning.
  if (detected.kind !== "article") return null;
  return {
    name: "og-type-mismatch",
    status: "info",
    message: `og:type is website but the page reads as a blog post (from ${detected.source})`,
    value: "website -> article",
    details: { declared: "website", detected: "article" },
  };
}

export const ogTagsRule: Rule = {
  meta: {
    id: "core/og-tags",
    name: "Open Graph Tags",
    description: "Validates Open Graph meta tags for social sharing",
    solution:
      "Open Graph tags control how your content appears when shared on Facebook, LinkedIn, and other platforms. Required tags: og:title, og:description, og:image, og:url, and og:type. Add OG tags in your page head. Use images at least 1200x630 pixels for best display. Keep og:title under 60 characters and og:description under 200. Test shares using Facebook's Sharing Debugger tool.",
    category: "core",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 5,
    // Check names by outcome class (#1741, #2218).
    checks: [
      { name: "og-title", outcome: "problem" },
      { name: "og-description", outcome: "problem" },
      { name: "og-image", outcome: "problem" },
      { name: "og-type", outcome: "problem" },
      { name: "og-type-mismatch", outcome: "problem" },
      { name: "og-type-unknown", outcome: "problem" },
      {
        name: "og-tags",
        outcome: "clean",
        clears: [
          "og-title",
          "og-description",
          "og-image",
          "og-type",
          "og-type-mismatch",
          "og-type-unknown",
        ],
      },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const { og } = ctx.parsed;
    const checks: CheckResult[] = [];
    let hasMissing = false;

    // Check og:title
    if (!og.title) {
      checks.push({
        name: "og-title",
        status: "warn",
        message: "Missing og:title",
        value: null,
      });
      hasMissing = true;
    }

    // Check og:description
    if (!og.description) {
      checks.push({
        name: "og-description",
        status: "warn",
        message: "Missing og:description",
        value: null,
      });
      hasMissing = true;
    }

    // Check og:image (important for social sharing)
    if (!og.image) {
      checks.push({
        name: "og-image",
        status: "warn",
        message: "Missing og:image - social shares will lack imagery",
        value: null,
      });
      hasMissing = true;
    }

    // Check og:type
    if (!og.type) {
      checks.push({
        name: "og-type",
        status: "info",
        message: "Missing og:type (defaults to website)",
        value: null,
      });
    }

    let typeFlagged = false;
    if (og.type) {
      const verdict = judgeOgType(ctx, og.type);
      if (verdict) {
        checks.push(verdict);
        typeFlagged = true;
      }
    }

    // Summary check: withheld while a type finding stands, so the clean check never
    // clears a problem emitted in the same audit.
    if (!hasMissing && !typeFlagged) {
      checks.push({
        name: "og-tags",
        status: "pass",
        message: "Essential Open Graph tags present",
        value: `title: ${og.title?.slice(0, 30)}...`,
      });
    }

    return { checks };
  },
};
