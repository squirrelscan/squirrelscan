// Protocol eras over stdio. `squirrel mcp` serving both eras is covered in frontend.test.ts.

import { Client, type ClientOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

const cliRoot = join(import.meta.dir, "../..");
const MODERN = "2026-07-28";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
});

function negotiation(mode: "legacy" | "auto" | "modern"): ClientOptions {
  return {
    versionNegotiation:
      mode === "modern" ? { mode: { pin: MODERN } } : { mode },
  };
}

async function connectStdio(
  script: string[],
  mode: "legacy" | "auto" | "modern"
): Promise<Client> {
  const client = new Client(
    { name: "test", version: "0.0.0" },
    negotiation(mode)
  );
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: script,
      cwd: cliRoot,
      stderr: "ignore",
    })
  );
  return client;
}

// The channel (#569) must keep the legacy handshake. A hand-wired v2 `Server` on `StdioServerTransport` is how it can, so pin that behavior here: if an SDK upgrade changes it, this fails before the channel stops registering.
describe("a hand-wired v2 stdio server stays on the legacy handshake", () => {
  const entry = ["tests/mcp/fixtures/legacy-only-server.ts"];

  test("an auto-negotiating client is served the 2025-era handshake", async () => {
    const client = await connectStdio(entry, "auto");
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(
      "claude/channel"
    );
  }, 30_000);

  test("a client that insists on 2026-07-28 is refused", async () => {
    await expect(connectStdio(entry, "modern")).rejects.toThrow(
      /negotiation failed/i
    );
  }, 30_000);
});
