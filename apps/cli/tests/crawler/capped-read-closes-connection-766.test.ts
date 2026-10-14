// #766: the CLI's forked script fetcher and external checker must close their
// connections once a capped read returns, and the localhost reachability check
// once it has its status. Cancelling a body does not close
// Bun's connection: it goes on downloading whatever the origin sends until the
// request's signal aborts, and each cleared its timeout without aborting.
// Only a raw socket server can show this: Bun.serve hides when the client
// hangs up.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkExternalLinks } from "@/crawler/external-checker";
import { fetchScriptContents } from "@/crawler/script-fetcher";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { LinkCacheStorage } from "@/crawler/storage/link-cache";
import { checkReachability } from "@/utils/reachability";

/** Far longer than any test waits: a close before it is the read's doing. */
const DEADLINE_MS = 10_000;

// Throwaway stores so neither fetcher touches the user's real caches.
const cacheDir = mkdtempSync(join(tmpdir(), "squirrel-766-"));
const priorContentStorePath = process.env.SQUIRREL_CONTENT_STORE_PATH;
process.env.SQUIRREL_CONTENT_STORE_PATH = join(cacheDir, "content.db");
const linkCache = new LinkCacheStorage(join(cacheDir, "links.db"));

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

afterAll(() => {
  linkCache.close();
  closeGlobalContentStore();
  if (priorContentStorePath === undefined) {
    delete process.env.SQUIRREL_CONTENT_STORE_PATH;
  } else {
    process.env.SQUIRREL_CONTENT_STORE_PATH = priorContentStorePath;
  }
  rmSync(cacheDir, { recursive: true, force: true });
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
function endlessServer(head: string, path: string): Endless {
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
    url: `http://127.0.0.1:${listener.port}${path}`,
    closes: () => bodies.map((b) => b.closedAt),
  };
}

/**
 * Waits up to 3 s for every body connection to close, then returns the latest
 * close relative to `returnedAt`, or -1 if one is still open.
 */
async function lastCloseDelay(
  server: Endless,
  returnedAt: number
): Promise<number> {
  const open = () => server.closes().some((at) => at === 0);
  while (open() && Date.now() - returnedAt < 3_000) await Bun.sleep(10);
  if (server.closes().length === 0 || open()) return -1;
  return Math.max(...server.closes()) - returnedAt;
}

describe("the CLI's requests close their connections (#766)", () => {
  test("the script fetcher, over its size cap", async () => {
    const server = endlessServer(
      "HTTP/1.1 200 OK\r\ncontent-type: application/javascript",
      "/endless.js"
    );
    const [result] = await Effect.runPromise(
      fetchScriptContents([server.url], {
        timeoutMs: DEADLINE_MS,
        maxSizeBytes: 64 * 1024,
      })
    );
    const delay = await lastCloseDelay(server, Date.now());
    expect(result?.error).toBe("script too large");
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("the external checker's 403 interstitial read", async () => {
    const server = endlessServer(
      "HTTP/1.1 403 Forbidden\r\ncontent-type: text/html",
      "/page"
    );
    const [result] = await Effect.runPromise(
      checkExternalLinks([server.url], linkCache, { timeoutMs: DEADLINE_MS })
    );
    const delay = await lastCloseDelay(server, Date.now());
    expect(result?.status).toBe(403);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("the localhost reachability check", async () => {
    const server = endlessServer(
      "HTTP/1.1 200 OK\r\ncontent-type: text/html",
      "/"
    );
    const result = await checkReachability(server.url);
    const delay = await lastCloseDelay(server, Date.now());
    expect(result.reachable).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });
});
