// schema/expected-type - structured data a page's classified type should carry (#2307)
//
// The page classifier (packages/page-classifier) labels a page "product_detail",
// "contact", "docs" and so on from how the page is built, not from its markup.
// That makes a page-type label an independent witness for a finding the per-type
// schema rules cannot make: schema/product only looks at pages that already carry
// Product markup, so a product page with none passes it. This rule asks the other
// way round: the classifier says this is a product page, where is the Product?
//
// Only a MODEL label is trusted. The classifier's rules fallback labels a page
// from its JSON-LD @type and og:type (rules-fallback.ts SCHEMA_TYPE_MAP and
// OG_TYPE_MAP), so a rules-sourced "article" came FROM the schema or is a low
// confidence default; judging the schema against it is circular. `homepage` is
// only ever rules-sourced, and the site-level WebSite and Organization nodes have
// their own rules (schema/entity-website-missing, schema/entity-organization-missing).
//
// The schema may VETO a finding, never create one. A blog index or pillar page the
// model reads as a post, but which declares Blog or CollectionPage, is a listing
// and must not be asked for Article markup.

import { LOCAL_BUSINESS_TYPES } from "@squirrelscan/utils/constants";
import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { UNREADABLE_MESSAGE, bareTypeName, jsonLdTypes, microdataAndRdfaTypes } from "./markup-types";

export const optionsSchema = z.object({
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.9)
    .describe("Minimum classifier confidence (0 to 1) before a page type is trusted"),
});

type PageTypeFamily = {
  /** The page reads as `a <noun>` / `an <noun>`; the pass message capitalises it. */
  readonly noun: string;
  /** The schema.org types, in plain words, that the fail message asks for. */
  readonly wanted: string;
  readonly matches: (name: string) => boolean;
  /** Detail labels (one thing, not a list of things) that a listing type vetoes. */
  readonly detail: boolean;
};

const ARTICLE_TYPES = new Set([
  "article",
  "report",
  "blogposting",
  "liveblogposting",
  "socialmediaposting",
  "discussionforumposting",
]);
// Not `endsWith("posting")`: that would take JobPosting for an article.
const isArticleType = (name: string): boolean => name.endsWith("article") || ARTICLE_TYPES.has(name);

const PRODUCT_TYPES = new Set([
  "product",
  "productgroup",
  "productmodel",
  "individualproduct",
  "someproducts",
  "vehicle",
  "car",
  // Google's type for a software product page; "no Product" would be wrong advice.
  "softwareapplication",
  "mobileapplication",
  "webapplication",
]);

const LISTING_TYPES = new Set(["collectionpage", "itemlist", "searchresultspage", "blog", "offercatalog"]);
// The subset that says "this page is an index", used for the veto. OfferCatalog is
// a valid listing answer for product_listing but does not prove a post is an index.
const VETO_TYPES = new Set(["collectionpage", "itemlist", "searchresultspage", "blog"]);

const DOCS_TYPES = new Set(["apireference", "howto", "faqpage", "qapage"]);

const ORGANIZATION_TYPES = new Set(
  [
    "Organization",
    "Corporation",
    "NGO",
    "Brand",
    "Airline",
    "Consortium",
    "ProfessionalService",
    "EducationalOrganization",
    "GovernmentOrganization",
    "MedicalOrganization",
    "SportsOrganization",
    "PerformingGroup",
    ...LOCAL_BUSINESS_TYPES,
  ].map((t) => t.toLowerCase()),
);
const isOrganizationType = (name: string): boolean =>
  ORGANIZATION_TYPES.has(name) || name.endsWith("business") || name.endsWith("organization");

const FAMILIES: Readonly<Record<string, PageTypeFamily>> = {
  article: {
    noun: "article",
    wanted: "Article",
    matches: isArticleType,
    detail: true,
  },
  blog_post: {
    noun: "blog post",
    wanted: "Article or BlogPosting",
    matches: isArticleType,
    detail: true,
  },
  product_detail: {
    noun: "product page",
    wanted: "Product",
    matches: (name) => PRODUCT_TYPES.has(name),
    detail: true,
  },
  product_listing: {
    noun: "product listing",
    wanted: "CollectionPage or ItemList",
    matches: (name) => LISTING_TYPES.has(name),
    detail: false,
  },
  listing_index: {
    noun: "listing page",
    wanted: "CollectionPage or ItemList",
    matches: (name) => LISTING_TYPES.has(name),
    detail: false,
  },
  docs: {
    noun: "documentation page",
    wanted: "Article, TechArticle, HowTo or FAQPage",
    matches: (name) => isArticleType(name) || DOCS_TYPES.has(name),
    detail: false,
  },
  contact: {
    noun: "contact page",
    wanted: "ContactPage or Organization",
    matches: (name) => name === "contactpage" || isOrganizationType(name),
    detail: false,
  },
  about: {
    noun: "about page",
    wanted: "AboutPage, ProfilePage, Person or Organization",
    matches: (name) =>
      name === "aboutpage" || name === "profilepage" || name === "person" || isOrganizationType(name),
    detail: false,
  },
};

