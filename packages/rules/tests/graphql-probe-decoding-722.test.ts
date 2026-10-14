// #722: the GraphQL probes fetched with the runtime's own Content-Encoding
// decoding, and Bun inflates a compressed body in full as soon as it arrives,
// before the probe's capped read. A site with active probing on could answer a
// probe with a gzip or brotli bomb and cost the audit gigabytes of memory. The
// probe now fetches with decoding off (`fetchUndecoded`) and decodes the body
// no further than its byte cap, like every other request the audit sends.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { constants, createBrotliCompress, createGzip, gzipSync } from "node:zlib";

import { createProbeBudget } from "../src/probe-budget";
import { graphqlIntrospectionRule } from "../src/security/graphql-introspection";
import {
  GRAPHQL_RESPONSE_CAPS,
  parseGraphqlBody,
  sendGraphqlProbe,
} from "../src/security/graphql-probe";
import type { RuleContext } from "../src/types";

const GIB = 1024 * 1024 * 1024;

const SCHEMA = JSON.stringify({
  data: {
    __schema: {
      types: [
        { name: "Query" },
        { name: "Mutation" },
        { name: "User" },
        { name: "String" },
        { name: "__Schema" },
      ],
    },
  },
});

/** `total` bytes of spaces through a streaming compressor, never held whole. */
async function bomb(compressor: NodeJS.ReadWriteStream, total: number): Promise<Buffer> {
  const out: Buffer[] = [];
  compressor.on("data", (chunk: Buffer) => out.push(chunk));
  const ended = new Promise((resolve) => compressor.on("end", resolve));
  const chunk = Buffer.alloc(16 * 1024 * 1024, 0x20);
  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    if (!compressor.write(chunk)) await new Promise((resolve) => compressor.once("drain", resolve));
  }
  compressor.end();
  await ended;
  return Buffer.concat(out);
}

let gzipBomb: Buffer;
let brBomb: Buffer;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
/** How `/graphql` answers, per test. */
let mode: "gzip-bomb" | "br-bomb" | "gzip-schema" | "schema" = "schema";

const encoded = (body: Uint8Array | string, coding?: string): Response =>
  new Response(body, {
    headers: {
      "content-type": "application/json",
      ...(coding ? { "content-encoding": coding } : {}),
    },
  });

beforeAll(async () => {
  gzipBomb = await bomb(createGzip({ level: 6 }), GIB);
  brBomb = await bomb(
    createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }),
    GIB,
  );
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/graphql") return new Response("not found", { status: 404 });
      switch (mode) {
        case "gzip-bomb":
          return encoded(gzipBomb, "gzip");
        case "br-bomb":
          return encoded(brBomb, "br");
        case "gzip-schema":
          return encoded(gzipSync(SCHEMA), "gzip");
        default:
          return encoded(SCHEMA);
      }
    },
  });
  origin = `http://localhost:${server.port}`;
}, 60_000);

afterAll(() => server.stop(true));

/** Peak RSS growth while `run` runs. */
async function peakRssGrowth(run: () => Promise<unknown>): Promise<number> {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 1);
  try {
    await run();
  } finally {
    clearInterval(sampler);
  }
  return Math.max(peak, process.memoryUsage().rss) - before;
}

const budget = () => createProbeBudget({ level: "active", budgetMs: 60_000 });

describe("GraphQL probe responses are decoded no further than the cap (#722)", () => {
  for (const [label, which] of [
    ["gzip", "gzip-bomb"],
    ["brotli", "br-bomb"],
  ] as const) {
    test(`a ${label} body that inflates to 1 GiB is read to its cap and stays under 256 MiB`, async () => {
      mode = which;
      let outcome: Awaited<ReturnType<typeof sendGraphqlProbe>> | undefined;
      const growth = await peakRssGrowth(async () => {
        outcome = await sendGraphqlProbe(budget(), `${origin}/graphql`, {
          op: "introspection",
          method: "GET",
        });
      });
      expect(outcome && "response" in outcome).toBe(true);
      const response = (outcome as { response: { body: string; truncated: boolean } }).response;
      expect(response.truncated).toBe(true);
      expect(response.body.length).toBe(GRAPHQL_RESPONSE_CAPS.introspection);
      expect(response.body.trim()).toBe("");
      // Inflated in full by the runtime this is over 1 GiB; read lazily it is
      // the cap plus the runtime's own buffers.
      expect(growth).toBeLessThan(256 * 1024 * 1024);
    }, 30_000);
  }
});

