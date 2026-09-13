// The thirteen `schema/entity-*` rules (#2093, epic section 6).
//
// Two properties are pinned for every rule, and the silence one matters more.
//
// A rule must SKIP when no map was built. `ctx.entityMap` is undefined both for
// a run that could not build one and for a site with no structured data, and
// only the second is worth telling a user about. A rule that passed in the
// first case would assert it had checked something it never looked at.
//
// A rule must be silent on a clean map. These are site-wide findings against a
// health score, so a false one is expensive: it says the whole site is wrong.

import { describe, expect, test } from "bun:test";

import { entityAuthorsRule } from "../src/schema/entity-authors";
import { entityConflictsRule } from "../src/schema/entity-conflicts";
import { entityDanglingRule } from "../src/schema/entity-dangling";
import { entityIdFormatRule } from "../src/schema/entity-id-format";
import { entityIdentityRule } from "../src/schema/entity-identity";
import { entityLocalBusinessPerPageRule } from "../src/schema/entity-local-business-per-page";
import { entityOrganizationMissingRule } from "../src/schema/entity-organization-missing";
import { entityOrphanRule } from "../src/schema/entity-orphan";
import { entityPublisherMismatchRule } from "../src/schema/entity-publisher-mismatch";
import { entitySameAsMissingRule } from "../src/schema/entity-sameas-missing";
import { entitySplitIdentityRule } from "../src/schema/entity-split-identity";
import { entityTypeDriftRule } from "../src/schema/entity-type-drift";
import { entityWebsiteMissingRule } from "../src/schema/entity-website-missing";
import type { Rule } from "../src/types";

import { edge, entityMap, node, oneCheck, pages, runRule } from "./helpers/entity-map";

const ALL: Rule[] = [
  entityIdentityRule,
  entitySplitIdentityRule,
  entityConflictsRule,
  entityDanglingRule,
  entityIdFormatRule,
  entityTypeDriftRule,
  entityAuthorsRule,
  entityPublisherMismatchRule,
  entityWebsiteMissingRule,
  entityOrganizationMissingRule,
  entitySameAsMissingRule,
  entityLocalBusinessPerPageRule,
  entityOrphanRule,
];

/** A correctly marked-up site: one identified org, one website, one article. */
const CLEAN = entityMap({
  nodes: [
    node({
      key: "id:https://example.com/#organization",
      id: "https://example.com/#organization",
      types: ["Organization"],
      name: "Example Ltd",
      properties: {
        name: "Example Ltd",
        url: "https://example.com/",
        logo: "https://example.com/logo.png",
        sameAs: ["https://x.com/example", "https://www.linkedin.com/company/example"],
      },
      occurrences: 3,
      pages: pages(3),
    }),
    node({
      key: "id:https://example.com/#website",
      id: "https://example.com/#website",
      types: ["WebSite"],
      name: "Example",
      properties: { name: "Example", url: "https://example.com/" },
      occurrences: 3,
      pages: pages(3),
    }),
    node({
      key: "id:https://example.com/p1#article",
      id: "https://example.com/p1#article",
      types: ["Article"],
      name: "A post",
      properties: { name: "A post" },
      occurrences: 1,
      pages: ["https://example.com/p1"],
    }),
    node({
      key: "id:https://example.com/#author",
      id: "https://example.com/#author",
      types: ["Person"],
      name: "Ada Lovelace",
      properties: {
        name: "Ada Lovelace",
        url: "https://example.com/about",
        sameAs: ["https://en.wikipedia.org/wiki/Ada_Lovelace"],
      },
      occurrences: 1,
      pages: ["https://example.com/p1"],
    }),
  ],
  edges: [
    edge({
      source: "id:https://example.com/p1#article",
      predicate: "publisher",
      target: "id:https://example.com/#organization",
    }),
    edge({
      source: "id:https://example.com/p1#article",
      predicate: "author",
      target: "id:https://example.com/#author",
    }),
    edge({
      source: "id:https://example.com/p1#article",
      predicate: "isPartOf",
      target: "id:https://example.com/#website",
    }),
    edge({
      source: "id:https://example.com/#website",
      predicate: "publisher",
      target: "id:https://example.com/#organization",
    }),
  ],
  pageUrls: pages(3),
});

