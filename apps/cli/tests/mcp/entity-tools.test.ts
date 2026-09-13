// The five entity MCP tools (#2095, epic section 8).
//
// Driven through a REAL seeded project store rather than a stubbed controller,
// because the questions these tools answer are questions about storage: which
// crawl is the latest, which two belong to the same site, whether a map
// survived the round trip. A stub would answer all of those by assumption.
//
// The fixtures are the two docs.squirrelscan.com snapshots committed with
// #2092: the same 60-page site before and after it gained JSON-LD. "Before" is
// the site declaring NO structured data at all — zero entities, not entities
// with a problem — and "after" is the same 60 pages carrying 183 of them. That
// pair is what makes the store questions real: which crawl is the latest, which
// two belong to the same site, whether a map survives the round trip.
//
// The fix-and-verify loop needs a before/after where the SAME entity changes,
// which those two snapshots are not, so `synthetic()` below builds it.

import type { EntityMap } from "@squirrelscan/core-contracts/entity-map";

import { ENTITY_MCP_FIELD_DESCRIPTIONS } from "@squirrelscan/core-contracts/entity-mcp";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
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
//
// Captured before the mock: `mock.module` rewrites the live bindings of an
// already-imported namespace, so reading `realOs.homedir` afterwards would hand
// back the mock and the restore below would be a no-op.
const realHomedir = realOs.homedir;

// `default` as well as the named export. A module that does `import os from
// "node:os"` reads the default object, and a spread of the namespace copies the
// UNPATCHED default straight through — so half the callers would keep resolving
// the developer's real home while the other half used the temp one, which is a
// harder bug to see than no mock at all.
function osModule(homedirFn: () => string): Record<string, unknown> {
  const patched = { ...realOs, homedir: homedirFn };
  return { ...patched, default: patched };
}

mock.module("node:os", () => osModule(() => home));

afterAll(() => {
  // `mock.module` replaces the entry for the whole PROCESS, and `bun test` runs
  // every file in one process. Left in place, the next file to import node:os
  // gets a homedir pointing at a directory this file has already deleted.
  mock.module("node:os", () => osModule(realHomedir));
});

/**
 * The fixture, with the fields older exports predate filled in.
 *
 * Two repairs. The first matches what the CLI's own `--input` loader does; the
 * second does NOT, and is a liberty this file takes to get a usable store.
 *
 * `pageLocal` and three summary counters were added to v1 after these files
 * were written, and are recomputable from the nodes with certainty.
 *
 * `pages` is the awkward one, and the CLI reconstructs nothing here — it reads
 * whatever the document carries. `docs-after-jsonld.json` carries `pages: []`
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
 *
 * The `pages` ROWS matter as much as the map. `loadEntityMap` rebuilds a
 * document's page set from `getCrawlPageUrls`, which reads the pages table, not
 * the stored map. Seeding a crawl without them produced a map with no pages at
 * all, and since the diff decides "removed versus not crawled" — and now
 * "proven versus partial" — from exactly that set, every coverage assertion
 * would have passed for the wrong reason: nothing is ever provably covered when
 * the newer audit is recorded as having visited nothing.
 */
