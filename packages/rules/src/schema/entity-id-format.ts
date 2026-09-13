// schema/entity-id-format — `@id`s that are not absolute URLs.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  byReach,
  cappedItems,
  entityItem,
  entityLabel,
  isMapResolved,
  moreSuffix,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-id-format";

export const entityIdFormatRule: Rule = {
  meta: {
    id: "schema/entity-id-format",
    name: "Entity @id Format",
    description:
      "Finds an @id that is not an absolute URL, which makes the entity page-local rather than site-wide",
    solution: `A bare fragment like "#organization" is resolved against the page it appears on, so "#organization" on your homepage and "#organization" on your about page are two different identifiers, not one shared one. The markup looks correct and validates, and the entity still fails to accumulate across the site. Write @id as an absolute URL, https://yoursite.com/#organization, identical on every page. Relative and protocol-relative forms have the same problem. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    // The builder resolves a relative `@id` against its page, so what reaches
    // here is already absolute in the common case. What survives as non-
    // absolute is an `@id` that could not be resolved at all — a bare word, a
    // urn, a mailto — plus blank nodes the site wrote itself.
    const offenders = map.nodes
      .filter((node) => node.id !== null && !isAbsoluteHttpUrl(node.id))
      .sort(byReach);

    if (offenders.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "Every @id is an absolute URL",
          },
        ],
      };
    }

    const { items, hidden } = cappedItems(
      offenders.map((node) => entityItem(node, { rawId: node.id }))
    );
    const worst = offenders[0]!;

    return {
      checks: [
        {
          name: CHECK,
          status: "warn",
          message: `${offenders.length} ${offenders.length === 1 ? "@id is" : "@ids are"} not an absolute URL${moreSuffix(hidden)}`,
          value: `${entityLabel(worst)}: ${worst.id}`,
          expected: "an absolute https:// URL",
          items,
        },
      ],
    };
  },
};

/**
 * True for an http(s) URL with a host.
 *
 * `new URL` accepts `urn:`, `mailto:` and `data:` as absolute, and an `@id` of
 * `mailto:hi@site.com` is not the identifier a search engine reconciles a site
 * by, so the scheme is checked rather than merely parsed.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host !== "";
}