describe("every entity rule", () => {
  test.each(ALL.map((rule) => [rule.meta.id, rule] as const))(
    "%s skips when no map was built",
    async (_id, rule) => {
      const check = await oneCheck(rule, undefined);
      expect(check.status).toBe("skipped");
      expect(check.skipReason).toBe("entity-map-unavailable");
    }
  );

  test.each(ALL.map((rule) => [rule.meta.id, rule] as const))(
    "%s reports an empty map as information, not a finding",
    async (_id, rule) => {
      const check = await oneCheck(rule, entityMap({ nodes: [] }));
      expect(check.status).toBe("info");
      expect(check.message).toContain("declares no JSON-LD entities");
    }
  );

  test.each(ALL.map((rule) => [rule.meta.id, rule] as const))(
    "%s finds nothing wrong with a correctly marked-up site",
    async (_id, rule) => {
      const check = await oneCheck(rule, CLEAN);
      expect(["pass", "skipped"]).toContain(check.status);
    }
  );

  test.each(ALL.map((rule) => [rule.meta.id, rule] as const))(
    "%s is site-scope, in the schema category, and emits one check",
    async (_id, rule) => {
      expect(rule.meta.scope).toBe("site");
      expect(rule.meta.category).toBe("schema");
      // Site rules must not declare a verdict scope — see
      // tests/rule-verdict-scope.test.ts for why.
      expect(rule.meta.verdictScope).toBeUndefined();
      expect(await runRule(rule, CLEAN)).toHaveLength(1);
    }
  );

  test.each(ALL.map((rule) => [rule.meta.id, rule] as const))(
    "%s links its fix text to the entity-map guide",
    (_id, rule) => {
      expect(rule.meta.solution).toContain(
        "https://docs.squirrelscan.com/entity-map/fixing"
      );
    }
  );
});

describe("schema/entity-identity", () => {
  test("fires on the same unnamed-@id Organization across three pages", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "syn:Organization|name:example ltd",
          id: null,
          occurrences: 3,
          pages: pages(3),
        }),
      ],
      pageUrls: pages(3),
    });
    const check = await oneCheck(entityIdentityRule, map);
    expect(check.status).toBe("fail");
    expect(check.message).toContain("1 entity is declared on several pages with no @id");
    expect(check.items?.[0]?.id).toBe("syn:Organization|name:example ltd");
  });

  test("a one-page entity with no @id is ordinary, not a finding", async () => {
    // The distinction the rule exists for: with one declaration there is
    // nothing to tie together, so an `@id` buys nothing.
    const map = entityMap({
      nodes: [node({ key: "syn:x", id: null, occurrences: 1, pages: ["https://example.com/"] })],
    });
    expect((await oneCheck(entityIdentityRule, map)).status).toBe("pass");
  });

  test("a multi-page Product with no @id is not this rule's finding", async () => {
    // Only types a search engine reconciles site-wide. A Product repeated
    // across a category page and a detail page is not a split identity.
    const map = entityMap({
      nodes: [
        node({
          key: "syn:Product|name:widget",
          id: null,
          types: ["Product"],
          name: "Widget",
          occurrences: 2,
          pages: pages(2),
        }),
      ],
      pageUrls: pages(2),
    });
    expect((await oneCheck(entityIdentityRule, map)).status).toBe("pass");
  });

  test("an unnamed entity is not reported: there is nothing to reconcile by", async () => {
    const map = entityMap({
      nodes: [
        node({ key: "anon:1", id: null, name: null, occurrences: 3, pages: pages(3) }),
      ],
      pageUrls: pages(3),
    });
    expect((await oneCheck(entityIdentityRule, map)).status).toBe("pass");
  });

  test("counts every offender but lists at most ten", async () => {
    const map = entityMap({
      nodes: Array.from({ length: 14 }, (_, i) =>
        node({
          key: `syn:Person|name:p${i}`,
          id: null,
          types: ["Person"],
          name: `Person ${i}`,
          occurrences: 2,
          pages: pages(2),
        })
      ),
      pageUrls: pages(2),
    });
    const check = await oneCheck(entityIdentityRule, map);
    // The true count in the message, the capped list in the items. Saying "10"
    // to the reader with 14 problems would understate it to exactly the person
    // who needs the real number.
    expect(check.message).toContain("14 entities are declared");
    expect(check.message).toContain("+4 more");
    expect(check.items).toHaveLength(10);
  });
});

