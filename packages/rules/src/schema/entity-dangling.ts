// schema/entity-dangling — a reference to an `@id` nothing declares.

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

const CHECK = "entity-dangling";

/**
 * Predicates whose target is expected to live somewhere else entirely.
 *
 * `sameAs` names the same thing on another site: Wikidata, LinkedIn, a company
 * register. It resolving to nothing in this crawl is correct, not broken.
 */
const EXTERNAL_BY_DESIGN: ReadonlySet<string> = new Set(["sameAs"]);

/** `id:<resolved @id>` is how the builder keys an entity that has one. */
function targetId(key: string): string {
  return key.startsWith("id:") ? key.slice(3) : key;
}

export const entityDanglingRule: Rule = {
  meta: {
    id: "schema/entity-dangling",
    name: "Dangling Entity References",
    description:
      "Finds a JSON-LD reference pointing at an @id that no crawled page declares",
    solution: `A node references another by { "@id": "…" } and no page in the crawl declares that id, so the reference resolves to nothing. The usual cause is a publisher or author declared in full on the homepage only while every article points at it: the article pages carry the pointer without the thing it points to, and a search engine reading one article in isolation cannot follow it. Declare the target in the @graph of every page that references it, which costs a few hundred bytes and is what Yoast and Rank Math already do. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "error",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    // `dangling` is the builder's own verdict, reached after resolving every
    // declaration in the crawl. Re-deriving it here from `nodes` would be a
    // second, worse answer: the builder saw page-scoped and blank-node ids that
    // the finished document no longer distinguishes.
    //
    // `sameAs` is excluded, because pointing somewhere this site does not
    // declare is the entire purpose of it. An Organization whose
    // `sameAs` names its Wikidata entity is doing the recommended thing, and
    // reporting that as a broken reference would be advice to stop.
    const dangling = map.edges.filter(
      (edge) => edge.dangling && !EXTERNAL_BY_DESIGN.has(edge.predicate)
    );

    if (dangling.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "Every @id reference resolves to a declaration",
          },
        ],
      };
    }

    const byKey = new Map(map.nodes.map((node) => [node.key, node] as const));

    // Grouped by TARGET, because one undeclared publisher referenced from 300
    // article pages is one thing to fix, not 300.
    const byTarget = new Map<string, { predicates: Set<string>; sources: Set<string>; pages: string[] }>();
    for (const edge of dangling) {
      const entry = byTarget.get(edge.target) ?? {
        predicates: new Set<string>(),
        sources: new Set<string>(),
        pages: [],
      };
      entry.predicates.add(edge.predicate);
      entry.sources.add(edge.source);
      for (const page of edge.pages) if (!entry.pages.includes(page)) entry.pages.push(page);
      byTarget.set(edge.target, entry);
    }

    const rows: CheckItem[] = [...byTarget.entries()]
      .sort((a, b) => b[1].sources.size - a[1].sources.size || compareStrings(a[0], b[0]))
      .map(([target, entry]) => {
        const sourceLabels = [...entry.sources]
          .sort(compareStrings)
          .slice(0, 3)
          .map((key) => {
            const node = byKey.get(key);
            return node ? entityLabel(node) : key;
          });
        return {
          id: target,
          label: `${targetId(target)} — referenced as ${[...entry.predicates].sort(compareStrings).join(", ")} by ${sourceLabels.join(", ")}`,
          sourcePages: entry.pages.slice(0, ENTITY_PAGE_CAP),
          meta: {
            target: targetId(target),
            predicates: [...entry.predicates].sort(compareStrings),
            referencingEntities: entry.sources.size,
          },
        };
      });

    const { items, hidden } = cappedItems(rows);

    return {
      checks: [
        {
          name: CHECK,
          status: "fail",
          message: `${rows.length} referenced ${rows.length === 1 ? "@id resolves" : "@ids resolve"} to nothing declared on any crawled page${moreSuffix(hidden, "targets")}`,
          value: items[0]?.label ? clipValue(items[0].label) : null,
          expected: "every referenced @id declared on the pages that reference it",
          items,
        },
      ],
    };
  },
};
