// #766: the engine's capped reads must close their connections once they
// return. Cancelling a body does not close Bun's connection: it goes on
// downloading whatever the origin sends until the request's signal aborts, so
// a capped read of an endless body kept the socket open, and kept receiving,
// until the request deadline. Only a raw socket server can show this: Bun.serve
// hides when the client hangs up.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { parsePage } from "@squirrelscan/parser";

import { runCloakingProbe } from "../src/cloaking-probe";
import { checkExternalLinks } from "../src/external-checker";
import { fetchScriptContents } from "../src/script-fetcher";
import { confirmSoft404Candidates } from "../src/soft404-confirm";

/** Far longer than any test waits: a close before it is the read's doing. */
const DEADLINE_MS = 10_000;

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

interface Endless {
  url: string;
  /** Close time of every connection that carried a body; 0 while open. */
  closes: () => number[];
}

/**
 * Answers GET with `head` and a body that never ends. HEAD gets `head` with an
 * empty body and keeps its connection, which is not counted.
 */
function endlessServer(head: string): Endless {
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  const bodies: Array<{ closedAt: number }> = [];
  const pump = (socket: { write(data: Uint8Array): number }) => {
    while (socket.write(chunk) === chunk.byteLength) {
      // Keep writing until the socket pushes back; `drain` resumes.
    }
  };
  const listener = Bun.listen<{ body: { closedAt: number } | null }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { body: null };
      },
      data(socket, data) {
        if (socket.data.body) return;
        if (data.toString("latin1").startsWith("HEAD ")) {
          socket.write(`${head}\r\ncontent-length: 0\r\n\r\n`);
          return;
        }
        socket.data.body = { closedAt: 0 };
        bodies.push(socket.data.body);
        socket.write(`${head}\r\nconnection: close\r\n\r\n`);
        pump(socket);
      },
      drain(socket) {
        if (socket.data.body) pump(socket);
      },
      close(socket) {
        if (socket.data.body) socket.data.body.closedAt = Date.now();
      },
    },
  });
  stops.push(() => listener.stop(true));
  return {
    url: `http://127.0.0.1:${listener.port}/page`,
    closes: () => bodies.map((b) => b.closedAt),
  };
}

/**
 * Waits up to 3 s for every body connection to close, then returns the latest
 * close relative to `returnedAt`, or -1 if one is still open.
 */
async function lastCloseDelay(server: Endless, returnedAt: number): Promise<number> {
  const open = () => server.closes().some((at) => at === 0);
  while (open() && Date.now() - returnedAt < 3_000) await Bun.sleep(10);
  if (server.closes().length === 0 || open()) return -1;
  return Math.max(...server.closes()) - returnedAt;
}

describe("the engine's capped reads close their connections (#766)", () => {
  test("the external link checker's 403 interstitial read", async () => {
    const server = endlessServer("HTTP/1.1 403 Forbidden\r\ncontent-type: text/html");
    const [result] = await Effect.runPromise(
      checkExternalLinks([server.url], null, {
        timeoutMs: DEADLINE_MS,
        egress: { allowPrivateNetwork: true },
      }),
    );
    const delay = await lastCloseDelay(server, Date.now());
    expect(result?.status).toBe(403);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("the script fetcher, over its size cap", async () => {
    const server = endlessServer("HTTP/1.1 200 OK\r\ncontent-type: application/javascript");
    const [result] = await Effect.runPromise(
      fetchScriptContents([server.url], {
        timeoutMs: DEADLINE_MS,
        maxSizeBytes: 64 * 1024,
      }),
    );
    const delay = await lastCloseDelay(server, Date.now());
    expect(result?.error).toBe("script too large");
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("the soft-404 confirmation re-fetch", async () => {
    const server = endlessServer("HTTP/1.1 200 OK\r\ncontent-type: text/html");
    const shell = `<!doctype html><html id="__next_error__"><head><meta name="robots" content="noindex" /><title>Page Not Found</title></head><body><h1>Page Not Found</h1></body></html>`;
    const summary = await confirmSoft404Candidates(
      [{ url: server.url, statusCode: 200, parsed: parsePage(shell, server.url) }],
      { userAgent: "squirrel-test", timeoutMs: DEADLINE_MS },
    );
    const delay = await lastCloseDelay(server, Date.now());
    expect(summary.candidates).toBe(1);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("the cloaking probe", async () => {
    const server = endlessServer("HTTP/1.1 200 OK\r\ncontent-type: text/html");
    const [probe] = await runCloakingProbe([{ url: server.url, reason: "orphan" }], {
      maxPages: 1,
      recentDays: 30,
      queryVariation: false,
      googlebotUserAgent: "Googlebot-test",
      defaultUserAgent: "squirrel-test",
      timeoutMs: DEADLINE_MS,
    });
    const delay = await lastCloseDelay(server, Date.now());
    expect(probe?.defaultStatus).toBe(200);
    expect(server.closes()).toHaveLength(2);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });
});