interface DeclaredTypes {
  /** Every type the page declares, nested JSON-LD, microdata and RDFa included: lowercase key to spelling. */
  readonly all: Map<string, string>;
  /** Only the JSON-LD top-level and `@graph` node types: what the listing veto reads. */
  readonly topLevel: Map<string, string>;
  /** False when a markup or JSON-LD scan hit a bound: absence is then not proven. */
  readonly complete: boolean;
}

function declaredTypes(ctx: RuleContext): DeclaredTypes {
  const all = new Map<string, string>();
  const topLevel = new Map<string, string>();
  const put = (into: Map<string, string>, raw: string): void => {
    const bare = bareTypeName(raw);
    if (bare && !into.has(bare.toLowerCase())) into.set(bare.toLowerCase(), bare);
  };

  // The parser's list is the top-level and @graph node types only. The veto reads
  // exactly that: a nested `isPartOf: Blog` must not turn a post into a listing.
  for (const raw of ctx.parsed.schemas?.types ?? []) {
    if (typeof raw !== "string") continue;
    put(topLevel, raw);
    put(all, raw);
  }
  // "Declares no Product" must not be said of a page that declares one nested in
  // another node (`WebPage.mainEntity`), or in microdata or RDFa.
  const nested = jsonLdTypes(ctx.parsed.schemas?.all ?? []);
  for (const raw of nested.types) put(all, raw);
  const markup = microdataAndRdfaTypes(ctx.parsed.document);
  for (const raw of markup.types) put(all, raw);

  return { all, topLevel, complete: nested.complete && markup.complete };
}

function firstMatch(declared: Map<string, string>, test: (name: string) => boolean): string | null {
  for (const [key, spelling] of declared) {
    if (test(key)) return spelling;
  }
  return null;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withArticle(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

export const expectedTypeSchemaRule: Rule = {
  meta: {
    id: "schema/expected-type",
    name: "Expected schema for page type",
    description:
      "Flags a page the classifier confidently reads as a product, article, contact, about, docs or listing page when it declares none of the structured data that type should carry",
    solution:
      "Add JSON-LD that matches what the page is. Product pages need Product (name, image, offers) for product rich results. Articles and blog posts need Article or BlogPosting (headline, author, datePublished) for article rich results. Listing and collection pages should declare CollectionPage or ItemList, and BreadcrumbList helps too. Documentation pages can use TechArticle, HowTo or FAQPage. Contact and about pages should declare ContactPage or AboutPage, and an Organization or LocalBusiness with name, url and contact details, so search engines and agents can tie the page to the business behind it. If the classifier misread the page, raise min_confidence or disable the rule for that section.",
    category: "schema",
    scope: "page",
    verdictScope: "page",
    // A soft-404 page is an error template, so what it looks like says nothing about
    // what the site meant it to be.
    skipOnSoft404: true,
    severity: "warning",
    weight: 5,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options ?? {});
    const pageType = ctx.parsed.classification?.pageType;

    // Model answers only: a rules label is read from the schema (circular) or is a
    // low-confidence default.
    // `!(x >= y)`, not `x < y`: a missing or NaN confidence must read as not confident.
    if (!pageType || pageType.source !== "model" || !(pageType.confidence >= opts.min_confidence)) {
      return {
        checks: [
          {
            name: "expected-type",
            status: "info",
            message: "Page type not classified with enough confidence to expect structured data",
            details: { inconclusive: true },
          },
        ],
      };
    }

    const family = FAMILIES[pageType.label];
    if (!family) {
      // homepage, legal, pricing, other, unknown, or a label a newer model added.
      return {
        checks: [
          {
            name: "expected-type",
            status: "info",
            message: "No structured data expected for this page type",
            value: pageType.label,
            // The page type comes from a classifier label that can flap between audits (#1031).
            details: { inconclusive: true },
          },
        ],
      };
    }

    const declared = declaredTypes(ctx);
    // The confidence lives in `details`, not the message: reports group findings by
    // message, and a per-page confidence in it would split one finding per page type
    // into one group per confidence value.
    // `pageTypeSource` says the label is the classifier model's, so a report may count the
    // check's pages against `structure.pageTypes` and say "on all 9 documentation pages" (pub#857).
    const details = {
      pageType: pageType.label,
      pageTypeSource: "model",
      confidence: Number(pageType.confidence.toFixed(2)),
      expected: family.wanted,
      declared: [...declared.all.values()],
    };
    const checks: CheckResult[] = [];

    const found = firstMatch(declared.all, family.matches);
    if (found) {
      checks.push({
        name: "expected-type",
        status: "pass",
        message: `${capitalise(family.noun)} declares ${found}`,
        details,
      });
      return { checks };
    }

    if (family.detail) {
      const listing = firstMatch(declared.topLevel, (name) => VETO_TYPES.has(name));
      if (listing) {
        checks.push({
          name: "expected-type",
          status: "pass",
          message: `Page declares ${listing}, read as a listing`,
          details,
        });
        return { checks };
      }
    }

    // A scan that hit a bound proves nothing about what is absent.
    if (!declared.complete) {
      checks.push({
        name: "expected-type",
        status: "info",
        message: UNREADABLE_MESSAGE,
        details: { ...details, inconclusive: true },
      });
      return { checks };
    }

    checks.push({
      name: "expected-type",
      status: "fail",
      message: `Reads as ${withArticle(family.noun)} but declares no ${family.wanted} structured data`,
      details,
    });
    return { checks };
  },
};
