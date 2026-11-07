// schema/entity-conflicts — one entity disagreeing with itself across pages.

import type { EntityMapConflict } from "@squirrelscan/core-contracts";

import type { CheckItem, EntityMap, EntityMapNode, Rule, RuleContext, RuleResult } from "../types";

import { RegionVariantIndex, identity } from "../shared/region-variants";
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

/** The one property a verified localized alias may differ on (#1615). */
const URL_PROPERTY = "url";

/**
 * Predicates that say who is behind an entity. A localized alias must carry every one of these on
 * every alias page, to the same target: a Service whose provider differs between two locales is
 * two services, not one service with two URLs.
 */
const IDENTITY_PREDICATES: ReadonlySet<string> = new Set([
  "provider",
  "brand",
  "publisher",
  "creator",
  "author",
  "worksFor",
  "member",
]);

/** Most pages one alias check compares. Pairs grow with the square, and a bigger set is not provably an alias. */
const ALIAS_PAGE_CAP = 40;

/** The node's reportable conflicts: everything but `@type`, which `schema/entity-type-drift` owns. */
const reportable = (node: EntityMapNode): EntityMapConflict[] =>
  node.conflicts.filter((conflict) => conflict.property !== TYPE_PROPERTY);

/**
 * A node whose only disagreement is its `url`: the one case an alias can explain. An entity that
 * also disagrees about its name, telephone, a legal identifier or anything else may be two
 * entities, so it is never excused.
 */
function urlOnlyConflict(node: EntityMapNode): EntityMapConflict | null {
  const conflicts = reportable(node);
  const only = conflicts.length === 1 ? conflicts[0]! : null;
  return only && only.property === URL_PROPERTY ? only : null;
}

/**
 * Whether a `url` conflict is one entity served under localized URLs (#1615). Every check is
 * conservative, and identity is never inferred from names:
 *
 * - every page that declares a value is known (none past the page cap);
 * - each `url` value is the address of one of the declaring pages, so the value names the page
 *   itself and not some other site or section;
 * - every pair of pages that declare different values lists each other as hreflang alternates
 *   (reciprocal, neither canonicalised elsewhere);
 * - the node's provider, brand, publisher, creator, author, worksFor and member edges are present
 *   on every one of those pages.
 */
function isLocalizedUrlAlias(
  node: EntityMapNode,
  conflict: EntityMapConflict,
  edges: EntityMap["edges"],
  index: RegionVariantIndex,
): boolean {
  if (conflict.values.some((value) => value.morePages > 0)) return false;
  const pages = [...new Set(conflict.values.flatMap((value) => value.pages))];
  if (pages.length > ALIAS_PAGE_CAP) return false;

  const pageIds = new Set(pages.map((page) => identity(page)));
  for (const value of conflict.values) {
    const id = identity(value.value);
    if (id === null || !pageIds.has(id)) return false;
  }

  for (let i = 0; i < conflict.values.length; i += 1) {
    for (let j = i + 1; j < conflict.values.length; j += 1) {
      for (const a of conflict.values[i]!.pages) {
        for (const b of conflict.values[j]!.pages) {
          if (!index.areReciprocalAlternates(a, b)) return false;
        }
      }
    }
  }

  for (const edge of edges) {
    if (edge.source !== node.key || !IDENTITY_PREDICATES.has(edge.predicate)) continue;
    const listed = new Set(edge.pages);
    if (!pages.every((page) => listed.has(page))) return false;
  }
  return true;
}

/** Keys of the nodes whose `url` conflict is a verified localized alias. */
async function localizedAliasNodes(ctx: RuleContext, map: EntityMap): Promise<Set<string>> {
  const candidates = map.nodes.filter((node) => urlOnlyConflict(node) !== null);
  const aliases = new Set<string>();
  if (candidates.length === 0) return aliases;

  const urls = candidates.flatMap((node) => urlOnlyConflict(node)!.values.flatMap((v) => v.pages));
  const index = ctx.siteQuery
    ? await RegionVariantIndex.fromSiteQueryByIdentity(ctx.siteQuery, urls)
    : RegionVariantIndex.fromPagesByIdentity(ctx.site?.pages ?? [], urls);

  for (const node of candidates) {
    if (isLocalizedUrlAlias(node, urlOnlyConflict(node)!, map.edges, index)) aliases.add(node.key);
  }
  return aliases;
}

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

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;
    // Only a node whose sole disagreement is `url` can be an alias, so every other map is judged
    // synchronously, as before.
    if (!map.nodes.some((node) => urlOnlyConflict(node) !== null)) return judge(map, new Set());
    return localizedAliasNodes(ctx, map).then((aliases) => judge(map, aliases));
  },
};

function judge(map: EntityMap, aliases: ReadonlySet<string>): RuleResult {
  // One item per (entity, property) pair, not per entity: an organization
  // whose logo AND telephone disagree has two things to fix, and collapsing
  // them would hide the second behind the first.
  //
  // `@type` rides the same conflict channel but is NOT reported here: it is
  // `schema/entity-type-drift`'s finding, and billing one defect to two rules
  // would double its weight against the schema score.
  const rows: CheckItem[] = [];
  let entityCount = 0;
  let aliasCount = 0;
  for (const node of [...map.nodes].sort((a, b) => compareStrings(a.key, b.key))) {
    // A verified localized alias is one entity under several URLs, not a disagreement (#1615).
    if (aliases.has(node.key)) {
      aliasCount += 1;
      continue;
    }
    const conflicts = reportable(node);
    if (conflicts.length === 0) continue;
    entityCount += 1;
    for (const conflict of conflicts) {
      const values = conflict.values
        .slice(0, VALUE_CAP)
        .map((value) => `${value.value} (${value.pages.length + value.morePages} pages)`);
      rows.push({
        id: `${node.key} ${conflict.property}`,
        label: `${entityLabel(node)} — ${conflict.property}: ${values.join(" vs ")}`,
        sourcePages: conflict.values.flatMap((value) => value.pages).slice(0, ENTITY_PAGE_CAP),
        meta: {
          key: node.key,
          property: conflict.property,
          valueCount: conflict.values.length,
        },
      });
    }
  }
  const details = aliasCount > 0 ? { localizedUrlAliases: aliasCount } : undefined;

  if (rows.length === 0) {
    return {
      checks: [
        {
          name: CHECK,
          status: "pass",
          message: "Every entity agrees with itself across the pages that declare it",
          ...(details ? { details } : {}),
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
        ...(details ? { details } : {}),
      },
    ],
  };
}
