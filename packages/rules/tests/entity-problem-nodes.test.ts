// The publish projection reserves budget for the nodes behind each finding
// (`entityProblemNodes`). The rules and that classifier read the same predicates
// from `@squirrelscan/core-contracts/entity-map-findings`; this file pins the two
// together. For every class, a map the real rule reports on must put a node in
// the class, and a map the real rule passes on must leave the class empty, so a
// rule change that is not mirrored in the classifier fails here.

import { describe, expect, test } from "bun:test";

import {
  ENTITY_PROBLEM_CLASSES,
  entityProblemNodes,
  type EntityProblemClass,
} from "@squirrelscan/core-contracts/entity-map-findings";

import { entityAuthorsRule } from "../src/schema/entity-authors";
import { entityConflictsRule } from "../src/schema/entity-conflicts";
import { entityDanglingRule } from "../src/schema/entity-dangling";
import { entityIdFormatRule } from "../src/schema/entity-id-format";
import { entityIdentityRule } from "../src/schema/entity-identity";
import { entityLocalBusinessPerPageRule } from "../src/schema/entity-local-business-per-page";
import { entityOrphanRule } from "../src/schema/entity-orphan";
import { entityPublisherMismatchRule } from "../src/schema/entity-publisher-mismatch";
import { entitySameAsMissingRule } from "../src/schema/entity-sameas-missing";
import { entitySplitIdentityRule } from "../src/schema/entity-split-identity";
import type { EntityMap, EntityMapEdge, EntityMapNode, Rule } from "../src/types";

import { edge, entityMap, node, oneCheck, pages } from "./helpers/entity-map";

const SAME_AS = ["https://x.com/example"];
const A = "https://example.com/a";
const B = "https://example.com/b";

/** An identified, referenced-looking org: quiet on every class. */
function quietOrg(overrides: Partial<EntityMapNode> = {}): EntityMapNode {
  return node({
    properties: { name: "Example Ltd", sameAs: SAME_AS },
    occurrences: 3,
    pages: pages(3),
    ...overrides,
  });
}

const ORG_KEY = "id:https://example.com/#organization";
const referenceTo = (target: string): EntityMapEdge =>
  edge({ source: "id:https://example.com/#src", predicate: "about", target });

interface Case {
  cls: EntityProblemClass;
  rules: Rule[];
  /** A map the rule reports on. */
  bad: () => EntityMap;
  /** The nearest map it does not. */
  good: () => EntityMap;
}

const CASES: Case[] = [
  {
    cls: "conflict",
    rules: [entityConflictsRule],
    bad: () =>
      entityMap({
        nodes: [
          quietOrg({
            conflicts: [
              {
                property: "name",
                values: [
                  { value: "Acme", pages: [A], morePages: 0 },
                  { value: "ACME Inc", pages: [B], morePages: 0 },
                ],
              },
            ],
          }),
        ],
      }),
    good: () => entityMap({ nodes: [quietOrg()] }),
  },
  {
    cls: "dangling",
    rules: [entityDanglingRule],
    bad: () =>
      entityMap({
        nodes: [quietOrg({ danglingRefs: 1 })],
        edges: [
          edge({
            source: ORG_KEY,
            predicate: "parentOrganization",
            target: "id:https://example.com/#missing",
            dangling: true,
          }),
        ],
      }),
    good: () => entityMap({ nodes: [quietOrg()] }),
  },
  {
    cls: "no-id",
    rules: [entityIdentityRule],
    bad: () =>
      entityMap({ nodes: [quietOrg({ key: "anon:org", id: null, pages: [A, B], occurrences: 2 })] }),
    // One declaring page is ordinary.
    good: () =>
      entityMap({ nodes: [quietOrg({ key: "anon:org", id: null, pages: [A], occurrences: 1 })] }),
  },
  {
    cls: "split-identity",
    rules: [entitySplitIdentityRule],
    bad: () => entityMap({ nodes: twins([A, "https://example.com/c"], [A, B]) }),
    // Same name and type, never declared together: two things, not a split.
    good: () => entityMap({ nodes: twins([A, "https://example.com/c"], [B, "https://example.com/d"]) }),
  },
  {
    cls: "orphan",
    rules: [entityOrphanRule],
    bad: () => entityMap({ nodes: [thing("id:https://example.com/p1#thing")] }),
    good: () =>
      entityMap({
        nodes: [thing("id:https://example.com/p1#thing")],
        edges: [referenceTo("id:https://example.com/p1#thing")],
      }),
  },
  {
    cls: "id-format",
    rules: [entityIdFormatRule],
    bad: () => entityMap({ nodes: [quietOrg({ key: "id:#org", id: "#org" })] }),
    good: () => entityMap({ nodes: [quietOrg()] }),
  },
  {
    cls: "sameas-missing",
    rules: [entitySameAsMissingRule],
    bad: () => entityMap({ nodes: [quietOrg({ properties: { name: "Example Ltd" } })] }),
    good: () => entityMap({ nodes: [quietOrg()] }),
  },
  {
    cls: "publisher-mismatch",
    rules: [entityPublisherMismatchRule],
    bad: () => publishers(9, 1),
    // Every reference points at the one publisher, which is the primary.
    good: () => publishers(10, 0),
  },
  {
    cls: "authors",
    rules: [entityAuthorsRule],
    bad: () =>
      entityMap({
        nodes: [quietOrg(), person({ properties: { name: "Ada" } })],
      }),
    good: () =>
      entityMap({
        nodes: [quietOrg(), person({ properties: { name: "Ada", url: "https://example.com/ada" } })],
      }),
  },
  {
    cls: "local-business-per-page",
    rules: [entityLocalBusinessPerPageRule],
    bad: () => localBusiness(20),
    good: () => localBusiness(2),
  },
];

