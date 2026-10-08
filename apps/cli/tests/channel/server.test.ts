import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { LOGIN_REQUIRED_EVENT, type ChannelEvent } from "@/channel/events";
import {
  type LoopDeps,
  createChannelServer,
  nextDelayMs,
  runPollLoop,
  sendChannelEvent,
} from "@/channel/server";
import { emptyState } from "@/channel/state";
import { parseCategories } from "@/cli/commands/channel";

describe("channel server", () => {
  test("declares the channel capability, no permission relay, bounded instructions", async () => {
    const server = createChannelServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.experimental?.["claude/channel"]).toEqual({});
    expect(capabilities?.experimental).not.toHaveProperty(
      "claude/channel/permission"
    );
    expect(capabilities?.tools).toBeUndefined();
    expect(client.getInstructions()?.length).toBeLessThanOrEqual(8192);
    // Legacy handshake: the channel must not negotiate a newer revision.
    expect(server.transport).toBeDefined();
  });

  test("emits notifications/claude/channel with content and meta", async () => {
    const server = createChannelServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const received: Array<{ content: string; meta: Record<string, string> }> =
      [];
    client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/claude/channel"),
        params: z.object({
          content: z.string(),
          meta: z.record(z.string(), z.string()),
        }),
      }),
      async (notification) => {
        received.push(notification.params);
      }
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await sendChannelEvent(server, LOGIN_REQUIRED_EVENT);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([LOGIN_REQUIRED_EVENT]);
  });
});

describe("backoff", () => {
  test("doubles per failure and caps", () => {
    expect(nextDelayMs(30_000, 0)).toBe(30_000);
    expect(nextDelayMs(30_000, 1)).toBe(60_000);
    expect(nextDelayMs(30_000, 3)).toBe(240_000);
    expect(nextDelayMs(30_000, 20)).toBe(600_000);
  });
});

describe("runPollLoop", () => {
  function loop(opts: {
    logins: boolean[];
    responses?: Array<{ ok: false; status: number }>;
    ticks: number;
  }) {
    const events: ChannelEvent[] = [];
    const delays: number[] = [];
    const abort = new AbortController();
    let tick = 0;
    const responses = [...(opts.responses ?? [])];
    const deps: LoopDeps = {
      resolveLogin: () =>
        opts.logins[Math.min(tick, opts.logins.length - 1)] ? {} : null,
      resolveOrgId: async () => "org_1",
      fetchPage: async () => responses.shift() ?? { ok: false, status: 500 },
      createStore: () => {
        let state = emptyState();
        return {
          load: () => structuredClone(state),
          save: (next) => {
            state = next;
          },
        };
      },
      emit: async (event) => void events.push(event),
      sleep: async (ms) => {
        delays.push(ms);
        tick += 1;
        if (tick >= opts.ticks) abort.abort();
      },
    };
    const run = runPollLoop(
      { intervalSeconds: 30, categories: ["audit_complete"] },
      deps,
      abort.signal
    );
    return { run, events, delays };
  }

  test("no login: one explanatory event, keeps running", async () => {
    const h = loop({ logins: [false], ticks: 3 });
    await h.run;
    expect(h.events).toEqual([LOGIN_REQUIRED_EVENT]);
    expect(h.events[0]?.content).toContain("squirrel auth login");
    expect(h.delays).toEqual([30_000, 30_000, 30_000]);
  });

  test("429 and 5xx back off exponentially", async () => {
    const h = loop({
      logins: [true],
      responses: [
        { ok: false, status: 429 },
        { ok: false, status: 503 },
        { ok: false, status: 500 },
      ],
      ticks: 3,
    });
    await h.run;
    expect(h.delays).toEqual([60_000, 120_000, 240_000]);
  });

  test("401 announces the login problem once and slows down", async () => {
    const h = loop({
      logins: [true],
      responses: [
        { ok: false, status: 401 },
        { ok: false, status: 401 },
      ],
      ticks: 2,
    });
    await h.run;
    expect(h.events).toEqual([LOGIN_REQUIRED_EVENT]);
    expect(h.delays[0]).toBeGreaterThan(30_000);
  });
});

describe("parseCategories", () => {
  test("defaults, custom lists and unknown names", () => {
    expect(parseCategories(undefined)).toEqual([
      "audit_complete",
      "audit_failed",
      "issues_detected",
    ]);
    expect(parseCategories("audit_failed")).toEqual(["audit_failed"]);
    expect(parseCategories("nope")).toContain("Unknown category nope");
  });
});
