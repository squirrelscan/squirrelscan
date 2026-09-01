// content-encoding capture in the CLI's script fetcher (#9).
//
// apps/cli/src/crawler/script-fetcher.ts is a FORK of the audit-engine fetcher,
// not a re-export, so the engine's capture test proves nothing about it. It also
// has a content-store cache the engine fork lacks — a cache hit never touches
// the network, so it must report the encoding as unknown rather than as absent.

import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchScriptContents } from "@/crawler/script-fetcher";

const BODY = `console.log(${JSON.stringify("x".repeat(2000))});`;
const GZIPPED = Bun.gzipSync(new TextEncoder().encode(BODY));

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/gzip.js") {
      return new Response(GZIPPED, {
        headers: {
          "content-type": "application/javascript",
          "content-encoding": "gzip",
          "content-length": String(GZIPPED.length),
        },
      });
    }
    return new Response(BODY, {
      headers: {
        "content-type": "application/javascript",
        "content-length": String(BODY.length),
      },
    });
  },
});

const base = `http://localhost:${server.port}`;

afterAll(() => {
  server.stop(true);
});

describe("CLI script fetcher content-encoding (#9)", () => {
  test("an uncompressed script records null — observed, and absent", async () => {
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/plain.js`])
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe(null);
  });

  test("a gzipped script records the coding, not null", async () => {
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/gzip.js`])
    );
    expect(result?.status).toBe(200);
    expect(result?.contentEncoding).toBe("gzip");
    // fetch decodes the body; the header survives and sizeBytes is the decoded
    // length. That mismatch is why the rule never judges size on a compressed
    // asset — it only ever reports assets with no coding at all.
    expect(result?.sizeBytes).toBe(BODY.length);
  });

  // The fetcher's content-store cache-hit branch deliberately leaves
  // contentEncoding unset, since it never sees a response. That branch is
  // currently unreachable and so cannot be tested: fetchSingleScript reads with
  // `hashContent(url)` but writes with `store.put(content)`, which keys by
  // `hashContent(content)` — the two hashes never match, so the cache never
  // hits. Reported separately rather than changed here; fixing the key is a
  // caching behaviour change, not part of #9.
});