describe("schema/entity-split-identity", () => {
  const split = entityMap({
    nodes: [
      node({
        key: "id:https://example.com/#organization",
        id: "https://example.com/#organization",
        name: "Example Ltd",
        occurrences: 39,
        pages: pages(5),
      }),
      node({
        key: "id:http://data.wordlift.io/wl1/entity/example",
        id: "http://data.wordlift.io/wl1/entity/example",
        name: "Example Ltd",
        occurrences: 36,
        pages: pages(5),
      }),
    ],
    pageUrls: pages(5),
  });

  test("fires on the Yoast-versus-WordLift pair", async () => {
    const check = await oneCheck(entitySplitIdentityRule, split);
    expect(check.status).toBe("fail");
    expect(check.value).toContain("https://example.com/#organization");
    expect(check.value).toContain("data.wordlift.io");
    // Both sides listed, so the reader can tell which to keep.
    expect(check.items).toHaveLength(2);
  });

  test("two same-named entities where one has no @id is entity-identity's finding", async () => {
    // Not reported here, deliberately: billing one defect to two rules would
    // double its weight against the schema score.
    const map = entityMap({
      nodes: [
        node({ key: "id:https://example.com/#organization", name: "Example Ltd" }),
        node({ key: "syn:Organization|name:example ltd", id: null, name: "Example Ltd" }),
      ],
    });
    expect((await oneCheck(entitySplitIdentityRule, map)).status).toBe("pass");
  });

  test("two same-named people on different pages are two people, not a split", async () => {
    // The false positive that would matter most: a large publisher can have
    // two different authors called John Smith, each correctly given an `@id`.
    // A same type set and a same name is not on its own proof of one thing, so
    // the rule additionally requires them to be declared TOGETHER on a page —
    // which is what two plugins describing one organization always do, and
    // what two different people written about in different places never do.
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/authors/a#person",
          id: "https://example.com/authors/a#person",
          types: ["Person"],
          name: "John Smith",
          pages: ["https://example.com/authors/a"],
        }),
        node({
          key: "id:https://example.com/authors/b#person",
          id: "https://example.com/authors/b#person",
          types: ["Person"],
          name: "John Smith",
          pages: ["https://example.com/authors/b"],
        }),
      ],
    });
    expect((await oneCheck(entitySplitIdentityRule, map)).status).toBe("pass");
  });

  test("the same two on one page ARE a split", async () => {
    // One page declaring two things with the same type and name under
    // different ids is describing one thing twice, whatever the intent.
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/#a",
          id: "https://example.com/#a",
          types: ["Person"],
          name: "John Smith",
          pages: ["https://example.com/team"],
        }),
        node({
          key: "id:https://example.com/#b",
          id: "https://example.com/#b",
          types: ["Person"],
          name: "John Smith",
          pages: ["https://example.com/team"],
        }),
      ],
    });
    expect((await oneCheck(entitySplitIdentityRule, map)).status).toBe("fail");
  });

  test("a different name under a different @id is two entities, not one split", async () => {
    const map = entityMap({
      nodes: [
        node({ key: "id:https://example.com/#a", id: "https://example.com/#a", name: "Example Ltd" }),
        node({ key: "id:https://example.com/#b", id: "https://example.com/#b", name: "Example Media" }),
      ],
    });
    expect((await oneCheck(entitySplitIdentityRule, map)).status).toBe("pass");
  });

  test("a type set cannot be forged with a separator", async () => {
    // `@type` is site-controlled, so joining the sorted set with a delimiter
    // would make ["A+B"] and ["A","B"] the same signature.
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/#a",
          id: "https://example.com/#a",
          types: ["Organization+Person"],
          name: "Example Ltd",
        }),
        node({
          key: "id:https://example.com/#b",
          id: "https://example.com/#b",
          types: ["Organization", "Person"],
          name: "Example Ltd",
        }),
      ],
    });
    expect((await oneCheck(entitySplitIdentityRule, map)).status).toBe("pass");
  });
});

