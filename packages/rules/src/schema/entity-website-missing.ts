// schema/entity-website-missing — no WebSite node tying the pages together.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  cappedItems,
  clipValue,
  compareStrings,
  entityLabel,
  isMapResolved,
  moreSuffix,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-website-missing";

/**
 * Page-level entities expected to carry `isPartOf`.
 *
 * An explicit list of the `WebPage` and `Article` subtypes generators actually
 * emit. It is not every subtype schema.org defines, and a type outside it means
 * the rule says nothing rather than guessing — saying nothing is the safe
 * direction for a check about markup someone chose deliberately.
 */
const PAGE_TYPES = [
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
  "RealEstateListing",
  "SearchResultsPage",
  "Article",
  "AdvertiserContentArticle",
  "BlogPosting",
  "LiveBlogPosting",
  "NewsArticle",
  "Report",
  "ScholarlyArticle",
  "SatiricalArticle",
  "TechArticle",
];

export const entityWebsiteMissingRule: Rule = {
  meta: {
    id: "schema/entity-website-missing",
    name: "WebSite Entity",
    description:
      "Finds a site with no WebSite entity, or page entities that do not link back to it with isPartOf",
    solution: `A WebSite node is what says "these pages are one site" and what carries the site name a search engine shows above a result. Declare it once with an @id, a url, a name and a publisher, then have every WebPage and Article reference it with isPartOf: { "@id": "…" }. Without the isPartOf links the WebSite exists but nothing is attached to it, which is most of the way to not having one. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    const websites = map.nodes.filter((node) => node.types.includes("WebSite"));
    const identified = websites.filter((node) => node.id !== null);

    if (websites.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "info",
            message: "This site declares no WebSite entity",
            value: "no WebSite node",
            expected: "one WebSite with @id, url, name and publisher",
          },
        ],
      };
    }

    if (identified.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "info",
            message: "The WebSite entity has no @id, so nothing can reference it",
            value: entityLabel(websites[0]!),
            expected: "an absolute @id on the WebSite",
          },
        ],
      };
    }

    // A WebSite exists and is referenceable. The remaining question is whether
    // the pages actually point at it.
    const websiteKeys = new Set(identified.map((node) => node.key));
    const linkedSources = new Set(
      map.edges
        .filter((edge) => edge.predicate === "isPartOf" && websiteKeys.has(edge.target))
        .map((edge) => edge.source)
    );

    const pageNodes = map.nodes.filter((node) =>
      node.types.some((type) => PAGE_TYPES.includes(type))
    );
    if (pageNodes.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "A WebSite entity is declared with an @id",
          },
        ],
      };
    }

    const unlinked = pageNodes
      .filter((node) => !linkedSources.has(node.key))
      .sort((a, b) => compareStrings(a.key, b.key));

    if (unlinked.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `A WebSite entity is declared and all ${pageNodes.length} page ${pageNodes.length === 1 ? "entity links" : "entities link"} to it`,
          },
        ],
      };
    }

    const { items, hidden } = cappedItems(
      unlinked.map((node) => ({
        id: node.key,
        label: `${entityLabel(node)} (${node.types.join(", ")})`,
        sourcePages: node.pages.slice(0, 5),
        meta: { key: node.key },
      }))
    );

    return {
      checks: [
        {
          name: CHECK,
          status: "info",
          message: `${unlinked.length} of ${pageNodes.length} page ${unlinked.length === 1 ? "entity does" : "entities do"} not link to the WebSite with isPartOf${moreSuffix(hidden, "pages")}`,
          value: items[0]?.label ? clipValue(items[0].label) : null,
          expected: "isPartOf on every page entity",
          items,
        },
      ],
    };
  },
};