describe("the probe request turns the runtime's decoding off (#722)", () => {
  test("decompress: false and the shared Accept-Encoding, on the request that leaves", async () => {
    mode = "schema";
    const real = globalThis.fetch;
    const inits: RequestInit[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (init) inits.push(init);
      return real(input, init);
    }) as typeof fetch;
    try {
      await sendGraphqlProbe(budget(), `${origin}/graphql`, { op: "introspection", method: "GET" });
    } finally {
      globalThis.fetch = real;
    }
    expect(inits).toHaveLength(1);
    expect((inits[0] as { decompress?: boolean }).decompress).toBe(false);
    expect(new Headers(inits[0]!.headers).get("accept-encoding")).toBe("gzip, deflate, br, zstd");
    // What the probe always sent is still sent.
    expect(inits[0]!.credentials).toBe("omit");
    expect(inits[0]!.redirect).toBe("manual");
  });

  test("a gzip-encoded GraphQL answer parses as the plain one does", async () => {
    const send = async () => {
      const outcome = await sendGraphqlProbe(budget(), `${origin}/graphql`, {
        op: "introspection",
        method: "GET",
      });
      return "response" in outcome ? outcome.response : null;
    };
    mode = "schema";
    const plain = await send();
    mode = "gzip-schema";
    const gzipped = await send();
    expect(gzipped?.body).toBe(SCHEMA);
    expect(gzipped?.truncated).toBe(false);
    expect(parseGraphqlBody(gzipped!)).toEqual(parseGraphqlBody(plain!));
  });

  test("security/graphql-introspection reaches the same finding over gzip", async () => {
    const ctx = (): RuleContext => ({
      page: { url: `${origin}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as RuleContext["parsed"],
      site: { baseUrl: `${origin}/`, pages: [], robotsTxt: null, sitemaps: null },
      probe: budget(),
      options: {},
    });
    mode = "schema";
    const plain = await graphqlIntrospectionRule.run(ctx());
    mode = "gzip-schema";
    const gzipped = await graphqlIntrospectionRule.run(ctx());
    expect(plain.checks.some((c) => c.status === "warn")).toBe(true);
    expect(gzipped.checks).toEqual(plain.checks);
  });
});

describe("a capped probe closes its connection (#722)", () => {
  test("an endless answer stops crossing the wire once the cap is read, not at the timeout", async () => {
    // A raw socket server: Bun.serve hides when the client hangs up, and only
    // a server that counts what it wrote and sees the close can tell a
    // cancelled reader (Bun keeps downloading) from a closed connection.
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
          socket.write(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n",
          );
          pump(socket);
        },
        drain(socket) {
          pump(socket);
        },
        close() {
          closedAt = Date.now();
        },
      },
    });
    try {
      const outcome = await sendGraphqlProbe(
        budget(),
        `http://127.0.0.1:${listener.port}/graphql`,
        {
          op: "noop-mutation",
          method: "GET",
        },
      );
      const returnedAt = Date.now();
      expect("response" in outcome && outcome.response.truncated).toBe(true);
      while (closedAt === 0 && Date.now() - returnedAt < 5_000) await Bun.sleep(10);
      expect(closedAt).toBeGreaterThan(0);
      // The probe timeout is 10 s; a reader cancel alone kept the transfer
      // going until then.
      expect(closedAt - returnedAt).toBeLessThan(2_000);
    } finally {
      listener.stop(true);
    }
  }, 20_000);
});
