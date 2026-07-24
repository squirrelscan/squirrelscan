// Local stdio MCP server (#112): exposes squirrelscan to agents (Claude Code, Cursor).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { warnIfSessionUnreadable } from "@/self/credentials";

import { version } from "../../package.json";
import { type LoginResolver } from "./cloud";
import { registerAuditTools } from "./tools/audit-tools";
import { registerIssueTools } from "./tools/issue-tools";
import { registerReportTools } from "./tools/report-tools";
import { registerRuleTools } from "./tools/rule-tools";

export interface McpServerOptions {
  // Override the credential check (tests inject a logged-in/out resolver).
  resolveLogin?: LoginResolver;
}

// Build the server with every v1 tool registered (exported for tests).
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "squirrelscan",
    version,
  });

  registerAuditTools(server);
  registerReportTools(server, options.resolveLogin);
  registerIssueTools(server, options.resolveLogin);
  registerRuleTools(server);

  return server;
}

// Process-wide redirect so stray stdout console output (log/info/debug) can't corrupt the JSON-RPC stream.
function redirectConsoleLogToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

// Start the stdio server and block until the transport closes (mutates global console.log — not for tests).
export async function runMcpServer(): Promise<void> {
  redirectConsoleLogToStderr();
  // Loud warning for an unreadable/corrupt session (EACCES, corrupt JSON,
  // ...) — was audit-only (#805), extended to every command entry including
  // the MCP entry (#1062). Uses console.error, so stdout (the JSON-RPC
  // channel) is never touched — safe regardless of ordering relative to the
  // redirect above, which only ever affected console.log/info/debug.
  warnIfSessionUnreadable();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
