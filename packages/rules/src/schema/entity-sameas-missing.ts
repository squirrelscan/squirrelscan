// schema/entity-sameas-missing — an organization with no sameAs profiles.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  entityLabel,
  isMapResolved,
  pageTotal,
  primaryOrganization,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-sameas-missing";

export const entitySameAsMissingRule: Rule = {
  meta: {
    id: "schema/entity-sameas-missing",
    name: "Organization sameAs",
    description:
      "Finds a primary Organization or LocalBusiness with no sameAs links to the profiles that identify it",
    solution: `sameAs is how you tell a search engine that the organization on this site is the same one as the LinkedIn company page, the Wikipedia article, the Crunchbase entry and the X account. Without it the entity on your site is unconnected to everything that corroborates it, which is the evidence a knowledge panel is assembled from. Add a sameAs array to the organization listing every profile you control, using the canonical URL of each rather than a redirect. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    const primary = primaryOrganization(map);
    if (!primary) {
      // `schema/entity-organization-missing` owns the "no organization at all"
      // finding. Reporting it here too would bill one defect twice.
      return {
        checks: [
          {
            name: CHECK,
            status: "skipped",
            message: "This site declares no organization entity",
            skipReason: "no-organization",
          },
        ],
      };
    }

    const sameAs = (primary.properties as Record<string, unknown>).sameAs;
    const profiles = Array.isArray(sameAs)
      ? sameAs.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : typeof sameAs === "string" && sameAs.length > 0
        ? [sameAs]
        : [];

    if (profiles.length > 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `${entityLabel(primary)} links to ${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"} with sameAs`,
          },
        ],
      };
    }

    return {
      checks: [
        {
          name: CHECK,
          status: "info",
          message: `${entityLabel(primary)} has no sameAs profiles`,
          value: `declared on ${pageTotal(primary)} ${pageTotal(primary) === 1 ? "page" : "pages"}`,
          expected: "sameAs listing every profile the organization controls",
          items: [
            {
              id: primary.key,
              label: `${entityLabel(primary)} (${primary.types.join(", ")})`,
              sourcePages: primary.pages.slice(0, 5),
              meta: { key: primary.key, id: primary.id },
            },
          ],
        },
      ],
    };
  },
};
