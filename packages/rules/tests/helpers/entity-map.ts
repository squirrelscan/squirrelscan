// Builders for hand-made entity maps, for the `schema/entity-*` rule tests.
//
// Hand-made rather than produced by the real builder because `packages/rules`
// cannot import `audit-engine` — the engine depends on the rules, not the other
// way round. That split is deliberate and it costs something: a map written
// here could be a shape the builder never emits, and a rule that only ever sees
// these would be tested against a fiction.
//
// So these tests pin the rule LOGIC, and
// `packages/audit-engine/tests/entity-rules-golden.test.ts` runs the same rules
// over maps the real builder produced from real HTML. Neither is sufficient
// alone.

import type {
  CheckResult,
  EntityMap,
  EntityMapEdge,
  EntityMapNode,
  Rule,
  RuleContext,
} from "../../src/types";

export function node(overrides: Partial<EntityMapNode> = {}): EntityMapNode {
  return {
    key: "id:https://example.com/#organization",
    id: "https://example.com/#organization",
    types: ["Organization"],
    name: "Example Ltd",
    properties: { name: "Example Ltd" },
    occurrences: 1,
    pages: ["https://example.com/"],
    morePages: 0,
    conflicts: [],
    danglingRefs: 0,
    pageLocal: false,
    ...overrides,
  };
}

export function edge(overrides: Partial<EntityMapEdge> = {}): EntityMapEdge {
  return {
    source: "id:https://example.com/#article",
    predicate: "publisher",
    target: "id:https://example.com/#organization",
    dangling: false,
    occurrences: 1,
    pages: ["https://example.com/"],
    morePages: 0,
    ...overrides,
  };
}

export interface MapOptions {
  nodes?: EntityMapNode[];
  edges?: EntityMapEdge[];
  /** Page urls the crawl visited. Defaults to one page per distinct node page. */
  pageUrls?: string[];
}

export function entityMap(options: MapOptions = {}): EntityMap {
  const nodes = options.nodes ?? [];
  const edges = options.edges ?? [];
  const pageUrls =
    options.pageUrls ??
    [...new Set(nodes.flatMap((n) => n.pages))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const declaresByPage = new Map<string, string[]>();
  for (const n of nodes) {
    for (const page of n.pages) {
      const list = declaresByPage.get(page);
      if (list) list.push(n.key);
      else declaresByPage.set(page, [n.key]);
    }
  }

  const withId = nodes.filter((n) => n.id !== null).length;
  return {
    format: "squirrelscan/entity-map",
    version: 1,
    site: "https://example.com/",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      danglingCount: edges.filter((e) => e.dangling).length,
      pagesTotal: pageUrls.length,
      pagesWithoutEntities: pageUrls.filter((url) => !declaresByPage.has(url)).length,
      nodesWithStableId: withId,
      stableIdShare: nodes.length === 0 ? 0 : withId / nodes.length,
      pageLocalCount: nodes.filter((n) => n.pageLocal).length,
      nodesWithoutIdCount: nodes.filter(
        (n) => n.id === null && n.pages.length + n.morePages > 1
      ).length,
      conflictCount: nodes.filter((n) => n.conflicts.length > 0).length,
      countsByType: {},
    },
    nodes,
    edges,
    pages: pageUrls.map((url) => ({
      url,
      declares: (declaresByPage.get(url) ?? []).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      references: [],
      entityCount: (declaresByPage.get(url) ?? []).length,
    })),
  };
}

/** `n` page urls under example.com, in the order a crawl would list them. */
export function pages(n: number, prefix = "https://example.com/p"): string[] {
  return Array.from({ length: n }, (_, i) => (i === 0 ? "https://example.com/" : `${prefix}${i}`));
}

/** A site-scope context carrying the map and nothing else a rule should need. */
export function ctxWith(map: EntityMap | undefined): RuleContext {
  return {
    page: {
      url: "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as RuleContext["parsed"],
    site: {
      baseUrl: "https://example.com/",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
    },
    ...(map ? { entityMap: map } : {}),
    options: {},
  };
}

export async function runRule(rule: Rule, map: EntityMap | undefined): Promise<CheckResult[]> {
  const result = await Promise.resolve(rule.run(ctxWith(map)));
  return result.checks;
}

/** The single check every entity rule emits, with a readable failure. */
export async function oneCheck(rule: Rule, map: EntityMap | undefined): Promise<CheckResult> {
  const checks = await runRule(rule, map);
  if (checks.length !== 1) {
    throw new Error(
      `${rule.meta.id} emitted ${checks.length} checks, expected exactly 1: ${JSON.stringify(checks)}`
    );
  }
  return checks[0]!;
}
