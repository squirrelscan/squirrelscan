// Smoke test: spawn `squirrel mcp`, list tools, call free local tools. Not part of CI.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Set SQUIRREL_BIN to exercise a standalone binary; defaults to running the source via bun.
const bin = process.env.SQUIRREL_BIN;
const transport = new StdioClientTransport({
  command: bin ?? "bun",
  args: bin ? ["mcp"] : ["src/cli.ts", "mcp"],
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.error(
  `TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}`
);

const rules = await client.callTool({ name: "list_rules", arguments: {} });
const ruleText = (rules.content as Array<{ text?: string }>)[0]?.text ?? "";
console.error(`list_rules count: ${JSON.parse(ruleText).count}`);

const target = process.argv[2] ?? "https://example.com";
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
