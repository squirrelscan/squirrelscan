// squirrel mcp — run the local stdio MCP server (#112).

import { defineCommand } from "citty";

export const mcp = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Run the local MCP server (stdio) for agents like Claude Code and Cursor",
  },
  async run() {
    // stdout is the JSON-RPC channel — keep all logs on stderr (logger default).
    const { runMcpServer } = await import("@/mcp/server");
    await runMcpServer();
  },
});
