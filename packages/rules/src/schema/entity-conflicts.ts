// schema/entity-conflicts — one entity disagreeing with itself across pages.

import type { CheckItem, Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  ENTITY_PAGE_CAP,
  cappedItems,
  clipValue,
  compareStrings,
  entityLabel,
  isMapResolved,
  moreSuffix,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-conflicts";

/** Values listed for one conflicting property before the item is truncated. */
const VALUE_CAP = 3;

/** Owned by `schema/entity-type-drift`, so excluded here. */
const TYPE_PROPERTY = "@type";

export const entityConflictsRule: Rule = {
  meta: {
    id: "schema/entity-conflicts",
    name: "Entity Property Conflicts",
    description:
      "Finds an entity whose name, logo, url, sameAs, telephone, address or email differs between the pages that declare it",
    solution: `The same entity is declared on several pages with different values for the same property, so there is no single answer to "what is this organization's logo". A search engine picks one, and which one is not yours to choose. Converge on the canonical value. The durable fix is to stop repeating the declaration at all: declare the entity once with an @id and reference it by { "@id": "…" } from the other pages, which makes disagreement impossible rather than merely absent. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    // One item per (entity, property) pair, not per entity: an organization
    // whose logo AND telephone disagree has two things to fix, and collapsing
    // them would hide the second behind the first.
    //
    // `@type` rides the same conflict channel but is NOT reported here: it is
    // `schema/entity-type-drift`'s finding, and billing one defect to two rules
    // would double its weight against the schema score.
    const rows: CheckItem[] = [];
    let entityCount = 0;
    for (const node of [...map.nodes].sort((a, b) => compareStrings(a.key, b.key))) {
      const conflicts = node.conflicts.filter(
        (conflict) => conflict.property !== TYPE_PROPERTY
      );
      if (conflicts.length === 0) continue;
      entityCount += 1;
      for (const conflict of conflicts) {
        const values = conflict.values
          .slice(0, VALUE_CAP)
          .map((value) => `${value.value} (${value.pages.length + value.morePages} pages)`);
        rows.push({
          id: `${node.key} ${conflict.property}`,
          label: `${entityLabel(node)} — ${conflict.property}: ${values.join(" vs ")}`,
          sourcePages: conflict.values
            .flatMap((value) => value.pages)
            .slice(0, ENTITY_PAGE_CAP),
          meta: {
            key: node.key,
            property: conflict.property,
            valueCount: conflict.values.length,
          },
        });
      }
    }

    if (rows.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "Every entity agrees with itself across the pages that declare it",
          },
        ],
      };
    }

    const { items, hidden } = cappedItems(rows);

    return {
      checks: [
        {
          name: CHECK,
          status: "warn",
          message: `${rows.length} ${rows.length === 1 ? "property disagrees" : "properties disagree"} across pages, on ${entityCount} ${entityCount === 1 ? "entity" : "entities"}${moreSuffix(hidden, "properties")}`,
          value: items[0]?.label ? clipValue(items[0].label) : null,
          expected: "one value per property per entity",
          items,
        },
      ],
    };
  },
};
