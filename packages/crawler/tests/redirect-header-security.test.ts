import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchPage } from "../src/fetcher";

describe("standard fetch redirect headers", () => {
  test("strips caller-provided headers when a redirect changes origin", async () => {
    let receivedAuthorization: string | null = null;
    let receivedCustomHeader: string | null = null;

    const target = Bun.serve({
      port: 0,
      fetch(req) {
        receivedAuthorization = req.headers.get("authorization");
        receivedCustomHeader = req.headers.get("x-crawl-secret");
        return new Response("<html>ok</html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const source = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}/final` },
        });
      },
    });

    try {
      const result = await Effect.runPromise(
        fetchPage(`http://127.0.0.1:${source.port}/redirect`, {
          userAgent: "squirrel-test",
          timeoutMs: 5_000,
          followRedirects: true,
          headers: {
            Authorization: "Bearer review-secret",
            "X-Crawl-Secret": "custom-secret", // pragma: allowlist secret
          },
        }),
      );

      expect(result.status).toBe(200);
      expect(receivedAuthorization).toBeNull();
      expect(receivedCustomHeader).toBeNull();
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });
});
