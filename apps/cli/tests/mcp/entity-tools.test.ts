// The five entity MCP tools (#2095, epic section 8).
//
// Driven through a REAL seeded project store rather than a stubbed controller,
// because the questions these tools answer are questions about storage: which
// crawl is the latest, which two belong to the same site, whether a map
// survived the round trip. A stub would answer all of those by assumption.
//
// The fixtures are the two docs.squirrelscan.com snapshots committed with
// #2092: the same 60-page site before and after it gained JSON-LD. That pair
// is what makes the fix-and-verify loop testable end to end — the "before"
// map is a site with an identity problem and the "after" map is the same site
// with it fixed, which is exactly the shape an agent produces by acting on
// `list_entities` and re-auditing.

import type { EntityMap } from "@squirrelscan/core-contracts/entity-map";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const FIXTURES = join(
  import.meta.dir,
  "../../../../packages/audit-engine/tests/fixtures/entity-map"
);

let home: string;

// `os.homedir()` is read once at process start in Bun and does NOT follow a
// later `process.env.HOME`, which is verifiable in one line:
//
//   process.env.HOME = "/tmp/x"; homedir()  // still the real home
//
// Every squirrel path derives from `homedir()`, so setting HOME alone leaves
// these tests reading the developer's real ~/.squirrel — which is how a run
// of this file first came back with a crawl id from a kinsta.com audit. Mock
// the function itself so every path agrees.
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => home,
}));

/**
 * The fixture, with the fields older exports predate filled in.
 *
 * Two repairs, both of which the CLI's own `--input` loader also makes:
 *
 * `pageLocal` and three summary counters were added to v1 after these files
 * were written, and are recomputable from the nodes with certainty.
 *
 * `pages` is the awkward one. `docs-after-jsonld.json` carries `pages: []`
 * beside `pagesTotal: 60`, because it was exported before the publish
 * projection stopped clipping the report's own copy. The store derives its
 * occurrence rows from `pages[].declares`, so seeding it as-is gives every
 * entity zero declaring pages and every page filter matches nothing.
 *
 * Rebuilt here by inverting the nodes' own page lists. Faithful except for
 * three nodes whose lists are capped at 50 with a `morePages` remainder: the
 * widest, a WebSite on all 60 pages, comes back on 50. No assertion in this
 * file turns on that difference, and the alternative is either editing a real
 * export or not testing the pair the issue names.
 */
async function fixture(name: string): Promise<EntityMap> {
  const raw = (await Bun.file(`${FIXTURES}/${name}.json`).json()) as EntityMap;
  const nodes = raw.nodes.map((node) => ({
    ...node,
    pageLocal: node.pageLocal ?? false,
  }));

  let pages = raw.pages;
  if (pages.length === 0 && nodes.length > 0) {
    const declaresByPage = new Map<string, string[]>();
    for (const node of nodes) {
      for (const url of node.pages) {
        const list = declaresByPage.get(url);
        if (list) list.push(node.key);
        else declaresByPage.set(url, [node.key]);
      }
    }
    pages = [...declaresByPage.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([url, declares]) => ({
        url,
        declares: declares.sort(),
        references: [],
        entityCount: declares.length,
      }));
  }

  return {
    ...raw,
    summary: {
      ...raw.summary,
      pageLocalCount: raw.summary.pageLocalCount ?? 0,
      nodesWithoutIdCount: raw.summary.nodesWithoutIdCount ?? 0,
      conflictCount: raw.summary.conflictCount ?? 0,
    },
    nodes,
    pages,
  };
}

/**
 * Seed one crawl carrying a map into a project store.
 *
 * `startedAt` decides which crawl is "latest" and which is "previous", so the
 * tests set it explicitly rather than relying on insertion order.
 */
async function seed(options: {
  project: string;
  baseUrl: string;
  startedAt: number;
  map: EntityMap;
}): Promise<string> {
  const { createStorage } = await import("@/crawler/storage");
  const { storeEntityMap } = await import("@/audit/entity-map");
  const storage = await Effect.runPromise(
    createStorage({ projectName: options.project, silent: true })
  );
  try {
    // `createCrawl` mints the id itself and returns it; a caller-supplied one
    // is ignored. Returning it is what lets these tests assert relationships
    // — which crawl is latest, which two share a site — rather than ids they
    // invented and the store never used.
    const crawlId = await Effect.runPromise(
      storage.createCrawl({
        baseUrl: options.baseUrl,
        startedAt: options.startedAt,
        status: "analyzed",
        config: {},
        stats: {
          pagesTotal: options.map.summary.pagesTotal,
          pagesCrawled: options.map.summary.pagesTotal,
          pagesFailed: 0,
          errors: 0,
        },
        // Through `unknown`: a real crawl carries a full config snapshot and a
        // full stats block, and none of the fifteen other config fields is
        // read by anything under test here.
      } as unknown as Parameters<typeof storage.createCrawl>[0])
    );
    await storeEntityMap({
      storage: storage as import("@/crawler/storage/sqlite").SQLiteStorage,
      crawlId,
      map: options.map,
    });
    return crawlId;
  } finally {
    await Effect.runPromise(
      storage.close().pipe(Effect.catchAll(() => Effect.void))
    );
  }
}