describe("schema/entity-conflicts", () => {
  test("fires on two logos and names both values", async () => {
    const map = entityMap({
      nodes: [
        node({
          occurrences: 2,
          pages: pages(2),
          conflicts: [
            {
              property: "logo",
              values: [
                { value: "https://example.com/a.png", pages: ["https://example.com/"], morePages: 0 },
                { value: "https://example.com/b.png", pages: ["https://example.com/p1"], morePages: 0 },
              ],
            },
          ],
        }),
      ],
      pageUrls: pages(2),
    });
    const check = await oneCheck(entityConflictsRule, map);
    expect(check.status).toBe("warn");
    expect(check.items?.[0]?.label).toContain("a.png");
    expect(check.items?.[0]?.label).toContain("b.png");
  });

  test("one entity with two conflicting properties is two rows", async () => {
    const map = entityMap({
      nodes: [
        node({
          conflicts: [
            {
              property: "logo",
              values: [
                { value: "a", pages: ["https://example.com/"], morePages: 0 },
                { value: "b", pages: ["https://example.com/p1"], morePages: 0 },
              ],
            },
            {
              property: "telephone",
              values: [
                { value: "1", pages: ["https://example.com/"], morePages: 0 },
                { value: "2", pages: ["https://example.com/p1"], morePages: 0 },
              ],
            },
          ],
        }),
      ],
    });
    const check = await oneCheck(entityConflictsRule, map);
    expect(check.items).toHaveLength(2);
    expect(check.message).toContain("2 properties disagree");
    expect(check.message).toContain("on 1 entity");
  });

  test("a @type disagreement belongs to entity-type-drift, not here", async () => {
    const map = entityMap({
      nodes: [
        node({
          conflicts: [
            {
              property: "@type",
              values: [
                { value: "Organization", pages: ["https://example.com/"], morePages: 0 },
                {
                  value: "LocalBusiness, Organization",
                  pages: ["https://example.com/p1"],
                  morePages: 0,
                },
              ],
            },
          ],
        }),
      ],
    });
    expect((await oneCheck(entityConflictsRule, map)).status).toBe("pass");
    expect((await oneCheck(entityTypeDriftRule, map)).status).toBe("warn");
  });
});

describe("schema/entity-dangling", () => {
  test("fires on a publisher nothing declares, grouped by target", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/p1#article",
          id: "https://example.com/p1#article",
          types: ["Article"],
          name: "A post",
          pages: ["https://example.com/p1"],
        }),
        node({
          key: "id:https://example.com/p2#article",
          id: "https://example.com/p2#article",
          types: ["Article"],
          name: "Another post",
          pages: ["https://example.com/p2"],
        }),
      ],
      edges: [
        edge({
          source: "id:https://example.com/p1#article",
          target: "id:https://example.com/#organization",
          dangling: true,
          pages: ["https://example.com/p1"],
        }),
        edge({
          source: "id:https://example.com/p2#article",
          target: "id:https://example.com/#organization",
          dangling: true,
          pages: ["https://example.com/p2"],
        }),
      ],
    });
    const check = await oneCheck(entityDanglingRule, map);
    expect(check.status).toBe("fail");
    // One undeclared publisher referenced twice is ONE thing to fix.
    expect(check.message).toContain("1 referenced @id resolves to nothing");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.meta?.referencingEntities).toBe(2);
  });

  test("a reference that resolves is not a finding", async () => {
    expect((await oneCheck(entityDanglingRule, CLEAN)).status).toBe("pass");
  });
});

