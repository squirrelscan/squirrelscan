// schema/entity-split-identity — one thing declared under two or more `@id`s.

import type { EntityMapNode, Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  cappedItems,
  compareStrings,
  entityItem,
  entityLabel,
  groupByIdentity,
  isMapResolved,
  moreSuffix,
  pageTotal,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-split-identity";

export const entitySplitIdentityRule: Rule = {
  meta: {
    id: "schema/entity-split-identity",
    name: "Split Entity Identity",
    description:
      "Finds one entity declared under two or more different @ids, which a search engine reads as two different things",
    solution: `Two plugins, or a plugin and a hand-written block, are each declaring the same thing under their own @id. The classic pair is Yoast's https://yoursite.com/#organization alongside WordLift's data.wordlift.io identifier. A search engine has no way to know they are one entity, so your reviews, sameAs profiles and article authorship split between them and neither is complete. Pick one @id as canonical, and either delete the second declaration or reduce it to a sameAs on the first. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "error",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    // A split needs two or more DISTINCT stable ids. Two entities sharing an
    // identity signature where one or both have no `@id` are a different
    // finding — `schema/entity-identity` owns that, and reporting both would
    // bill one defect twice.
    const splits: Array<{ nodes: EntityMapNode[]; ids: string[] }> = [];
    for (const group of groupByIdentity(map).values()) {
      if (group.length < 2) continue;
      const ids = [...new Set(group.map((node) => node.id).filter((id): id is string => id !== null))].sort(
        compareStrings
      );
      if (ids.length < 2) continue;
      splits.push({ nodes: [...group].sort((a, b) => pageTotal(b) - pageTotal(a)), ids });
    }
    splits.sort(
      (a, b) =>
        pageTotal(b.nodes[0]!) - pageTotal(a.nodes[0]!) ||
        compareStrings(a.nodes[0]!.key, b.nodes[0]!.key)
    );

    if (splits.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "No entity is declared under more than one @id",
          },
        ],
      };
    }

    // One item per DECLARATION rather than per split, so the reader sees both
    // sides of each pair and can tell which to keep from the page counts.
    const { items, hidden } = cappedItems(
      splits.flatMap((split) =>
        split.nodes.map((node) => entityItem(node, { sharesIdentityWith: split.ids }))
      )
    );
    const worst = splits[0]!;

    return {
      checks: [
        {
          name: CHECK,
          status: "fail",
          message: `${splits.length} ${splits.length === 1 ? "entity is" : "entities are"} declared under more than one @id${moreSuffix(hidden, "declarations")}`,
          value: `${entityLabel(worst.nodes[0]!)} under ${worst.ids.length}: ${worst.ids.join(", ")}`,
          expected: "one @id per entity",
          items,
        },
      ],
    };
  },
};