/**
 * Call one tool the way a client does, and parse the JSON it returns.
 *
 * Through the `tools/call` request handler rather than the registered
 * callback, so the zod input schema runs too. A test that bypassed it would
 * pass with arguments no real client could send.
 */
async function call(
  tool: string,
  args: Record<string, unknown> = {}
): Promise<{ ok: boolean; text: string; data: Record<string, unknown> }> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerEntityTools } = await import("@/mcp/tools/entity-tools");

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerEntityTools(server);

  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<
        string,
        (request: unknown, extra: unknown) => Promise<unknown>
      >;
    }
  )._requestHandlers;
  const callTool = handlers.get("tools/call");
  if (!callTool) throw new Error("the server registered no tools/call handler");

  const result = (await callTool(
    { method: "tools/call", params: { name: tool, arguments: args } },
    {
      signal: new AbortController().signal,
      requestId: 1,
      sendNotification: () => {},
      sendRequest: () => {},
    }
  )) as { isError?: boolean; content: Array<{ text: string }> };

  const text = result.content[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  if (!result.isError) {
    data = JSON.parse(text) as Record<string, unknown>;
  }
  return { ok: !result.isError, text, data };
}

beforeEach(() => {
  // A fresh store per test: these assert which crawl is "latest", and a store
  // carrying a previous test's crawls would answer from the wrong site.
  home = mkdtempSync(join(realOs.tmpdir(), "squirrel-entity-mcp-"));
  process.env.HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the five tools are registered with the shared contract", () => {
  test("all five exist, and their descriptions state the loop", async () => {
    const { McpServer } =
      await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerEntityTools } = await import("@/mcp/tools/entity-tools");
    const { ENTITY_MCP_TOOL_NAMES, ENTITY_MCP_LOOP, ENTITY_MCP_DESCRIPTIONS } =
      await import("@squirrelscan/core-contracts/entity-mcp");

    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerEntityTools(server);
    const registered = (
      server as unknown as {
        _registeredTools: Record<string, { description?: string }>;
      }
    )._registeredTools;

    for (const name of ENTITY_MCP_TOOL_NAMES) {
      expect(registered[name]).toBeDefined();
      // Every one, not just the two the loop names: an agent reads whichever
      // tool it called first and has to learn the sequence from that one.
      expect(registered[name]?.description).toContain(ENTITY_MCP_LOOP);
      expect(registered[name]?.description).toBe(ENTITY_MCP_DESCRIPTIONS[name]);
    }
  });
});