describe("schema/entity-id-format", () => {
  test("fires on an @id that is not an absolute URL", async () => {
    const map = entityMap({
      nodes: [node({ key: "id:#organization", id: "#organization" })],
    });
    const check = await oneCheck(entityIdFormatRule, map);
    expect(check.status).toBe("warn");
    expect(check.value).toContain("#organization");
  });

  test("mailto and urn are absolute to URL() and still not identifiers", async () => {
    for (const id of ["mailto:hi@example.com", "urn:uuid:1234"]) {
      const map = entityMap({ nodes: [node({ key: `id:${id}`, id })] });
      expect((await oneCheck(entityIdFormatRule, map)).status).toBe("warn");
    }
  });

  test("an absolute http(s) @id passes", async () => {
    for (const id of ["https://example.com/#org", "http://example.com/#org"]) {
      const map = entityMap({ nodes: [node({ key: `id:${id}`, id })] });
      expect((await oneCheck(entityIdFormatRule, map)).status).toBe("pass");
    }
  });
});

describe("schema/entity-type-drift", () => {
  test("fires when one @id carries two type sets", async () => {
    const map = entityMap({
      nodes: [
        node({
          types: ["LocalBusiness", "Organization"],
          conflicts: [
            {
              property: "@type",
              values: [
                { value: "Organization", pages: ["https://example.com/"], morePages: 0 },
                {
                  value: "LocalBusiness, Organization",
                  pages: ["https://example.com/p1"],
                  morePages: 0,
                },
              ],
            },
          ],
        }),
      ],
    });
    const check = await oneCheck(entityTypeDriftRule, map);
    expect(check.status).toBe("warn");
    expect(check.value).toContain("Organization vs LocalBusiness, Organization");
  });

  test("an entity with no @id is not reported: it has no identity to drift", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "syn:x",
          id: null,
          conflicts: [
            {
              property: "@type",
              values: [
                { value: "Organization", pages: ["https://example.com/"], morePages: 0 },
                { value: "Person", pages: ["https://example.com/p1"], morePages: 0 },
              ],
            },
          ],
        }),
      ],
    });
    expect((await oneCheck(entityTypeDriftRule, map)).status).toBe("pass");
  });
});

describe("schema/entity-authors", () => {
  test("fires on articles with no Person anywhere", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/p1#article",
          id: "https://example.com/p1#article",
          types: ["Article"],
          name: "A post",
          pages: ["https://example.com/p1"],
        }),
      ],
    });
    const check = await oneCheck(entityAuthorsRule, map);
    expect(check.status).toBe("warn");
    expect(check.message).toContain("no Person entity");
  });

  test("fires on a Person with neither url nor sameAs", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/#author",
          id: "https://example.com/#author",
          types: ["Person"],
          name: "Ada Lovelace",
          properties: { name: "Ada Lovelace" },
        }),
      ],
    });
    const check = await oneCheck(entityAuthorsRule, map);
    expect(check.status).toBe("warn");
    expect(check.message).toContain("no url and no sameAs");
  });

  test("a site with neither articles nor people has nothing to describe", async () => {
    const map = entityMap({ nodes: [node()] });
    const check = await oneCheck(entityAuthorsRule, map);
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("no-authorship-to-describe");
  });
});

