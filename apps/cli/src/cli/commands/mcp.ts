// squirrel mcp: a stdio front end for the hosted MCP server (#737).

import { defineCommand } from "citty";

import { parseCategories, parseIntervalSeconds } from "./channel";

export const mcp = defineCommand({
  meta: {
    name: "mcp",
    description:
      "Run the MCP server (stdio) for agents like Claude Code and Cursor: the hosted squirrelscan tools, through your login",
  },
  args: {
    channel: {
      type: "boolean",
      description:
        "Also push cloud audit events into a Claude Code session (same as `squirrel channel`)",
    },
    interval: {
      type: "string",
      description:
        "With --channel: seconds between polls of the cloud feed (default 30, min 5, max 86400)",
    },
    categories: {
      type: "string",
      description:
        "With --channel: comma-separated event categories to deliver (default all)",
    },
  },
  async run({ args }) {
    // stdout is the JSON-RPC channel: keep all logs on stderr (logger default).
    if (!args.channel) {
      if (args.interval !== undefined || args.categories !== undefined) {
        console.error("--interval and --categories need --channel.");
        process.exit(1);
      }
      const { runMcpServer } = await import("@/mcp/server");
      await runMcpServer();
      return;
    }
    const categories = parseCategories(args.categories);
    if (typeof categories === "string") {
      console.error(categories);
      process.exit(1);
    }
    const intervalSeconds = parseIntervalSeconds(args.interval);
    if (typeof intervalSeconds === "string") {
      console.error(intervalSeconds);
      process.exit(1);
    }
    const { runMcpServer } = await import("@/mcp/server");
    await runMcpServer({
      channel: {
        categories,
        ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
      },
    });
  },
});
