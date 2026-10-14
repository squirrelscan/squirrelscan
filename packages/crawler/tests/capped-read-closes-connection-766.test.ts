// #766: a capped body read must close its connection once it returns.
//
// Cancelling a body does not close Bun's connection: it goes on downloading
// whatever the origin sends until the request's signal aborts. A capped read
// of an endless body therefore kept the socket open, and kept receiving, until
// the request deadline. Only a raw socket server can show this: Bun.serve
// hides when the client hangs up, and these servers see the close.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createFetchDocumentFetcher } from "@squirrelscan/fetchers";
import { fetchUndecoded, readBodyCapped } from "@squirrelscan/utils/response-body";

import { safeFetchWithDeadline, withRequestDeadline } from "../src/deadline";
import { fetchPage } from "../src/fetcher";

/** Far longer than any test waits: a close before it is the read's doing. */
const DEADLINE_MS = 10_000;

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

interface Endless {
  url: string;
  /** When the connection that carried the body closed; 0 while open. */
  closedAt: () => number;
}

/** Answers every request with `head` and a body that never ends. */
function endlessServer(head: string): Endless {
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  let closedAt = 0;
  const pump = (socket: { write(data: Uint8Array): number }) => {
    while (socket.write(chunk) === chunk.byteLength) {
      // Keep writing until the socket pushes back; `drain` resumes.
    }
  };
  const listener = Bun.listen<{ started: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { started: false };
      },
      data(socket) {
        if (socket.data.started) return;
        socket.data.started = true;
        socket.write(`${head}\r\nconnection: close\r\n\r\n`);
        pump(socket);
      },
      drain(socket) {
        pump(socket);
      },
      close(socket) {
        if (socket.data.started) closedAt = Date.now();
      },
    },
  });
  stops.push(() => listener.stop(true));
  return { url: `http://127.0.0.1:${listener.port}/`, closedAt: () => closedAt };
}

/** Milliseconds from `returnedAt` to the close, or -1 if none came in 3 s. */
async function closeDelay(server: Endless, returnedAt: number): Promise<number> {
  while (server.closedAt() === 0 && Date.now() - returnedAt < 3_000) await Bun.sleep(10);
  return server.closedAt() === 0 ? -1 : server.closedAt() - returnedAt;
}

const HTML_HEAD = "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8";

describe("a capped read closes its connection (#766)", () => {
  test("safeFetchWithDeadline: the shared probe helper", async () => {
    const server = endlessServer("HTTP/1.1 200 OK\r\ncontent-type: text/plain");
    const body = await safeFetchWithDeadline(server.url, {}, DEADLINE_MS, (response) =>
      readBodyCapped(response, 64 * 1024),
    );
    const delay = await closeDelay(server, Date.now());
    expect(body.length).toBe(64 * 1024);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("withRequestDeadline: a body cancelled unread", async () => {
    const server = endlessServer("HTTP/1.1 200 OK\r\ncontent-type: application/pdf");
    await withRequestDeadline(
      DEADLINE_MS,
      (signal) => fetchUndecoded(server.url, { signal }),
      async (response) => {
        await response.body?.cancel();
      },
    );
    const delay = await closeDelay(server, Date.now());
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("the crawler's document fetch", async () => {
    const server = endlessServer(HTML_HEAD);
    const page = await Effect.runPromise(
      fetchPage(server.url, {
        userAgent: "squirrel-test",
        timeoutMs: DEADLINE_MS,
        followRedirects: true,
      }),
    );
    const delay = await closeDelay(server, Date.now());
    expect(page.status).toBe(200);
    expect(page.body.length).toBeGreaterThan(0);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("the document fetch through the fetch document fetcher", async () => {
    const server = endlessServer(HTML_HEAD);
    const page = await Effect.runPromise(
      fetchPage(server.url, {
        userAgent: "squirrel-test",
        timeoutMs: DEADLINE_MS,
        followRedirects: true,
        fetcher: createFetchDocumentFetcher(),
      }),
    );
    const delay = await closeDelay(server, Date.now());
    expect(page.status).toBe(200);
    expect(page.body.length).toBeGreaterThan(0);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(1_000);
  });

  test("a body read to the end leaves its connection pooled", async () => {
    let connections = 0;
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          connections++;
        },
        data(socket) {
          socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\nhello");
        },
      },
    });
    stops.push(() => listener.stop(true));
    const url = `http://127.0.0.1:${listener.port}/`;
    for (let i = 0; i < 2; i++) {
      const body = await safeFetchWithDeadline(url, {}, DEADLINE_MS, (response) =>
        readBodyCapped(response, 64 * 1024),
      );
      expect(body).toBe("hello");
    }
    expect(connections).toBe(1);
  });
});
