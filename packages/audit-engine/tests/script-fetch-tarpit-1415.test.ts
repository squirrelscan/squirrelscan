// repo#1415: the one script fetcher honours the shared tarpit budget (#1252), so
// a CLI audit run with a duration budget skips further scripts from a slow host.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createFetchBudget } from "../src/fetch-budget";
import { fetchScriptContents } from "../src/script-fetcher";

let server: ReturnType<typeof Bun.serve>;
let base: string;
const hits: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      hits.push(new URL(request.url).pathname);
      await Bun.sleep(40);
      return new Response("var a=1;", {
        headers: { "content-type": "application/javascript" },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server?.stop(true));

describe("script fetcher tarpit budget (repo#1415)", () => {
  test("stops requesting a tarpitting host once its strikes are spent", async () => {
    const budget = createFetchBudget({ tarpitLatencyMs: 10, tarpitStrikes: 2 });
    const urls = Array.from({ length: 10 }, (_, i) => `${base}/t${i}.js`);
    const results = await Effect.runPromise(
      fetchScriptContents(urls, {
        concurrency: 1,
        fetchAll: true,
        maxScripts: 10,
        budget,
      })
    );
    expect(results).toHaveLength(10);
    expect(hits.length).toBeLessThan(10);
    expect(budget.summary().tarpitHosts).toHaveLength(1);
    expect(budget.summary().skipped).toBeGreaterThan(0);
  });

  test("an oversized script body is rejected by the capped read", async () => {
    const big = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("a".repeat(5000), {
          headers: { "content-type": "application/javascript" },
        }),
    });
    try {
      const results = await Effect.runPromise(
        fetchScriptContents([`http://127.0.0.1:${big.port}/big.js`], {
          concurrency: 1,
          maxSizeBytes: 100,
        })
      );
      expect(results[0]?.error).toBeTruthy();
    } finally {
      big.stop(true);
    }
  });
});
