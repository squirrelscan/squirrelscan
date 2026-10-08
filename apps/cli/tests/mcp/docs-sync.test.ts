// Keeps docs/cli/mcp.mdx and the tool descriptions honest: the Tools table
// must list exactly what `tools/list` returns, and no description may tell the
// model to call a tool unprompted or pitch a plan.

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createMcpServer } from "@/mcp/server";

const DOCS_PATH = join(import.meta.dir, "../../../../docs/cli/mcp.mdx");

async function listTools() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return (await client.listTools()).tools;
}

// Rows of the "## Tools" table in docs/cli/mcp.mdx, as tool name -> row text.
function docsToolRows(): Map<string, string> {
  const doc = readFileSync(DOCS_PATH, "utf8");
  const start = doc.indexOf("\n## Tools\n");
  expect(start).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const m = /^\| `([a-z_]+)` \|/.exec(line);
    if (m) rows.set(m[1]!, line);
  }
  return rows;
}

describe("docs/cli/mcp.mdx tool table", () => {
  test("lists exactly the tools the server exposes, once each", async () => {
    const tools = await listTools();
    const rows = docsToolRows();
    const doc = readFileSync(DOCS_PATH, "utf8");
    const documented = [...rows.keys()].sort();
    const served = tools.map((t) => t.name).sort();
    expect(documented).toEqual(served);
    for (const name of served) {
      const count = doc.split(`| \`${name}\` |`).length - 1;
      expect(count).toBe(1);
    }
  });
});

describe("tool descriptions", () => {
  test("never instruct the model to call a tool unprompted", async () => {
    for (const tool of await listTools()) {
      expect(tool.description ?? "").not.toMatch(
        /\b(any ?time|proactively|without being asked|unprompted|always call|you should call|call this (first|whenever))\b/i
      );
    }
  });

  test("carry no plan or upgrade pitch", async () => {
    for (const tool of await listTools()) {
      expect(tool.description ?? "").not.toMatch(
        /\b(upgrade|subscribe|pricing|top ?up|buy|purchase)\b/i
      );
    }
  });

  test("send_feedback says what it does and when a user wants it", async () => {
    const tool = (await listTools()).find((t) => t.name === "send_feedback");
    expect(tool?.description).toContain(
      "Send feedback to the squirrelscan team"
    );
    expect(tool?.description).toContain("when the user wants");
  });
});