describe("schema/entity-publisher-mismatch", () => {
  test("fires when two publishers are named, and says which is the outlier", async () => {
    const map = entityMap({
      nodes: [
        node({ key: "id:https://example.com/#org-a", id: "https://example.com/#org-a", name: "A", occurrences: 20 }),
        node({ key: "id:https://example.com/#org-b", id: "https://example.com/#org-b", name: "B", occurrences: 1 }),
      ],
      edges: [
        edge({ target: "id:https://example.com/#org-a", occurrences: 20 }),
        edge({ target: "id:https://example.com/#org-b", occurrences: 1 }),
      ],
    });
    const check = await oneCheck(entityPublisherMismatchRule, map);
    expect(check.status).toBe("warn");
    expect(check.message).toBe("1 publisher reference disagrees with the other 20");
    // Weighted by how much of the site names each, not by distinct target: one
    // publisher named 20 times and another once is not a 50/50 disagreement.
    expect(check.value).toContain("A (20)");
    expect(check.items?.[0]?.id).toBe("id:https://example.com/#org-b");
  });

  test("an evenly split site is described, not accused", async () => {
    // A syndicating news site or a multi-brand publisher legitimately names
    // several publishers. Drift looks like a majority and a few strays; an
    // even split looks like a decision, and warning about it would be a
    // warning about someone's architecture.
    const map = entityMap({
      nodes: [
        node({ key: "id:https://example.com/#org-a", id: "https://example.com/#org-a", name: "A" }),
        node({ key: "id:https://example.com/#org-b", id: "https://example.com/#org-b", name: "B" }),
      ],
      edges: [
        edge({ target: "id:https://example.com/#org-a", occurrences: 10 }),
        edge({ target: "id:https://example.com/#org-b", occurrences: 9 }),
      ],
    });
    const check = await oneCheck(entityPublisherMismatchRule, map);
    expect(check.status).toBe("info");
    expect(check.message).toContain("none of them dominant");
  });

  test("a site that declares no publisher is skipped", async () => {
    const map = entityMap({ nodes: [node()] });
    const check = await oneCheck(entityPublisherMismatchRule, map);
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("no-publisher-declared");
  });
});

describe("schema/entity-website-missing", () => {
  test("fires when there is no WebSite node", async () => {
    const map = entityMap({ nodes: [node()] });
    const check = await oneCheck(entityWebsiteMissingRule, map);
    expect(check.status).toBe("info");
    expect(check.message).toContain("no WebSite entity");
  });

  test("fires when pages do not link to the WebSite with isPartOf", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/#website",
          id: "https://example.com/#website",
          types: ["WebSite"],
          name: "Example",
        }),
        node({
          key: "id:https://example.com/p1#page",
          id: "https://example.com/p1#page",
          types: ["WebPage"],
          name: "A page",
          pages: ["https://example.com/p1"],
        }),
      ],
    });
    const check = await oneCheck(entityWebsiteMissingRule, map);
    expect(check.status).toBe("info");
    expect(check.message).toContain("link to the WebSite with isPartOf");
  });
});

describe("schema/entity-organization-missing", () => {
  test("fires when a contact page exists and no organization does", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/contact#page",
          id: "https://example.com/contact#page",
          types: ["ContactPage"],
          name: "Contact",
          pages: ["https://example.com/contact"],
        }),
      ],
    });
    const check = await oneCheck(entityOrganizationMissingRule, map);
    expect(check.status).toBe("info");
    expect(check.value).toContain("ContactPage");
  });

  test("a site with no business signals is skipped, not told to invent markup", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/p1#article",
          id: "https://example.com/p1#article",
          types: ["Article"],
          name: "A post",
        }),
      ],
    });
    const check = await oneCheck(entityOrganizationMissingRule, map);
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("no-business-signals");
  });
});

describe("schema/entity-sameas-missing", () => {
  test("fires on a primary organization with no sameAs", async () => {
    const map = entityMap({
      nodes: [node({ properties: { name: "Example Ltd", url: "https://example.com/" } })],
    });
    const check = await oneCheck(entitySameAsMissingRule, map);
    expect(check.status).toBe("info");
    expect(check.message).toContain("has no sameAs profiles");
  });

  test("no organization at all is entity-organization-missing's finding", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/p1#article",
          id: "https://example.com/p1#article",
          types: ["Article"],
          name: "A post",
        }),
      ],
    });
    const check = await oneCheck(entitySameAsMissingRule, map);
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("no-organization");
  });
});

