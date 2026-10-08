// Smoke test: spawn `squirrel mcp`, list tools, call free local tools. Not part of CI.
// Usage: bun scripts/mcp-smoke.ts [url] [--protocol legacy|2026-07-28]
//   legacy (default): the 2025-era `initialize` handshake.
//   2026-07-28: pinned, no `initialize`; capabilities come from `server/discover`.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const args = process.argv.slice(2);
const protocolFlag = args.indexOf("--protocol");
const protocol = protocolFlag >= 0 ? args.splice(protocolFlag, 2)[1] : "legacy";
if (protocol !== "legacy" && protocol !== "2026-07-28") {
  console.error(`unknown --protocol ${protocol} (legacy | 2026-07-28)`);
  process.exit(2);
}

// Set SQUIRREL_BIN to exercise a standalone binary; defaults to running the source via bun.
const bin = process.env.SQUIRREL_BIN;
const transport = new StdioClientTransport({
  command: bin ?? "bun",
  args: bin ? ["mcp"] : ["src/cli.ts", "mcp"],
  stderr: "inherit",
});
const client = new Client(
  { name: "smoke", version: "0.0.0" },
  {
    versionNegotiation:
      protocol === "legacy"
        ? { mode: "legacy" }
        : { mode: { pin: "2026-07-28" } },
  }
);
await client.connect(transport);
console.error(`PROTOCOL ${protocol}: era=${client.getProtocolEra()}`);

const { tools } = await client.listTools();
console.error(
  `TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}`
);

const rules = await client.callTool({ name: "list_rules", arguments: {} });
const ruleText = (rules.content as Array<{ text?: string }>)[0]?.text ?? "";
console.error(`list_rules count: ${JSON.parse(ruleText).count}`);

const target = args[0] ?? "https://example.com";
console.error(`quick_check ${target} ...`);
const qc = await client.callTool({
  name: "quick_check",
  arguments: { url: target },
});
const qcText = (qc.content as Array<{ text?: string }>)[0]?.text ?? "";
console.error(
  `quick_check isError=${qc.isError ?? false}, bytes=${qcText.length}`
);
console.error(qcText.slice(0, 400));

console.error(`audit_website ${target} (offline) ...`);
const aw = await client.callTool({
  name: "audit_website",
  arguments: { url: target, coverage: "surface", offline: true },
});
const awText = (aw.content as Array<{ text?: string }>)[0]?.text ?? "";
console.error(
  `audit_website isError=${aw.isError ?? false}, bytes=${awText.length}`
);

const denied = await client.callTool({
  name: "list_issues",
  arguments: { websiteId: "w1" },
});
const deniedText = (denied.content as Array<{ text?: string }>)[0]?.text ?? "";
console.error(
  `list_issues isError=${denied.isError ?? false}: ${deniedText.slice(0, 80)}`
);

await client.close();
process.exit(0);
