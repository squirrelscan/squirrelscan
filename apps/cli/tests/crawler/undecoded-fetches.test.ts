// squirrelscan/repo#2717: the CLI's reachability probe fetches a
// site-controlled URL, and Bun's fetch inflates a Content-Encoding body in full
// before any reader can stop it. It turns that decoding off and reads the body
// decoded, no further than its cap. (Scripts and external links are fetched by
// the engine; its undecoded-probe-fetches test covers them.)

import { readBodyCapped } from "@squirrelscan/utils/response-body";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Effect } from "effect";
import { gzipSync } from "node:zlib";

import { requestOnceScoped } from "@/tools/request";

const SCRIPT = `window.squirrel = ${JSON.stringify("nuts ".repeat(100))};`;

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/app.js") {
        return new Response(gzipSync(SCRIPT), {
          headers: {
            "content-type": "application/javascript",
            "content-encoding": "gzip",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const real = globalThis.fetch;
const sent: Array<{ path: string; decompress: unknown }> = [];
beforeAll(() => {
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        path: new URL(String(input)).pathname,
        decompress: (init as { decompress?: unknown } | undefined)?.decompress,
      });
      return real(input, init);
    },
    { preconnect: real.preconnect }
  );
});
afterAll(() => {
  globalThis.fetch = real;
});
afterEach(() => {
  sent.length = 0;
});

describe("CLI fetches of site-controlled URLs (#2717)", () => {
  test("the reachability probe's request is undecoded", async () => {
    const text = await Effect.runPromise(
      requestOnceScoped(`${base}/app.js`, { method: "GET" }, (res) =>
        readBodyCapped(res, 10_240)
      )
    );
    expect(text).toBe(SCRIPT);
    expect(sent).toEqual([{ path: "/app.js", decompress: false }]);
  });
});