describe("schema/entity-local-business-per-page", () => {
  test("fires on a LocalBusiness declared on every crawled page", async () => {
    const urls = pages(20);
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/#business",
          id: "https://example.com/#business",
          types: ["LocalBusiness"],
          name: "Example Plumbing",
          occurrences: 20,
          pages: urls.slice(0, 20),
        }),
      ],
      pageUrls: urls,
    });
    const check = await oneCheck(entityLocalBusinessPerPageRule, map);
    expect(check.status).toBe("warn");
    expect(check.message).toContain("declared in full on 20 of 20 crawled pages");
    expect(check.value).toBe("100% of crawled pages");
  });

  test("declared on a home page and a contact page is correct markup", async () => {
    const urls = pages(20);
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/#business",
          id: "https://example.com/#business",
          types: ["LocalBusiness"],
          name: "Example Plumbing",
          occurrences: 2,
          pages: urls.slice(0, 2),
        }),
      ],
      pageUrls: urls,
    });
    expect((await oneCheck(entityLocalBusinessPerPageRule, map)).status).toBe("pass");
  });

  test("a crawl too small to tell repetition from coverage is skipped", async () => {
    const urls = pages(3);
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/#business",
          id: "https://example.com/#business",
          types: ["LocalBusiness"],
          name: "Example Plumbing",
          occurrences: 3,
          pages: urls,
        }),
      ],
      pageUrls: urls,
    });
    const check = await oneCheck(entityLocalBusinessPerPageRule, map);
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("too-few-pages");
  });

  test("a LocalBusiness subtype counts", async () => {
    const urls = pages(20);
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/#business",
          id: "https://example.com/#business",
          types: ["Plumber"],
          name: "Example Plumbing",
          occurrences: 20,
          pages: urls.slice(0, 20),
        }),
      ],
      pageUrls: urls,
    });
    expect((await oneCheck(entityLocalBusinessPerPageRule, map)).status).toBe("warn");
  });
});

describe("schema/entity-orphan", () => {
  test("fires on an identified entity nothing references, on one page", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/p1#thing",
          id: "https://example.com/p1#thing",
          types: ["Thing"],
          name: "A thing",
          pages: ["https://example.com/p1"],
        }),
      ],
    });
    const check = await oneCheck(entityOrphanRule, map);
    expect(check.status).toBe("info");
    expect(check.items?.[0]?.id).toBe("id:https://example.com/p1#thing");
  });

  test("a page-describing or page-subject entity is expected to be unreferenced", async () => {
    // A WebPage for the page you are reading, its breadcrumb, its FAQ: nothing
    // should point at these. An Article IS the page: expecting another node to
    // reference it is backwards, and without this the rule fires on every blog
    // post on the web (73 of 79 on a real kinsta.com crawl).
    for (const type of ["WebPage", "BreadcrumbList", "FAQPage", "Article", "BlogPosting"]) {
      const map = entityMap({
        nodes: [
          node({
            key: `id:https://example.com/p1#${type}`,
            id: `https://example.com/p1#${type}`,
            types: [type],
            name: null,
            pages: ["https://example.com/p1"],
          }),
        ],
      });
      expect((await oneCheck(entityOrphanRule, map)).status).toBe("pass");
    }
  });

  test("the builder's own pageLocal verdict is honoured", async () => {
    const map = entityMap({
      nodes: [
        node({
          key: "id:https://example.com/p1#thing",
          id: "https://example.com/p1#thing",
          types: ["Thing"],
          name: "A thing",
          pages: ["https://example.com/p1"],
          pageLocal: true,
        }),
      ],
    });
    expect((await oneCheck(entityOrphanRule, map)).status).toBe("pass");
  });

  test("an entity on several pages is not an orphan even if unreferenced", async () => {
    const map = entityMap({
      nodes: [node({ occurrences: 3, pages: pages(3) })],
      pageUrls: pages(3),
    });
    expect((await oneCheck(entityOrphanRule, map)).status).toBe("pass");
  });
});
