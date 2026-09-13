// schema/entity-authors — bylines with no Person entity behind them.

import type { EntityMapNode, Rule, RuleContext, RuleResult } from "../types";

import {
  ENTITY_FIX_DOCS,
  byReach,
  cappedItems,
  clipValue,
  entityItem,
  isMapResolved,
  moreSuffix,
  requireMap,
} from "./entity-shared";

const CHECK = "entity-authors";

/** A Person needs at least one of these to be more than a string. */
function isIdentified(node: EntityMapNode): boolean {
  const properties = node.properties as Record<string, unknown>;
  const hasSameAs = Array.isArray(properties.sameAs)
    ? properties.sameAs.length > 0
    : typeof properties.sameAs === "string" && properties.sameAs.length > 0;
  const hasUrl = typeof properties.url === "string" && properties.url.length > 0;
  return hasSameAs || hasUrl;
}

export const entityAuthorsRule: Rule = {
  meta: {
    id: "schema/entity-authors",
    name: "Author Entities",
    description:
      "Finds a site with article authorship but no Person entity, or Person entities with nothing to identify them by",
    solution: `An author who exists only as a name string is not an entity: there is nothing for a search engine to connect to the same person elsewhere, which is most of what E-E-A-T signals are built on. Declare each author as a Person with an @id, a name, a url pointing at their author page, and sameAs links to the profiles that prove who they are. Then reference that Person as the author of every article by { "@id": "…" } rather than repeating the name. See ${ENTITY_FIX_DOCS}.`,
    category: "schema",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const resolved = requireMap(ctx.entityMap, CHECK);
    if (!isMapResolved(resolved)) return { checks: resolved.checks };
    const { map } = resolved;

    const people = map.nodes.filter((node) => node.types.includes("Person"));
    // Only articles establish that the site HAS authorship to describe. A
    // brochure site with no Person node is not missing anything.
    const articles = map.nodes.filter((node) =>
      node.types.some((type) =>
        ["Article", "NewsArticle", "BlogPosting", "TechArticle", "ScholarlyArticle"].includes(
          type
        )
      )
    );

    if (articles.length === 0 && people.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "skipped",
            message: "This site declares no articles and no people",
            skipReason: "no-authorship-to-describe",
          },
        ],
      };
    }

    if (people.length === 0) {
      // An Organization can be the author, and Google's Article guidance says
      // so explicitly. An editorial board, a newswire, a research group: the
      // absence of a Person is only a finding when nothing is named as author
      // at all.
      const authored = new Set(
        map.edges.filter((edge) => edge.predicate === "author").map((edge) => edge.target)
      );
      if (authored.size > 0) {
        return {
          checks: [
            {
              name: CHECK,
              status: "pass",
              message: `Authorship is declared by ${authored.size} non-Person ${authored.size === 1 ? "entity" : "entities"}`,
            },
          ],
        };
      }
      return {
        checks: [
          {
            name: CHECK,
            status: "warn",
            message: `${articles.length} ${articles.length === 1 ? "article is" : "articles are"} declared with no Person entity anywhere on the site`,
            value: "no author entity of any kind",
            expected: "a Person or Organization with @id, referenced as author",
          },
        ],
      };
    }

    // Judge the people the site presents as AUTHORS, not every Person it
    // mentions. A biography subject, an interviewee, a person a page is
    // `about`: none of them is making a claim to expertise on your behalf, and
    // demanding a `sameAs` from them is asking the site to vouch for a stranger.
    //
    // Falls back to every Person when nothing carries an `author` edge, which
    // is what a site with inline author blocks looks like.
    const authorKeys = new Set(
      map.edges.filter((edge) => edge.predicate === "author").map((edge) => edge.target)
    );
    const judged = authorKeys.size > 0
      ? people.filter((node) => authorKeys.has(node.key))
      : people;

    if (judged.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `All ${people.length} Person ${people.length === 1 ? "entity is" : "entities are"} subjects rather than authors`,
          },
        ],
      };
    }

    const anonymous = judged.filter((node) => !isIdentified(node)).sort(byReach);
    if (anonymous.length === 0) {
      return {
        checks: [
          {
            name: CHECK,
            status: "pass",
            message: `All ${judged.length} Person ${judged.length === 1 ? "entity carries" : "entities carry"} a url or sameAs`,
          },
        ],
      };
    }

    const { items, hidden } = cappedItems(anonymous.map((node) => entityItem(node)));

    return {
      checks: [
        {
          name: CHECK,
          status: "warn",
          message: `${anonymous.length} of ${judged.length} Person ${anonymous.length === 1 ? "entity has" : "entities have"} no url and no sameAs${moreSuffix(hidden, "people")}`,
          value: items[0]?.label ? clipValue(items[0].label) : null,
          expected: "url and sameAs on every Person",
          items,
        },
      ],
    };
  },
};
