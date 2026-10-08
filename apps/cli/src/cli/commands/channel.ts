// squirrel channel: push cloud audit events into a running Claude Code session (#569).

import { defineCommand } from "citty";

import {
  CHANNEL_CATEGORIES,
  DEFAULT_CHANNEL_CATEGORIES,
  type ChannelCategory,
  isChannelCategory,
} from "@/channel/events";

export function parseCategories(
  raw: string | undefined
): ChannelCategory[] | string {
  if (raw === undefined) return [...DEFAULT_CHANNEL_CATEGORIES];
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unknown = names.filter((name) => !isChannelCategory(name));
  if (names.length === 0 || unknown.length > 0) {
    return `Unknown category ${unknown.join(", ") || "(none given)"}. Choose from: ${CHANNEL_CATEGORIES.join(", ")}.`;
  }
  return names as ChannelCategory[];
}

export const channel = defineCommand({
  meta: {
    name: "channel",
    description:
      "Run the Claude Code channel (stdio) that pushes cloud audit events into a session",
  },
  args: {
    interval: {
      type: "string",
      description:
        "Seconds between polls of the cloud feed (default 30, min 5)",
    },
    categories: {
      type: "string",
      description: `Comma-separated categories to deliver (default ${DEFAULT_CHANNEL_CATEGORIES.join(",")})`,
    },
  },
  async run({ args }) {
    const categories = parseCategories(args.categories);
    if (typeof categories === "string") {
      console.error(categories);
      process.exit(1);
    }
    let intervalSeconds: number | undefined;
    if (args.interval !== undefined) {
      intervalSeconds = Number(args.interval);
      if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        console.error("--interval must be a positive number of seconds.");
        process.exit(1);
      }
    }
    // stdout is the JSON-RPC channel: keep all logs on stderr (logger default).
    const { runChannelServer } = await import("@/channel/server");
    await runChannelServer({
      categories,
      ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
    });
  },
});
