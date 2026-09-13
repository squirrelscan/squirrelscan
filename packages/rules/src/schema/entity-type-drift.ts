// schema/entity-type-drift — one `@id` declared with different `@type` sets.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  byReach,
  cappedItems,
  clipValue,
  entityItem,
  entityLabel,
  isMapResolved,
  moreSuffix,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-type-drift";

/**
 * Render a recorded type set for a human.
 *
 * The builder stores it as `JSON.stringify(sortedTypes)` so that a `@type`
 * containing a comma cannot forge a different set. That is the right storage
 * and the wrong thing to put in a message, so it is turned back here.
 */
function readTypeSet(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed.join(", ");
    }
  } catch {
    // Older maps stored the joined form; show it as-is.
  }
  return value;
}

export const entityTypeDriftRule: Rule = {
  meta: {
    id: "schema/entity-type-drift",
    name: "Entity Type Drift",
    description:
      "Finds one @id declared with different @type sets on different pages",
    solution: `The same @id is an Organization on one page and an Organization plus LocalBusiness on another. A search engine merges the declarations by id and is then left deciding which type set is authoritative, which affects which rich results the entity is eligible for. Pick one type set and emit it identically everywhere: if the entity is a LocalBusiness, say so on every page that declares it, not only on the contact page. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    // The builder records drift as a `@type` conflict on the node, because it
    // merges by `@id` first and only then notices the type sets differ. Reading
    // it off `conflicts` rather than re-deriving keeps this rule and the map's
    // own summary from ever disagreeing.
    const offenders = map.nodes
      .filter(
        (node) =>
          node.id !== null &&
          node.conflicts.some((conflict) => conflict.property === "@type")
      )
      .sort(byReach);

    if (offenders.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "Every @id carries the same @type set on every page",
          },
        ],
      };
    }

    const { items, hidden } = cappedItems(
      offenders.map((node) => {
        const drift = node.conflicts.find((conflict) => conflict.property === "@type");
        return entityItem(node, {
          declaredTypeSets: drift?.values.map((value) => readTypeSet(value.value)) ?? [],
        });
      })
    );
    const worst = offenders[0]!;
    const worstDrift = worst.conflicts.find((conflict) => conflict.property === "@type");

    return {
      checks: [
        {
          name: CHECK,
          status: "warn",
          message: `${offenders.length} ${offenders.length === 1 ? "entity is" : "entities are"} declared with more than one @type set${moreSuffix(hidden)}`,
          value: clipValue(`${entityLabel(worst)}: ${(worstDrift?.values ?? []).map((value) => readTypeSet(value.value)).join(" vs ")}`),
          expected: "one @type set per @id",
          items,
        },
      ],
    };
  },
};
