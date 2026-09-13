// schema/entity-local-business-per-page — a LocalBusiness redeclared everywhere.

import type { Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  byReach,
  cappedItems,
  clipValue,
  entityItem,
  entityLabel,
  isLocalBusinessType,
  isMapResolved,
  moreSuffix,
  pageTotal,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-local-business-per-page";

/**
 * The share of crawled pages a LocalBusiness must appear on to count as
 * "declared on every page".
 *
 * Not 100%: a site that skips its own 404 page or one legal page is doing the
 * same thing. Not a low bar either, because a business legitimately declared on
 * a home page and a contact page is correct markup, not this finding.
 */
const PER_PAGE_SHARE = 0.8;

/** Below this, "on every page" is not a meaningful claim about a crawl. */
const MIN_PAGES = 5;

export const entityLocalBusinessPerPageRule: Rule = {
  meta: {
    id: "schema/entity-local-business-per-page",
    name: "LocalBusiness On Every Page",
    description:
      "Finds a LocalBusiness declared in full on nearly every page rather than once and referenced",
    solution: `Repeating the whole LocalBusiness block on every page is the default of most page builders and most WordPress themes, and it is the reason so many local sites disagree with themselves about their own phone number: every copy is a chance to drift. Declare the business in full once, on the home page or the contact page, with an absolute @id. On every other page emit only { "@id": "…" } where the business is referenced. The markup gets smaller and the site can no longer contradict itself. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    const businesses = map.nodes.filter((node) =>
      node.types.some((type) => isLocalBusinessType(type))
    );
    if (businesses.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "skipped",
            message: "This site declares no LocalBusiness entity",
            skipReason: "no-local-business",
          },
        ],
      };
    }

    const pagesCrawled = map.summary.pagesTotal;
    if (pagesCrawled < MIN_PAGES) {
      return {
        checks: [
          {
            name: CHECK,
            status: "skipped",
            message: `Only ${pagesCrawled} ${pagesCrawled === 1 ? "page was" : "pages were"} crawled, too few to tell repetition from coverage`,
            skipReason: "too-few-pages",
          },
        ],
      };
    }

    const threshold = pagesCrawled * PER_PAGE_SHARE;
    const offenders = businesses
      .filter((node) => pageTotal(node) >= threshold)
      .sort(byReach);

    if (offenders.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: "No LocalBusiness is redeclared across the whole site",
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
          status: "warn",
          message: `${entityLabel(worst)} is declared in full on ${pageTotal(worst)} of ${pagesCrawled} crawled pages${moreSuffix(hidden, "businesses")}`,
          value: clipValue(`${Math.round((pageTotal(worst) / pagesCrawled) * 100)}% of crawled pages`),
          expected: "declared once with an @id, referenced elsewhere",
          items,
        },
      ],
    };
  },
};
