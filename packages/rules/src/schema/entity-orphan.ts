// schema/entity-orphan — an entity nothing references and nothing reuses.

import type { Rule, RuleContext, RuleResult } from "../types";

import { isOrphanNode } from "@squirrelscan/core-contracts/entity-map-findings";

import {
  ENTITY_FIX_DOCS,
  cappedItems,
  compareStrings,
  entityItem,
  entityLabel,
  isMapResolved,
  moreSuffix,
  referencedKeys,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-orphan";


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
      .filter((node) => isOrphanNode(node, referenced))
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
