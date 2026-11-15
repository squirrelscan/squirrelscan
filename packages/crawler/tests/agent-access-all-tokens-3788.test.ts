// squirrelscan/repo#3788: the opt-in all-token agent access probe. Default sends exactly the old
// three requests; allTokens sends one per registry bot and records each response's X-Robots-Tag.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AGENT_ACCESS_BOTS } from "@squirrelscan/core-contracts/storage";

import { probeAgentAccess } from "../src/agent-access";

const GPTBOT = AGENT_ACCESS_BOTS.find((b) => b.id === "gptbot")!;
const CLAUDE_USER = AGENT_ACCESS_BOTS.find((b) => b.id === "claude-user")!;

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(): { url: string; uas: string[] } {
  const uas: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const ua = req.headers.get("user-agent") ?? "";
      uas.push(ua);
      const headers: Record<string, string> = { "content-type": "text/html" };
      if (ua === GPTBOT.userAgentString) headers["x-robots-tag"] = "noai";
      return new Response("<html><body>home</body></html>", { headers });
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}/`, uas };
}

describe("probeAgentAccess all tokens (#3788)", () => {
  test("default sends exactly the browser, GPTBot and Claude-User requests", async () => {
    const origin = serve();
    const data = await Effect.runPromise(probeAgentAccess(origin.url, "browser-ua"));
    expect(origin.uas.toSorted()).toEqual(
      ["browser-ua", GPTBOT.userAgentString, CLAUDE_USER.userAgentString].toSorted(),
    );
    expect(data.probes.map((p) => p.userAgent)).toEqual(["browser", "gptbot", "claude-user"]);
  });

  test("allTokens probes every registry bot once and records X-Robots-Tag per probe", async () => {
    const origin = serve();
    const data = await Effect.runPromise(
      probeAgentAccess(origin.url, "browser-ua", undefined, undefined, undefined, { allTokens: true }),
    );
    expect(origin.uas).toHaveLength(1 + AGENT_ACCESS_BOTS.length);
    for (const bot of AGENT_ACCESS_BOTS) {
      expect(origin.uas.filter((ua) => ua === bot.userAgentString)).toHaveLength(1);
    }
    expect(data.probes).toHaveLength(1 + AGENT_ACCESS_BOTS.length);
    for (const p of data.probes) {
      expect(p.xRobotsTag).toBe(p.userAgent === "gptbot" ? "noai" : null);
    }
  });

  test("allTokens false behaves as the default", async () => {
    const origin = serve();
    const data = await Effect.runPromise(
      probeAgentAccess(origin.url, "browser-ua", undefined, undefined, undefined, { allTokens: false }),
    );
    expect(origin.uas).toHaveLength(3);
  });
});
