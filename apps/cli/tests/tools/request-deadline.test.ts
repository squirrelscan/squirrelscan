// The request helpers keep their deadline armed through the body read (#192).
// Every origin below answers 200 promptly and then stalls its body.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Effect } from "effect";

import { fetchRobotsTxt } from "../../src/crawl/robots";
import {
  initRequestTool,
  request,
  requestJson,
  requestOnce,
  requestOnceScoped,
  requestText,
  RequestError,
} from "../../src/tools/request";
import { checkReachability } from "../../src/utils/reachability";

const TIMEOUT_MS = 300;
// Generous upper bound: a hang would run to the test timeout, not to this.
const MAX_ELAPSED_MS = 3000;

let server: ReturnType<typeof Bun.serve>;
let base: string;

function stalledBody(status = 200, headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("partial"));
      // never closes
    },
  });
  return new Response(body, { status, headers });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "0.0.0.0",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/ok") {
        return new Response('{"a":1}', {
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/empty") return new Response(null, { status: 204 });
      if (path === "/robots.txt") {
        return stalledBody(200, { "content-type": "text/plain" });
      }
      return stalledBody(200, { "content-type": "text/html" });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  initRequestTool({ timeout: TIMEOUT_MS, retryAttempts: 0, retryDelayMs: 1 });
});

async function expectTimeout(effect: Effect.Effect<unknown, RequestError>) {
  const started = Date.now();
  const result = await Effect.runPromise(Effect.either(effect));
  expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left.message).toBe("Request timed out");
  }
}

describe("request helpers: deadline covers the body", () => {
  test("request() fails at the timeout when the body stalls", async () => {
    await expectTimeout(request(`${base}/stall`));
  });

  test("requestOnce() fails at the timeout when the body stalls", async () => {
    await expectTimeout(requestOnce(`${base}/stall`));
  });

  test("requestText() and requestJson() fail at the timeout when the body stalls", async () => {
    await expectTimeout(requestText(`${base}/stall`));
    await expectTimeout(requestJson(`${base}/stall`));
  });

  test("requestOnceScoped() aborts a body read that outlives the deadline", async () => {
    await expectTimeout(
      requestOnceScoped(`${base}/stall`, undefined, (res) => res.text())
    );
  });

  test("request() retries a stalled body like any other network failure", async () => {
    initRequestTool({ timeout: 150, retryAttempts: 2, retryDelayMs: 1 });
    const started = Date.now();
    const result = await Effect.runPromise(
      Effect.either(request(`${base}/stall`))
    );
    expect(result._tag).toBe("Left");
    // Three attempts at 150ms each
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });
});

describe("request helpers: regression for healthy responses", () => {
  test("returns a readable Response with status, headers and url", async () => {
    const response = await Effect.runPromise(request(`${base}/ok`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.url).toBe(`${base}/ok`);
    expect(await response.json()).toEqual({ a: 1 });
  });

  test("handles null-body statuses", async () => {
    const response = await Effect.runPromise(requestOnce(`${base}/empty`));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("requestJson() parses a healthy body", async () => {
    expect(
      await Effect.runPromise(requestJson<{ a: number }>(`${base}/ok`))
    ).toEqual({
      a: 1,
    });
  });
});

describe("callers covered through the shared helper", () => {
  test("fetchRobotsTxt gives up on a stalled body and reports no robots.txt", async () => {
    const started = Date.now();
    const robots = await Effect.runPromise(fetchRobotsTxt(base, "test-agent"));
    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
    expect(robots.exists).toBe(false);
    expect(robots.errors[0]).toContain("timed out");
  });

  test("checkReachability returns instead of hanging on a stalled body", async () => {
    // 127.0.0.2 is loopback but not on the localhost fast path, so this goes
    // through the request tool.
    const url = `http://127.0.0.2:${server.port}/stall`;
    const started = Date.now();
    const result = await checkReachability(url);
    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBe(200);
  });
});
