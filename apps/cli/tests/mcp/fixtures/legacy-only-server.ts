// A hand-wired stdio server on the v2 SDK: `Server` + `StdioServerTransport`, no `serveStdio`.
// This is the shape `squirrel channel` needs, because Claude Code refuses to register a channel that negotiates 2026-07-28.
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server(
  { name: "legacy-only", version: "0.0.0" },
  { capabilities: { experimental: { "claude/channel": {} } } }
);
server.oninitialized = () => console.error("INITIALIZED");
await server.connect(new StdioServerTransport());
