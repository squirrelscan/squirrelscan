// Shared machinery for the thirteen `schema/entity-*` rules (#2093, epic
// section 6).
//
// All thirteen read `ctx.entityMap`, the site's JSON-LD collapsed into one
// graph (#2091), and never the pages. That is the whole point: these are
// questions about the site's identity graph, not about any one page, and the
// map is the only place where "the same Organization on 60 pages" is one thing
// rather than sixty.
//
// Two conventions every rule here follows.
//
// ONE capped check per rule, not a finding per entity. A site that redeclares
// its Organization on 500 pages has one problem, not 500, and the schema
// category score must not be dominated by whichever entity rule happened to
// match the most nodes.
//
// A missing map is a SKIP, never a pass and never a finding. `ctx.entityMap` is
// undefined when no map was built for the run, which is indistinguishable from
// here from a site that declares nothing — and only one of those is worth
// telling the user about.

import type { CheckItem, CheckResult, EntityMap, EntityMapNode } from "../types";

export {
  IDENTITY_TYPES,
  compareStrings,
  groupByIdentity,
  identityOf,
  isLocalBusinessType,
  normaliseName,
  pageTotal,
  primaryOrganization,
  referencedKeys,
} from "@squirrelscan/core-contracts/entity-map-findings";
import { compareStrings, pageTotal } from "@squirrelscan/core-contracts/entity-map-findings";

/** Where every rule's fix text points. */
export const ENTITY_FIX_DOCS = "https://docs.squirrelscan.com/guides/entity-map/fixing";

/**
 * Items listed on one finding before it is truncated.
 *
 * Ten, matching `SCHEMA_NORM_MAX_ITEMS` in `schema/coverage-outlier`. A reader
 * fixing a site-wide identity problem acts on the pattern, not on the hundredth
 * instance, and the full list is a `squirrel entities --problem` away.
 */
export const ENTITY_ITEM_CAP = 10;

/** Declaring pages listed against one item. */
export const ENTITY_PAGE_CAP = 5;





/** What to call an entity in a message: its name, else its type, else its key. */
export function entityLabel(node: EntityMapNode): string {
  if (node.name) return node.name;
  const type = node.types[0];
  return type ? `(unnamed ${type})` : node.key;
}

/** One item per entity, carrying the pages a reader needs to go and look at. */
export function entityItem(
  node: EntityMapNode,
  extra?: Record<string, unknown>
): CheckItem {
  return {
    id: node.key,
    label: `${entityLabel(node)} (${node.types.join(", ") || "no @type"})`,
    sourcePages: node.pages.slice(0, ENTITY_PAGE_CAP),
    meta: {
      types: node.types,
      id: node.id,
      pages: pageTotal(node),
      occurrences: node.occurrences,
      ...extra,
    },
  };
}

/**
 * Cap a list and say what was left out.
 *
 * The count in the message is always the TRUE total, never the capped length:
 * "3 entities" when 40 matched would understate the problem to exactly the
 * reader who most needs the real number.
 */
export function cappedItems(items: CheckItem[]): {
  items: CheckItem[];
  hidden: number;
} {
  return {
    items: items.slice(0, ENTITY_ITEM_CAP),
    hidden: Math.max(0, items.length - ENTITY_ITEM_CAP),
  };
}

/** The suffix a capped message carries, or "" when nothing was cut. */
export function moreSuffix(hidden: number, noun = "entities"): string {
  return hidden > 0 ? ` (+${hidden} more ${noun})` : "";
}

/**
 * Longest `value` a finding carries.
 *
 * `items` is capped at ten, but a `value` built by joining every match is not
 * bounded by that at all: a map with ten thousand publishers would produce a
 * ten-item list beside a megabyte-long summary line, every byte of it chosen by
 * the audited site. Every rule here runs its value through this.
 */
export const ENTITY_VALUE_MAX = 300;

export function clipValue(value: string): string {
  return value.length <= ENTITY_VALUE_MAX
    ? value
    : `${value.slice(0, ENTITY_VALUE_MAX - 1)}…`;
}

/**
 * The check a rule emits when no map was built.
 *
 * `skipped` rather than `pass`: a pass would assert the site has no identity
 * problems, which nothing here has looked at.
 */
export function noMapSkip(checkName: string): CheckResult {
  return {
    name: checkName,
    status: "skipped",
    message: "No entity map was built for this audit",
    skipReason: "entity-map-unavailable",
  };
}

/**
 * The check a rule emits when the map exists and is empty.
 *
 * Distinct from the skip above, and it matters: this one IS a fact about the
 * site. It is reported at info rather than as a finding, because a site with no
 * structured data is behind rather than broken, and `schema/*` has its own
 * rules for what is missing.
 */
export function noEntitiesInfo(checkName: string): CheckResult {
  return {
    name: checkName,
    status: "info",
    message: "This site declares no JSON-LD entities on any crawled page",
    value: `See ${ENTITY_FIX_DOCS}`,
  };
}

/**
 * Resolve the map, or the check to emit instead.
 *
 * Every rule starts with this, so the skip/empty distinction is made in exactly
 * one place rather than thirteen.
 */
export function requireMap(
  map: EntityMap | undefined,
  checkName: string
): { map: EntityMap } | { checks: CheckResult[] } {
  if (!map) return { checks: [noMapSkip(checkName)] };
  if (map.nodes.length === 0) return { checks: [noEntitiesInfo(checkName)] };
  return { map };
}

export function isMapResolved(
  result: { map: EntityMap } | { checks: CheckResult[] }
): result is { map: EntityMap } {
  return "map" in result;
}

/** Entities sorted the way every finding lists them: widest reach first. */
export function byReach(a: EntityMapNode, b: EntityMapNode): number {
  return pageTotal(b) - pageTotal(a) || compareStrings(a.key, b.key);
}
