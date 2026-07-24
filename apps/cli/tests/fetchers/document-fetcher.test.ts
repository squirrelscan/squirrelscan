import { createFetchDocumentFetcher } from "@squirrelscan/fetchers";
import { describe, expect, test } from "bun:test";

describe("createFetchDocumentFetcher", () => {
  test("fetches content with timing and redirect chain", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/redirect") {
          return new Response(null, {
            status: 302,
            headers: {
              location: "/final",
            },
          });
        }

        return new Response("ok", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        });
      },
    });

    try {
      const fetcher = createFetchDocumentFetcher();
      const result = await fetcher.fetch({
        url: `http://127.0.0.1:${server.port}/redirect`,
        followRedirects: true,
      });

      expect(result.status).toBe(200);
      expect(result.body).toBe("ok");
      expect(result.finalUrl).toContain("/final");
      expect(result.redirectChain.chainLength).toBe(1);
      expect(result.timing.finishedAt).toBeGreaterThanOrEqual(
        result.timing.responseAt
      );
      expect(result.timing.responseAt).toBeGreaterThanOrEqual(
        result.timing.startedAt
      );
    } finally {
      server.stop(true);
    }
  });
});
