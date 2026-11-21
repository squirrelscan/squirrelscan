// Local stdio MCP server (#112): exposes squirrelscan to agents (Claude Code, Cursor).

import { McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { newCrashReference, reportCrash } from "@/self/crash-reporter";
import { warnIfSessionUnreadable } from "@/self/credentials";

import { version } from "../../package.json";
import { cancelActiveMcpRuns } from "./billed-audit";
import { type LoginResolver } from "./cloud";
import { errorResult } from "./result";
import { registerSkills } from "./skills";
import { registerAuditTools } from "./tools/audit-tools";
import { registerEntityTools } from "./tools/entity-tools";
import { registerFeedbackTools } from "./tools/feedback-tools";
import { registerIssueTools } from "./tools/issue-tools";
import { registerPageTools } from "./tools/page-tools";
import { registerReportTools } from "./tools/report-tools";
import { registerRuleTools } from "./tools/rule-tools";
import { registerSupportTools } from "./tools/support-tools";

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
  reportToolErrors(server);

  registerAuditTools(server);
  registerReportTools(server, options.resolveLogin);
  registerIssueTools(server, options.resolveLogin);
  registerRuleTools(server);
  // Threaded support tickets (#1090): need a logged-in session.
  registerSupportTools(server, options.resolveLogin);
  // Local and free: these read the project store, so no auth and no credits.
  registerEntityTools(server);
  registerPageTools(server);
  // No login and no credits, but it does need the network (#370).
  registerFeedbackTools(server);
  // The squirrelscan agent skills, the same bytes the hosted server serves.
  registerSkills(server);

  return server;
}

type ToolHandler = (...args: unknown[]) => unknown;

/**
 * A tool handler that throws is a bug (handlers return errorResult for
 * expected failures): the agent gets a clean tool error with a `cli_`
 * reference, stderr gets one line, and the crash is reported through the API
 * like a CLI crash (repo#705). Protocol errors are the SDK's own signalling
 * and pass through untouched. Exported for tests.
 */
export function wrapToolHandler(
  name: string,
  handler: ToolHandler
): ToolHandler {
  return async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      const reference = newCrashReference();
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `squirrel mcp: the ${name} tool hit an unexpected error (reference ${reference})`
      );
      void reportCrash(error, {
        reference,
        source: "mcp_tool",
        args: ["mcp"],
      });
      return errorResult(
        `The ${name} tool hit an unexpected error: ${message}\nReference: ${reference}`
      );
    }
  };
}

// Every tool registered on this server goes through wrapToolHandler.
function reportToolErrors(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    ...args: unknown[]
  ) => {
    const [name, , handler] = args;
    if (typeof name === "string" && typeof handler === "function") {
      args[2] = wrapToolHandler(name, handler as ToolHandler);
    }
    return register(...args);
  };
}

// Process-wide redirect so stray stdout console output (log/info/debug) can't corrupt the JSON-RPC stream.
function redirectConsoleLogToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

// On a shutdown signal, close the billed runs still in flight as cancelled
// (#628), then re-raise so the process ends the way the signal asked.
function cancelBilledRunsOnSignal(): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (signal: NodeJS.Signals): void => {
    // Cast: bun-types declares off("memoryPressure") on Process, hiding the
    // EventEmitter overloads (same as the audit command's signal handlers).
    const emitter = process as NodeJS.EventEmitter;
    for (const s of signals) emitter.off(s, onSignal);
    void cancelActiveMcpRuns()
      .catch(() => {})
      .finally(() => process.kill(process.pid, signal));
  };
  for (const s of signals) process.once(s, onSignal);
}

// Start the stdio server (mutates global console.log — not for tests). Returns once serving starts: like the v1 `connect`, the open stdin keeps the process alive until the client hangs up.
export async function runMcpServer(): Promise<void> {
  redirectConsoleLogToStderr();
  // Loud warning for an unreadable/corrupt session (EACCES, corrupt JSON,
  // ...) — was audit-only (#805), extended to every command entry including
  // the MCP entry (#1062). Uses console.error, so stdout (the JSON-RPC
  // channel) is never touched — safe regardless of ordering relative to the
  // redirect above, which only ever affected console.log/info/debug.
  warnIfSessionUnreadable();
  cancelBilledRunsOnSignal();
  // serveStdio picks the protocol era from the client's opening message: a
  // 2026-07-28 client (no `initialize`, `server/discover` for capabilities) and a
  // 2025-era client (`initialize` handshake) are both served from this factory. The factory runs once per connection, when the era is pinned.
  serveStdio(() => createMcpServer());
}