function twins(pagesOne: string[], pagesTwo: string[]): EntityMapNode[] {
  const twin = (id: string, p: string[]) =>
    quietOrg({
      key: `id:${id}`,
      id,
      name: "Acme",
      properties: { name: "Acme", sameAs: SAME_AS },
      occurrences: p.length,
      pages: p,
    });
  return [twin("https://example.com/#org", pagesOne), twin("https://data.example.org/acme", pagesTwo)];
}

function thing(key: string): EntityMapNode {
  return node({
    key,
    id: key.replace(/^id:/, ""),
    types: ["Thing"],
    name: "A thing",
    pages: ["https://example.com/p1"],
  });
}

function person(overrides: Partial<EntityMapNode>): EntityMapNode {
  return node({
    key: "id:https://example.com/#ada",
    id: "https://example.com/#ada",
    types: ["Person"],
    name: "Ada",
    pages: [A, B],
    occurrences: 2,
    ...overrides,
  });
}

/** `main` references to the primary org and `stray` to a second publisher. */
function publishers(main: number, stray: number): EntityMap {
  const second = quietOrg({
    key: "id:https://example.com/#other",
    id: "https://example.com/#other",
    name: "Other Ltd",
    occurrences: 1,
    pages: [A],
  });
  const refs = (target: string, n: number): EntityMapEdge[] =>
    n === 0 ? [] : [edge({ source: "id:https://example.com/#src", target, occurrences: n })];
  return entityMap({
    nodes: [quietOrg(), ...(stray > 0 ? [second] : [])],
    edges: [...refs(ORG_KEY, main), ...refs(second.key, stray)],
  });
}

function localBusiness(declaredOn: number): EntityMap {
  const urls = pages(20);
  return entityMap({
    nodes: [
      node({
        key: "id:https://example.com/#business",
        id: "https://example.com/#business",
        types: ["LocalBusiness"],
        name: "Example Plumbing",
        properties: { name: "Example Plumbing", sameAs: SAME_AS },
        occurrences: declaredOn,
        pages: urls.slice(0, declaredOn),
      }),
    ],
    pageUrls: urls,
  });
}

describe("entityProblemNodes agrees with the rules", () => {
  test("every class has a case", () => {
    expect(CASES.map((c) => c.cls).sort()).toEqual(
      [...ENTITY_PROBLEM_CLASSES].sort(),
    );
  });

  for (const c of CASES) {
    test(`${c.cls}: a map the rule reports on has nodes in the class`, async () => {
      const map = c.bad();
      for (const rule of c.rules) {
        expect((await oneCheck(rule, map)).status).toMatch(/^(fail|warn|info)$/);
      }
      expect(entityProblemNodes(map)[c.cls]?.length ?? 0).toBeGreaterThan(0);
    });

    test(`${c.cls}: negative control, a map the rule passes on leaves the class empty`, async () => {
      const map = c.good();
      for (const rule of c.rules) {
        expect((await oneCheck(rule, map)).status).toMatch(/^(pass|skipped)$/);
      }
      expect(entityProblemNodes(map)[c.cls] ?? []).toEqual([]);
    });
  }

  test("a type-drift finding rides the conflict class", () => {
    const map = entityMap({
      nodes: [
        quietOrg({
          conflicts: [
            {
              property: "@type",
              values: [
                { value: "Organization", pages: [A], morePages: 0 },
                { value: "Corporation", pages: [B], morePages: 0 },
              ],
            },
          ],
        }),
      ],
    });
    expect(entityProblemNodes(map).conflict?.length).toBe(1);
  });
});
