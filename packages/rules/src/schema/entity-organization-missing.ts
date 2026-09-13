// schema/entity-organization-missing — a business with no organization entity.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  isLocalBusinessType,
  isMapResolved,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-organization-missing";

/** Page entities that say the site presents a business identity. */
const BUSINESS_PAGE_TYPES = ["AboutPage", "ContactPage"];

export const entityOrganizationMissingRule: Rule = {
  meta: {
    id: "schema/entity-organization-missing",
    name: "Organization Entity",
    description:
      "Finds a site that presents as a business but declares no Organization or LocalBusiness entity",
    solution: `This site has the pages a business has, an about page or a contact page, and no Organization or LocalBusiness entity for a search engine to attach any of it to. Declare the organization once, with an @id, a name, a url, a logo and a sameAs entry for every profile you control. It is the node everything else on the site hangs off: the publisher of your articles, the owner of your WebSite, the subject of your reviews. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    const organizations = map.nodes.filter((node) =>
      node.types.some(
        (type) =>
          type === "Organization" || type === "Corporation" || isLocalBusinessType(type)
      )
    );

    if (organizations.length > 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `This site declares ${organizations.length} organization ${organizations.length === 1 ? "entity" : "entities"}`,
          },
        ],
      };
    }

    // No organization. Only a finding when the site presents as a business —
    // a personal blog or a documentation site legitimately has none, and
    // telling it to invent one would be advice to add markup that is not true.
    const signals: string[] = [];
    const businessPages = map.nodes.filter((node) =>
      node.types.some((type) => BUSINESS_PAGE_TYPES.includes(type))
    );
    if (businessPages.length > 0) {
      signals.push(
        `${businessPages.length} ${businessPages.length === 1 ? "page declares" : "pages declare"} ${[
          ...new Set(businessPages.flatMap((node) => node.types)),
        ]
          .filter((type) => BUSINESS_PAGE_TYPES.includes(type))
          .sort()
          .join(" / ")}`
      );
    }
    // A Product or an Offer without a seller is the other common shape: the
    // site is transacting and nothing says who with.
    const commerce = map.nodes.filter((node) =>
      node.types.some((type) => type === "Product" || type === "Offer")
    );
    if (commerce.length > 0) {
      signals.push(
        `${commerce.length} product or offer ${commerce.length === 1 ? "entity" : "entities"}`
      );
    }

    if (signals.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "skipped",
            message: "This site does not present as a business",
            skipReason: "no-business-signals",
          },
        ],
      };
    }

    return {
      checks: [
        {
          name: CHECK,
          status: "info",
          message: "This site presents as a business but declares no Organization or LocalBusiness entity",
          value: signals.join(", "),
          expected: "one Organization or LocalBusiness with @id, name, url, logo and sameAs",
        },
      ],
    };
  },
};
