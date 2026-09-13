// schema/entity-orphan — an entity nothing references and nothing reuses.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  cappedItems,
  compareStrings,
  entityItem,
  entityLabel,
  isMapResolved,
  moreSuffix,
  pageTotal,
  referencedKeys,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-orphan";

/**
 * Types that describe or ARE the page they sit on, and are correctly
 * unreferenced.
 *
 * Two groups, and the second is the one that matters. A `WebPage`, its
 * `BreadcrumbList`, its `FAQPage` describe the page: nothing else on the site
 * should point at them. An `Article` is the page's own subject: it is what the
 * page is, and expecting some other node to reference it is backwards.
 *
 * Without the second group this rule fires on every blog post on the web.
 * Measured against a real 40-page crawl of kinsta.com, 73 of the 79 entities it
 * would otherwise report were breadcrumbs and articles — noise that would have
 * buried the six findings worth reading.
 */
const PAGE_SUBJECT_TYPES = [
  // Describe the page.
  "WebPage",
  "ItemPage",
  "CollectionPage",
  "AboutPage",
  "ContactPage",
  "CheckoutPage",
  "SearchResultsPage",
  "ProfilePage",
  "BreadcrumbList",
  "FAQPage",
  "Question",
  "Answer",
  "SiteNavigationElement",
  "WPHeader",
  "WPFooter",
  "WPSideBar",
  // Are the page.
  "Article",
  "NewsArticle",
  "BlogPosting",
  "TechArticle",
  "ScholarlyArticle",
  "Report",
  "LiveBlogPosting",
  "Recipe",
  "HowTo",
];

export const entityOrphanRule: Rule = {
  meta: {
    id: "schema/entity-orphan",
    name: "Orphan Entities",
    description:
      "Finds an entity with a stable @id that nothing references and that appears on one page only",
    solution: `This entity was given an @id, which is the expensive part, and then nothing was connected to it. An @id exists so other nodes can point at it; one that nothing points at and that appears on a single page is doing no more than an inline block would. Either reference it from the nodes it belongs to, using about, mainEntity, author or publisher as appropriate, or drop the @id and inline it. Neither is worse than the current state, and both are clearer. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "info",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    const referenced = referencedKeys(map);
    const orphans = map.nodes
      .filter(
        (node) =>
          node.id !== null &&
          !referenced.has(node.key) &&
          pageTotal(node) === 1 &&
          // The builder's own verdict on "this describes one page", plus a type
          // list for the shapes it does not catch. Both, because a site can
          // name its WebPage node and defeat the heuristic.
          !node.pageLocal &&
          !node.types.some((type) => PAGE_SUBJECT_TYPES.includes(type))
      )
      .sort((a, b) => compareStrings(a.key, b.key));

    if (orphans.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "Every entity with an @id is referenced or spans more than one page",
          },
        ],
      };
    }

    const { items, hidden } = cappedItems(orphans.map((node) => entityItem(node)));

    return {
      checks: [
        {
          name: CHECK,
          status: "info",
          message: `${orphans.length} ${orphans.length === 1 ? "entity has" : "entities have"} an @id that nothing references, on one page each${moreSuffix(hidden)}`,
          value: entityLabel(orphans[0]!),
          expected: "referenced by another node, or inlined without an @id",
          items,
        },
      ],
    };
  },
};
