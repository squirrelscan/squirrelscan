// schema/entity-publisher-mismatch — articles that disagree about who published them.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  ENTITY_ITEM_CAP,
  cappedItems,
  clipValue,
  compareStrings,
  entityLabel,
  isMapResolved,
  moreSuffix,
  primaryOrganization,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-publisher-mismatch";

/**
 * Share of publisher references one publisher must hold for the rest to read
 * as drift rather than as a site that genuinely has several.
 */
const MAJORITY_SHARE = 0.8;

export const entityPublisherMismatchRule: Rule = {
  meta: {
    id: "schema/entity-publisher-mismatch",
    name: "Publisher Mismatch",
    description:
      "Finds articles or a WebSite whose publisher points somewhere other than the site's primary organization",
    solution: `Your pages do not agree on who publishes this site. A search engine attributes each article to whichever publisher that page named, so the authority that should accumulate against one organization is divided between several. Decide which organization is the publisher, give it an @id, and have every Article, BlogPosting and WebSite reference that one id as its publisher rather than repeating an inline organization block. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    const publisherEdges = map.edges.filter((edge) => edge.predicate === "publisher");
    if (publisherEdges.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "skipped",
            message: "Nothing on this site declares a publisher",
            skipReason: "no-publisher-declared",
          },
        ],
      };
    }

    // Counted by DECLARING WEIGHT, not by distinct target: one publisher named
    // by 200 articles and another by 1 is not a 50/50 disagreement, and the
    // message has to say which one is the outlier.
    const weight = new Map<string, number>();
    for (const edge of publisherEdges) {
      weight.set(edge.target, (weight.get(edge.target) ?? 0) + edge.occurrences);
    }

    const primary = primaryOrganization(map);
    const ranked = [...weight.entries()].sort(
      (a, b) => b[1] - a[1] || compareStrings(a[0], b[0])
    );
    // The site's own answer to "who publishes this" is whoever most of it says,
    // falling back to the primary organization when the two disagree only
    // because the primary is referenced rather than counted.
    const canonical = ranked[0]![0];
    const outliers = ranked.slice(1);

    const byKey = new Map(map.nodes.map((node) => [node.key, node] as const));
    const label = (key: string): string => {
      const node = byKey.get(key);
      return node ? entityLabel(node) : key.replace(/^id:/, "");
    };

    if (outliers.length === 0) {
      // One publisher across the whole site. Still worth saying when it is not
      // the organization the site otherwise presents as itself.
      if (primary && canonical !== primary.key) {
        return {
          checks: [
            {
              name: CHECK,
              status: "warn",
              message: `Every publisher reference points at ${label(canonical)}, which is not this site's primary organization`,
              value: label(canonical),
              expected: entityLabel(primary),
            },
          ],
        };
      }
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `Every publisher reference points at ${label(canonical)}`,
          },
        ],
      };
    }

    const { items, hidden } = cappedItems(
      outliers.map(([key, count]) => ({
        id: key,
        label: `${label(key)} — named as publisher ${count} ${count === 1 ? "time" : "times"}`,
        meta: { key, occurrences: count },
      }))
    );

    // Drift looks like a clear majority and a few strays. An even split does
    // not: a syndicating news site or a multi-brand publisher legitimately
    // names several publishers, and calling that a defect would be a warning
    // about a design decision. Both are reported, and only the first is a
    // finding — the shape of the distribution is what separates them.
    const total = ranked.reduce((sum, [, count]) => sum + count, 0);
    const strays = outliers.reduce((sum, [, count]) => sum + count, 0);
    const looksLikeDrift = ranked[0]![1] / total >= MAJORITY_SHARE;

    return {
      checks: [
        {
          name: CHECK,
          status: looksLikeDrift ? "warn" : "info",
          message: looksLikeDrift
            ? `${strays} publisher ${strays === 1 ? "reference disagrees" : "references disagree"} with the other ${ranked[0]![1]}${moreSuffix(hidden, "publishers")}`
            : `This site names ${ranked.length} different publishers, none of them dominant${moreSuffix(hidden, "publishers")}`,
          // The outliers are joined into one line, and there can be thousands
          // of them on a site that inlines a publisher per product. Take the
          // heaviest few and let `clipValue` bound what survives.
          value: clipValue(
            `${label(canonical)} (${ranked[0]![1]}) vs ${outliers
              .slice(0, ENTITY_ITEM_CAP)
              .map(([key, count]) => `${label(key)} (${count})`)
              .join(", ")}`
          ),
          expected: looksLikeDrift
            ? "one publisher, referenced by @id"
            : "one publisher per site, unless it genuinely syndicates",
          items,
        },
      ],
    };
  },
};
