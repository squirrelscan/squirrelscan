// `list_pages` (#701). The store read is injected, so no project store or process-wide patch is involved.

import type { PageMapRow } from "@squirrelscan/report";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";

import { err, commandError, ErrorCodes, ok } from "@/controllers/types";
import { registerPageTools, type PageMapLoader } from "@/mcp/tools/page-tools";

function row(path: string, over: Partial<PageMapRow> = {}): PageMapRow {
  const url = `https://example.com${path}`;
  return {
    url,
    finalUrl: url,
    status: 200,
    depth: 1,
    canonical: url,
    noindex: false,
    title: "A title",
    titleLength: 7,
    description: "A description",
    descriptionLength: 13,
    h1Count: 1,
    h1: "Heading",
    headingCount: 2,
    wordCount: 300,
    schemaTypes: [],
    schemaIds: [],
    inlinks: 3,
    internalOutlinks: 4,
    externalOutlinks: 0,
    externalDomains: [],
    loadTimeMs: 100,
    lastModified: null,
    flags: [],
    ...over,
  };
}

const ROWS = [
  row("/"),
  row("/blog/a", { title: null, titleLength: 0, flags: ["no-schema"] }),
  row("/blog/b", { flags: ["duplicate-title"] }),
  row("/about"),
];

const loader: PageMapLoader = async () =>
  ok({
    crawl: {
      id: "crawl-1",
      baseUrl: "https://example.com",
      startedAt: 0,
    } as never,
    rows: ROWS,
    warnings: ["w"],
  });

async function connect(load: PageMapLoader) {
  const server = new McpServer({ name: "t", version: "0" });
  registerPageTools(server, load);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({
    name: "list_pages",
    arguments: args,
  })) as { content: Array<{ text?: string }>; isError?: boolean };
  return result;
}

describe("list_pages", () => {
  test("returns every row with the CLI row shape", async () => {
    const client = await connect(loader);
    const body = JSON.parse((await call(client, {})).content[0]!.text!);
    expect(body.total).toBe(4);
    expect(body.pagesInAudit).toBe(4);
    expect(body.hasMore).toBe(false);
    expect(body.runId).toBe("crawl-1");
    expect(body.warnings).toEqual(["w"]);
    expect(body.pages[0]).toEqual(ROWS[0]);
  });

  test("pages with limit, offset and hasMore", async () => {
    const client = await connect(loader);
    const first = JSON.parse(
      (await call(client, { limit: 3 })).content[0]!.text!
    );
    expect(first.pages).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const next = JSON.parse(
      (await call(client, { limit: 3, offset: 3 })).content[0]!.text!
    );
    expect(next.pages).toHaveLength(1);
    expect(next.hasMore).toBe(false);
  });

  test("filters combine", async () => {
    const client = await connect(loader);
    const body = JSON.parse(
      (await call(client, { section: "/blog", missing: ["title"] })).content[0]!
        .text!
    );
    expect(body.pages.map((p: PageMapRow) => p.url)).toEqual([
      "https://example.com/blog/a",
    ]);
    expect(body.total).toBe(1);
    expect(body.pagesInAudit).toBe(4);
  });

  test("a store error is a tool error", async () => {
    const client = await connect(async () =>
      err(commandError(ErrorCodes.CRAWL_NOT_FOUND, "No audit yet"))
    );
    const result = await call(client, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No audit yet");
  });
});