describe("against the docs snapshots as a seeded store", () => {
  let beforeRun: string;
  let afterRun: string;

  beforeEach(async () => {
    beforeRun = await seed({
      project: "docs",
      baseUrl: "https://docs.squirrelscan.com/",
      startedAt: 1_000_000,
      map: await fixture("docs-before-jsonld"),
    });
    afterRun = await seed({
      project: "docs",
      baseUrl: "https://docs.squirrelscan.com/",
      startedAt: 2_000_000,
      map: await fixture("docs-after-jsonld"),
    });
  });

  test("list_entities returns the latest audit, paginated", async () => {
    const { data } = await call("list_entities", { limit: 5 });
    expect(data.runId).toBe(afterRun);
    expect(Array.isArray(data.entities)).toBe(true);
    expect((data.entities as unknown[]).length).toBe(5);
    // `total` is the filtered total, and `hasMore` says the page is partial.
    // An agent that cannot tell a page from the whole list will describe a
    // site from five of its entities.
    expect(data.total as number).toBeGreaterThan(5);
    expect(data.hasMore).toBe(true);
  });

  test("list_entities hides page-local entities unless asked", async () => {
    const without = await call("list_entities", { limit: 100 });
    const withThem = await call("list_entities", {
      limit: 100,
      include_page_local: true,
    });
    // The docs site is mostly WebPage and BreadcrumbList nodes, so the two
    // totals must differ or the flag does nothing.
    expect(withThem.data.total as number).toBeGreaterThan(
      without.data.total as number
    );
  });

  test("list_entities filters by problem", async () => {
    const all = await call("list_entities", { limit: 100 });
    const singlePage = await call("list_entities", {
      limit: 100,
      problem: ["single-page"],
    });
    expect(singlePage.data.total as number).toBeLessThan(
      all.data.total as number
    );
    expect(singlePage.data.total as number).toBeGreaterThan(0);
  });

  test("list_entities reads an older audit when asked", async () => {
    const { data } = await call("list_entities", { run_id: beforeRun });
    expect(data.runId).toBe(beforeRun);
    // The before snapshot is the same site with no JSON-LD at all.
    expect(data.total).toBe(0);
  });

  test("get_entity returns one node with both edge directions", async () => {
    const { data } = await call("get_entity", { key: "squirrelscan" });
    const entity = data.entity as { name: string; types: string[] };
    expect(entity.name).toBe("squirrelscan");
    expect(Array.isArray(data.outgoing)).toBe(true);
    expect(Array.isArray(data.incoming)).toBe(true);
    expect(Array.isArray(data.declaredOn)).toBe(true);
  });

  test("get_entity says what it cannot find, and how to look", async () => {
    const result = await call("get_entity", { key: "no such entity" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("list_entities");
  });

  test("get_entity_graph renders every format", async () => {
    for (const format of [
      "json",
      "jsonld",
      "mermaid",
      "dot",
      "graphml",
      "markdown",
    ]) {
      const { data } = await call("get_entity_graph", { format });
      expect(data.format).toBe(format);
      expect((data.content as string).length).toBeGreaterThan(0);
    }
  });

  test("get_entity_graph caps mermaid and markdown, and says so", async () => {
    const mermaid = await call("get_entity_graph", {
      format: "mermaid",
      include_page_local: true,
    });
    const markdown = await call("get_entity_graph", {
      format: "markdown",
      include_page_local: true,
    });
    for (const result of [mermaid, markdown]) {
      const truncation = result.data.truncation as {
        truncated: boolean;
        notice: string;
      };
      expect(truncation.truncated).toBe(true);
      // The notice has to carry the true total, not the shown count: an agent
      // told "50 entities" when there are 183 will reason from the wrong site.
      expect(truncation.notice).toContain(String(result.data.nodeCount));
    }
  });

  test("get_entity_graph leaves the complete formats complete", async () => {
    for (const format of ["json", "jsonld", "dot", "graphml"]) {
      const { data } = await call("get_entity_graph", {
        format,
        include_page_local: true,
      });
      expect((data.truncation as { truncated: boolean }).truncated).toBe(false);
    }
  });

  test("compare_entities refuses a default when the older audit stored no entities", async () => {
    // The docs "before" snapshot is the same site with NO JSON-LD, so it has
    // no entity rows. Zero rows is indistinguishable from "this crawl predates
    // the entity map", and reading the second as the first would report all
    // 183 of today's entities as brand new. The default declines and says so;
    // naming both runs is how you say you know which it was.
    const result = await call("compare_entities");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("docs.squirrelscan.com");
  });

  test("compare_entities compares them when both runs are named", async () => {
    const { data } = await call("compare_entities", {
      from_run_id: beforeRun,
      to_run_id: afterRun,
    });
    expect(data.fromRunId).toBe(beforeRun);
    expect(data.toRunId).toBe(afterRun);
    const diff = data.diff as { added: unknown[]; removed: unknown[] };
    expect(diff.added.length).toBeGreaterThan(0);
    expect(diff.removed).toHaveLength(0);
  });

  test("compare_entities accepts two explicit runs in either order", async () => {
    const forward = await call("compare_entities", {
      from_run_id: beforeRun,
      to_run_id: afterRun,
    });
    const backward = await call("compare_entities", {
      from_run_id: afterRun,
      to_run_id: beforeRun,
    });
    // Chronological regardless of the order they were named, so a diff always
    // reads forward in time.
    expect(backward.data.fromRunId).toBe(forward.data.fromRunId);
    expect(backward.data.toRunId).toBe(forward.data.toRunId);
  });

  test("get_entity_findings returns the stored verdicts", async () => {
    // Nothing has been analyzed in this fixture store, so there are no rule
    // results. The tool must say that plainly rather than inventing a clean
    // bill of health.
    const { data } = await call("get_entity_findings");
    expect(Array.isArray(data.findings)).toBe(true);
    expect(data.findings).toHaveLength(0);
    expect(data.runId).toBe(afterRun);
  });
});

describe("the fix-and-verify loop, end to end", () => {
  // The loop the tool descriptions promise: find the entities with no `@id`,
  // fix them, re-audit, and confirm they appear under `gainedId`. If this
  // fails, the descriptions are making a promise the tools do not keep.
  test("no-id entities found before the fix appear under gainedId after it", async () => {
    // A site that declares one Organization on three pages with no `@id`.
    const before = synthetic({ withId: false });
    // The same site after someone gave it one.
    const after = synthetic({ withId: true });

    await seed({
      project: "loop",
      baseUrl: "https://loop.example/",
      startedAt: 1_000_000,
      map: before,
    });

    const listed = await call("list_entities", { problem: ["no-id"] });
    const flagged = (
      listed.data.entities as Array<{ key: string; name: string }>
    ).map((row) => row.name);
    expect(flagged).toContain("Loop Ltd");

    // The agent fixes the markup and re-audits. Seeding the "after" map is
    // what a re-audit produces.
    await seed({
      project: "loop",
      baseUrl: "https://loop.example/",
      startedAt: 2_000_000,
      map: after,
    });

    const compared = await call("compare_entities");
    const diff = compared.data.diff as {
      gainedId: Array<{ name: string | null; id: string | null }>;
      added: unknown[];
      removed: unknown[];
    };

    // The whole point: a fixed entity is ONE transition, not a removal plus an
    // addition. Its key changed, so a naive diff would report both.
    expect(diff.gainedId.map((change) => change.name)).toContain("Loop Ltd");
    expect(diff.gainedId[0]?.id).toBe("https://loop.example/#organization");
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});

/** A three-page site declaring one Organization, with or without an `@id`. */
function synthetic(options: { withId: boolean }): EntityMap {
  const pages = [
    "https://loop.example/",
    "https://loop.example/about",
    "https://loop.example/contact",
  ];
  const key = options.withId
    ? "id:https://loop.example/#organization"
    : "syn:Organization|name:loop ltd";
  return {
    format: "squirrelscan/entity-map",
    version: 1,
    site: "https://loop.example/",
    generatedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      nodeCount: 1,
      edgeCount: 0,
      danglingCount: 0,
      pagesTotal: pages.length,
      pagesWithoutEntities: 0,
      nodesWithStableId: options.withId ? 1 : 0,
      stableIdShare: options.withId ? 1 : 0,
      pageLocalCount: 0,
      nodesWithoutIdCount: options.withId ? 0 : 1,
      conflictCount: 0,
      countsByType: { Organization: 3 },
    },
    nodes: [
      {
        key,
        id: options.withId ? "https://loop.example/#organization" : null,
        types: ["Organization"],
        name: "Loop Ltd",
        properties: { name: "Loop Ltd", url: "https://loop.example/" },
        occurrences: 3,
        pages,
        morePages: 0,
        conflicts: [],
        danglingRefs: 0,
        pageLocal: false,
      },
    ],
    edges: [],
    pages: pages.map((url) => ({
      url,
      declares: [key],
      references: [],
      entityCount: 1,
    })),
  };
}

describe("an empty result is not a claim about the site", () => {
  // The failure this prevents: an agent filters for a type the site does not
  // use, gets back "This site declares no JSON-LD entities", and reports that
  // the site has no structured data. It has 183 entities.
  beforeEach(async () => {
    await seed({
      project: "docs",
      baseUrl: "https://docs.squirrelscan.com/",
      startedAt: 2_000_000,
      map: await fixture("docs-after-jsonld"),
    });
  });

  test("a filter that matches nothing says so, in both prose formats", async () => {
    for (const format of ["mermaid", "markdown"]) {
      const { data } = await call("get_entity_graph", {
        format,
        type: ["NoSuchTypeAnywhere"],
      });
      const content = data.content as string;
      expect(data.nodeCount).toBe(0);
      expect(content).toContain("No entity match");
      // The sentence that would have been a lie.
      expect(content).not.toContain("This site declares no JSON-LD entities");
    }
  });

  test("a site that really declares nothing still says THAT", async () => {
    // The before snapshot is the same site with no JSON-LD at all, so the
    // original sentence is true and must survive.
    const beforeRun = await seed({
      project: "empty",
      baseUrl: "https://empty.example/",
      startedAt: 3_000_000,
      map: await fixture("docs-before-jsonld"),
    });
    const { data } = await call("get_entity_graph", {
      run_id: beforeRun,
      format: "mermaid",
    });
    expect(data.nodeCount).toBe(0);
    expect(data.content as string).toContain("declares no JSON-LD entities");
  });

  test("the machine-readable formats need no such message", async () => {
    // An empty `nodes` array is unambiguous data; only prose can be wrong.
    const { data } = await call("get_entity_graph", {
      format: "json",
      type: ["NoSuchTypeAnywhere"],
    });
    const parsed = JSON.parse(data.content as string) as { nodes: unknown[] };
    expect(parsed.nodes).toHaveLength(0);
  });
});
