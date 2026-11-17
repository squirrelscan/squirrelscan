// squirrel channel: push cloud audit events into a running Claude Code session (#569).

import { defineCommand } from "citty";

import {
  CHANNEL_CATEGORIES,
  DEFAULT_CHANNEL_CATEGORIES,
  type ChannelCategory,
  isChannelCategory,
} from "@/channel/events";

// One day: far below the ~24.8 day setTimeout limit, past which a timer fires immediately.
const MAX_INTERVAL_SECONDS = 86_400;
const MIN_POLL_INTERVAL_SECONDS = 5;

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

// Seconds between polls: undefined when not given, an error message when out of range.
export function parseIntervalSeconds(
  raw: string | undefined
): number | string | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (
    !Number.isFinite(seconds) ||
    seconds < MIN_POLL_INTERVAL_SECONDS ||
    seconds > MAX_INTERVAL_SECONDS
  ) {
    return `--interval must be between ${MIN_POLL_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`;
  }
  return seconds;
}

export const channel = defineCommand({
  meta: {
    name: "channel",
    description:
      "Alias of `squirrel mcp --channel`: the Claude Code channel (stdio) that pushes cloud audit events into a session",
  },
  args: {
    interval: {
      type: "string",
      description:
        "Seconds between polls of the cloud feed (default 30, min 5, max 86400)",
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
    const intervalSeconds = parseIntervalSeconds(args.interval);
    if (typeof intervalSeconds === "string") {
      console.error(intervalSeconds);
      process.exit(1);
    }
    // stdout is the JSON-RPC channel: keep all logs on stderr (logger default).
    const { runChannelServer } = await import("@/channel/server");
    await runChannelServer({
      categories,
      ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
    });
  },
});