async function seed(options: {
  project: string;
  baseUrl: string;
  startedAt: number;
  map: EntityMap;
  /** Overrides the map's own page list; use it to seed a narrower re-crawl. */
  crawledPages?: string[];
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
    for (const url of options.crawledPages ??
      options.map.pages.map((page) => page.url)) {
      await Effect.runPromise(
        storage.upsertPage(crawlId, {
          url,
          normalizedUrl: url,
          finalUrl: url,
          depth: 0,
          parentUrl: null,
          redirectChain: null,
          // `getCrawlPageUrls` takes 2xx only, keyed by the final url, to match
          // the collector's page universe exactly.
          status: 200,
          contentType: "text/html",
          sizeBytes: 0,
          loadTimeMs: 0,
          ttfb: null,
          downloadTime: null,
          fetchedAt: options.startedAt,
          etag: null,
          lastModified: null,
          // NOT NULL in the schema, and nothing under test reads it.
          contentHash: "seeded",
          // Null, so the insert does not reach for the content store: nothing
          // under test reads a page's markup.
          html: null,
          parsedData: null,
          headers: {},
          securityHeaders: {},
          requestHeaders: null,
        } as unknown as Parameters<typeof storage.upsertPage>[1])
      );
    }
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

/** One JSON Schema property, as a client is sent it. */
interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  items?: SchemaProperty;
}

/** The input schema each tool advertises, keyed by tool name. */
async function listTools(): Promise<
  Map<
    string,
    { properties?: Record<string, SchemaProperty>; required?: string[] }
  >
> {
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
  const listHandler = handlers.get("tools/list");
  if (!listHandler) throw new Error("the server registered no tools/list");

  const result = (await listHandler(
    { method: "tools/list", params: {} },
    {
      signal: new AbortController().signal,
      requestId: 1,
      sendNotification: () => {},
      sendRequest: () => {},
    }
  )) as {
    tools: Array<{
      name: string;
      inputSchema: {
        properties?: Record<string, SchemaProperty>;
        required?: string[];
      };
    }>;
  };
  return new Map(result.tools.map((tool) => [tool.name, tool.inputSchema]));
}

/** The shared wording for one field, per-tool overriding the common group. */
function fieldDescription(tool: string, field: string): string {
  const groups = ENTITY_MCP_FIELD_DESCRIPTIONS as unknown as Record<
    string,
    Record<string, string>
  >;
  return groups[tool]?.[field] ?? groups.common![field]!;
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

  test("the advertised input matches the contract's field spec exactly", async () => {
    // The contract exists so two independently-written servers accept and
    // reject the same calls. Prose cannot enforce that; this can. Asserted
    // against the JSON Schema a client is actually SENT, not against the zod
    // object behind it: the wire schema is the thing both servers have to agree
    // on, and it is the only version an agent ever reads.
    const advertised = await listTools();
    const { ENTITY_MCP_INPUT_FIELDS, ENTITY_MCP_CLOUD_ONLY_FIELDS } =
      await import("@squirrelscan/core-contracts/entity-mcp");

    const expectedJsonType = {
      string: "string",
      "string[]": "array",
      boolean: "boolean",
      integer: "integer",
    } as const;

    for (const [tool, fields] of Object.entries(ENTITY_MCP_INPUT_FIELDS)) {
      const schema = advertised.get(tool);
      if (!schema) throw new Error(`${tool} is not registered`);
      const properties = schema.properties ?? {};
      const required = schema.required ?? [];

      // Exact, not a subset. A subset check passes for a server that quietly
      // accepts a field the other one has never heard of.
      expect(Object.keys(properties).sort()).toEqual(
        Object.keys(fields).sort()
      );
      expect(required.sort()).toEqual(
        Object.entries(fields)
          .filter(([, spec]) => spec.required)
          .map(([field]) => field)
          .sort()
      );

      for (const [field, spec] of Object.entries(fields)) {
        const property = properties[field]!;
        expect(property.type).toBe(expectedJsonType[spec.kind]);
        // A description on every field, matching the shared wording. The
        // descriptions ARE the interface for a model, so drift between the two
        // servers' wording is drift in the tool.
        expect(property.description).toBe(fieldDescription(tool, field));

        if (spec.values) {
          // On the items for an array, on the property itself for a scalar.
          const holder = spec.kind === "string[]" ? property.items! : property;
          expect(holder.enum).toEqual([...spec.values]);
        }
        if (spec.kind === "string[]") {
          expect(property.items?.type).toBe("string");
        }
        if (spec.min !== undefined) expect(property.minimum).toBe(spec.min);
        if (spec.max !== undefined) expect(property.maximum).toBe(spec.max);
      }

      // The local server reads one machine's project store, where a website id
      // means nothing. Naming the difference is what lets the check above be an
      // equality rather than a subset.
      for (const cloudOnly of ENTITY_MCP_CLOUD_ONLY_FIELDS) {
        expect(Object.keys(properties)).not.toContain(cloudOnly);
      }
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
    // `truncated: false` is the CLAIM; this checks the claim. Every one of the
    // four has to contain every entity, because the whole value of "complete"
    // is that an agent can stop wondering whether it saw the site.
    //
    // Paged, because `list_entities` caps at 100 and the docs site declares 183.
    // Taking one page as "every entity" is the same mistake the assertion is
    // meant to catch.
    const keys: string[] = [];
    let total = 0;
    for (let offset = 0; ; offset += 100) {
      const { data } = await call("list_entities", {
        limit: 100,
        offset,
        include_page_local: true,
      });
      total = data.total as number;
      for (const row of data.entities as Array<{ key: string }>) {
        keys.push(row.key);
      }
      if (!data.hasMore) break;
    }
    expect(keys.length).toBe(total);

    // Counted out of each rendering rather than trusting `nodeCount`, which is
    // the renderer reporting on itself. dot and graphml replace the key with a
    // synthetic id, so they are counted by their own node syntax.
    const nodesIn: Record<string, (content: string) => number> = {
      json: (content) =>
        (JSON.parse(content) as { nodes: unknown[] }).nodes.length,
      jsonld: (content) =>
        (JSON.parse(content) as { "@graph": unknown[] })["@graph"].length,
      // `  n12 [label=…]`, one per node; the dangling placeholders use `d<n>`.
      dot: (content) => content.match(/^ {2}n\d+ \[label=/gm)?.length ?? 0,
      graphml: (content) => content.match(/<node id="n\d+">/g)?.length ?? 0,
    };

    for (const [format, count] of Object.entries(nodesIn)) {
      const { data } = await call("get_entity_graph", {
        format,
        include_page_local: true,
      });
      expect((data.truncation as { truncated: boolean }).truncated).toBe(false);
      expect(count(data.content as string)).toBe(total);
      expect(data.nodeCount).toBe(total);
    }

    // And the two that carry keys carry all of them, so "complete" is about the
    // right entities and not merely the right number of them.
    const { data: json } = await call("get_entity_graph", {
      format: "json",
      include_page_local: true,
    });
    const rendered = new Set(
      (
        JSON.parse(json.content as string) as { nodes: Array<{ key: string }> }
      ).nodes.map((node) => node.key)
    );
    expect(keys.filter((key) => !rendered.has(key))).toEqual([]);
  });

  test("the docs snapshot needs no invented @ids, and says so", async () => {
    // Every entity on the docs site carries an `@id`, so there is nothing to
    // disclose. An empty list here is the honest answer, not a missing feature.
    const { data } = await call("get_entity_graph", { format: "jsonld" });
    expect(data.generatedIds).toEqual([]);
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

  test("get_entity_findings distinguishes 'nothing wrong' from 'never checked'", async () => {
    // Nothing has been analyzed in this fixture store, so there are no rule
    // results. Three empty arrays is ALSO what a flawless entity graph returns,
    // and only one of the two is good news, so the emptiness alone is not the
    // assertion worth making — `analyzed` is.
    const { data } = await call("get_entity_findings");
    expect(data.analyzed).toBe(false);
    expect(data.findings).toHaveLength(0);
    expect(data.passed).toHaveLength(0);
    expect(data.skipped).toHaveLength(0);
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
      gainedId: Array<{
        name: string | null;
        id: string | null;
        coverage: string;
      }>;
      added: unknown[];
      removed: unknown[];
    };

    // The whole point: a fixed entity is ONE transition, not a removal plus an
    // addition. Its key changed, so a naive diff would report both.
    expect(diff.gainedId.map((change) => change.name)).toContain("Loop Ltd");
    expect(diff.gainedId[0]?.id).toBe("https://loop.example/#organization");
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    // The re-audit visited all three pages that were broken, so the fix is
    // proven across the site rather than observed somewhere.
    expect(diff.gainedId[0]?.coverage).toBe("proven");
  });

  test("a re-audit that missed the broken pages reports the fix as partial", async () => {
    // The failure mode the coverage field exists for, through the real store.
    // The agent fixes the markup but re-audits a narrower slice. Identity
    // matching still pairs the two — it IS the same entity — so `gainedId`
    // fires, and without a coverage field the agent reads that as done while
    // the two pages it was sent to fix were never looked at again.
    await seed({
      project: "narrow",
      baseUrl: "https://narrow.example/",
      startedAt: 1_000_000,
      map: synthetic({ withId: false, site: "https://narrow.example/" }),
    });

    const fixed = synthetic({ withId: true, site: "https://narrow.example/" });
    const onlyContact = fixed.pages.filter((page) =>
      page.url.endsWith("/contact")
    );
    await seed({
      project: "narrow",
      baseUrl: "https://narrow.example/",
      startedAt: 2_000_000,
      map: {
        ...fixed,
        nodes: fixed.nodes.map((node) => ({
          ...node,
          pages: onlyContact.map((page) => page.url),
          occurrences: 1,
        })),
        pages: onlyContact,
      },
      crawledPages: onlyContact.map((page) => page.url),
    });

    const compared = await call("compare_entities");
    const diff = compared.data.diff as {
      gainedId: Array<{ coverage: string }>;
    };
    expect(diff.gainedId).toHaveLength(1);
    expect(diff.gainedId[0]?.coverage).toBe("partial");
  });
});

/** A three-page site declaring one Organization, with or without an `@id`. */
function synthetic(options: { withId: boolean; site?: string }): EntityMap {
  const site = options.site ?? "https://loop.example/";
  const pages = [site, `${site}about`, `${site}contact`];
  const key = options.withId
    ? `id:${site}#organization`
    : "syn:Organization|name:loop ltd";
  return {
    format: "squirrelscan/entity-map",
    version: 1,
    site,
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
        id: options.withId ? `${site}#organization` : null,
        types: ["Organization"],
        name: "Loop Ltd",
        properties: { name: "Loop Ltd", url: site },
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

describe("an audit the loader passed over is named, not hidden", () => {
  // The quietest failure in the whole surface. The loader picks the newest
  // audit that stored at least one entity, because zero entities is also what
  // an audit predating the entity map looks like. So a template regression that
  // wipes a site's JSON-LD makes today's audit store nothing, the loader falls
  // back to yesterday, and an agent asking "is the structured data OK" is shown
  // yesterday's healthy graph with no indication it is looking at the past.
  test("list_entities warns when a newer audit stored no entities", async () => {
    const good = await seed({
      project: "regressed",
      baseUrl: "https://regressed.example/",
      startedAt: 1_000_000,
      map: synthetic({ withId: true, site: "https://regressed.example/" }),
    });
    const empty = synthetic({
      withId: true,
      site: "https://regressed.example/",
    });
    const wiped = await seed({
      project: "regressed",
      baseUrl: "https://regressed.example/",
      startedAt: 2_000_000,
      map: {
        ...empty,
        summary: { ...empty.summary, nodeCount: 0, countsByType: {} },
        nodes: [],
        edges: [],
        pages: empty.pages.map((page) => ({
          ...page,
          declares: [],
          entityCount: 0,
        })),
      },
    });

    const { data } = await call("list_entities");
    // It really did fall back.
    expect(data.runId).toBe(good);
    const warnings = data.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    // And it names the audit it passed over, so the agent can go look.
    expect(warnings.join(" ")).toContain(wiped);
    expect(warnings.join(" ")).toContain("NOT the most recent");
  });

  test("no warning when the latest audit is the one returned", async () => {
    await seed({
      project: "clean",
      baseUrl: "https://clean.example/",
      startedAt: 1_000_000,
      map: synthetic({ withId: true, site: "https://clean.example/" }),
    });
    const { data } = await call("list_entities");
    expect(data.warnings).toEqual([]);
  });
});

describe("a finding points at something get_entity can look up", () => {
  test("conflict findings carry the entity key, not the composite item id", async () => {
    // `schema/entity-conflicts` ids its items `"<key> <property>"` so two
    // conflicts on one entity stay two rows. Handing that composite to
    // get_entity finds nothing: the agent is told which entity is broken in a
    // form it cannot use to look the entity up.
    const map = synthetic({ withId: true, site: "https://conflict.example/" });
    const key = map.nodes[0]!.key;
    const crawlId = await seed({
      project: "conflict",
      baseUrl: "https://conflict.example/",
      startedAt: 1_000_000,
      map,
    });

    await seedConflictFinding({
      project: "conflict",
      crawlId,
      pageUrl: "https://conflict.example/",
      key,
    });

    const { data } = await call("get_entity_findings");
    expect(data.analyzed).toBe(true);
    const findings = data.findings as Array<{ ruleId: string; keys: string[] }>;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.keys).toEqual([key]);

    // The actual promise: every key a finding reports can be fetched.
    for (const reported of findings[0]!.keys) {
      const looked = await call("get_entity", { key: reported });
      expect(looked.ok).toBe(true);
    }
  });

  test("a finding never claims a complete affected set", async () => {
    // A finding's pages were clipped by the rule before this tool saw them, and
    // nothing in the pipeline records how many were dropped, so the flag is
    // standing rather than conditional on this tool's own cap.
    const map = synthetic({ withId: true, site: "https://sample.example/" });
    const crawlId = await seed({
      project: "sample",
      baseUrl: "https://sample.example/",
      startedAt: 1_000_000,
      map,
    });
    await seedConflictFinding({
      project: "sample",
      crawlId,
      pageUrl: "https://sample.example/",
      key: map.nodes[0]!.key,
    });

    const { data } = await call("get_entity_findings");
    const truncation = data.truncation as {
      truncated: boolean;
      notice: string;
    };
    expect(truncation.truncated).toBe(true);
    expect(truncation.notice).toContain("sample");
    expect(truncation.notice).toContain("list_entities");
  });

  test("no findings means there is nothing to be a sample of", async () => {
    // The mirror. An unanalyzed audit has no finding whose pages could have
    // been clipped, and claiming truncation there would be its own small lie.
    await seed({
      project: "unanalyzed",
      baseUrl: "https://unanalyzed.example/",
      startedAt: 1_000_000,
      map: synthetic({ withId: true, site: "https://unanalyzed.example/" }),
    });
    const { data } = await call("get_entity_findings");
    expect(data.analyzed).toBe(false);
    expect(data.truncation).toEqual({ truncated: false, notice: "" });
  });
});

/**
 * One stored `schema/entity-conflicts` verdict.
 *
 * Its item id is deliberately the composite the real rule emits, `"<key>
 * <property>"`, with the entity key in `meta` — that shape is the whole point
 * of the key test below it.
 */
async function seedConflictFinding(options: {
  project: string;
  crawlId: string;
  pageUrl: string;
  key: string;
}): Promise<void> {
  const { createStorage } = await import("@/crawler/storage");
  const storage = await Effect.runPromise(
    createStorage({ projectName: options.project, silent: true })
  );
  try {
    await Effect.runPromise(
      storage.saveRuleResults(
        options.crawlId,
        options.pageUrl,
        "schema/entity-conflicts",
        [
          {
            name: "entity-conflicts",
            status: "fail",
            message: "1 entity disagrees with itself across pages",
            items: [
              {
                id: `${options.key} telephone`,
                label: "Loop Ltd — telephone",
                sourcePages: [options.pageUrl],
                meta: {
                  key: options.key,
                  property: "telephone",
                  valueCount: 2,
                },
              },
            ],
          },
        ] as never
      )
    );
  } finally {
    await Effect.runPromise(
      storage.close().pipe(Effect.catchAll(() => Effect.void))
    );
  }
}

describe("the jsonld export discloses the @ids it invents", () => {
  // The whole reason this field exists. The export mints an `@id` for every
  // entity the site left anonymous, and JSON-LD has nowhere to mark an
  // identifier as a placeholder. An agent that was sent here BY a no-id finding
  // sees a graph in which everything is identified, and would reasonably read
  // it as the current state of the site.
  beforeEach(async () => {
    await seed({
      project: "anon",
      baseUrl: "https://anon.example/",
      startedAt: 1_000_000,
      map: synthetic({ withId: false, site: "https://anon.example/" }),
    });
  });

  test("every invented id is named, and matches the anonymous entities", async () => {
    const { data } = await call("get_entity_graph", { format: "jsonld" });
    const generated = data.generatedIds as Array<{ key: string; id: string }>;
    const graph = JSON.parse(data.content as string) as {
      "@graph": Array<{ "@id": string }>;
    };

    expect(generated).toHaveLength(1);
    expect(generated[0]?.key).toBe("syn:Organization|name:loop ltd");
    // The invented id really is in the document, so a reader can match the two.
    const exported = graph["@graph"].map((member) => member["@id"]);
    expect(exported).toContain(generated[0]!.id);

    // And it is exactly the set of entities the listing calls anonymous.
    const listed = await call("list_entities", { include_page_local: true });
    const anonymous = (
      listed.data.entities as Array<{ key: string; id: string | null }>
    ).filter((row) => row.id === null);
    expect(generated.map((entry) => entry.key)).toEqual(
      anonymous.map((row) => row.key)
    );
  });

  test("no other format invents anything", async () => {
    for (const format of ["json", "mermaid", "dot", "graphml", "markdown"]) {
      const { data } = await call("get_entity_graph", { format });
      expect(data.generatedIds).toEqual([]);
    }
  });
});

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
