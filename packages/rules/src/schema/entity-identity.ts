// schema/entity-identity — the same thing declared on many pages with no `@id`.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  IDENTITY_TYPES,
  byReach,
  cappedItems,
  clipValue,
  entityItem,
  entityLabel,
  isMapResolved,
  moreSuffix,
  pageTotal,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-identity";

export const entityIdentityRule: Rule = {
  meta: {
    id: "schema/entity-identity",
    name: "Entity Identity",
    description:
      "Finds an Organization, LocalBusiness, Person or WebSite declared on many pages with no @id to tie the declarations together",
    solution: `Your site declares the same thing on page after page without an @id, so nothing says they are one thing. A search engine reading 60 pages sees 60 separate organizations, and none of them accumulates the authority of the others. Give the entity one absolute @id, something like https://yoursite.com/#organization, declare it in full once per page, and reference it by { "@id": "…" } everywhere else. The fragment is arbitrary; what matters is that it is absolute and identical on every page. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    // Named, multi-page, no `@id`, and of a type a search engine reconciles
    // site-wide. A one-page entity with no `@id` is ordinary, not a problem:
    // there is only one declaration, so there is nothing to tie together.
    const offenders = map.nodes
      .filter(
        (node) =>
          node.id === null &&
          node.name !== null &&
          pageTotal(node) > 1 &&
          node.types.some((type) =>
            (IDENTITY_TYPES as readonly string[]).includes(type)
          )
      )
      .sort(byReach);

    if (offenders.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "Every multi-page identity entity carries an @id",
          },
        ],
      };
    }

    const { items, hidden } = cappedItems(offenders.map((node) => entityItem(node)));
    const worst = offenders[0]!;

    return {
      checks: [
        {
          name: CHECK,
          status: "fail",
          message: `${offenders.length} ${offenders.length === 1 ? "entity is" : "entities are"} declared on several pages with no @id${moreSuffix(hidden)}`,
          value: clipValue(`${entityLabel(worst)} on ${pageTotal(worst)} pages`),
          expected: "one absolute @id per entity, referenced elsewhere",
          items,
        },
      ],
    };
  },
};
