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

  test("does not replay custom headers across origins", async () => {
    const received: Record<string, string | null> = {
      authorization: null,
      customHeader: null,
      userAgent: null,
    };

    const target = Bun.serve({
      port: 0,
      fetch(req) {
        received.authorization = req.headers.get("authorization");
        received.customHeader = req.headers.get("x-crawl-secret");
        received.userAgent = req.headers.get("user-agent");
        return new Response("ok");
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
      const result = await createFetchDocumentFetcher().fetch({
        url: `http://127.0.0.1:${source.port}/redirect`,
        headers: {
          Authorization: "Bearer review-secret",
          "X-Crawl-Secret": "custom-secret", // pragma: allowlist secret
          "User-Agent": "squirrel-test",
        },
      });

      expect(result.status).toBe(200);
      expect(received.authorization).toBeNull();
      expect(received.customHeader).toBeNull();
      expect(received.userAgent).toBe("squirrel-test");
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });

  test("retains custom headers on same-origin redirects", async () => {
    const received: { authorization: string | null } = { authorization: null };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/redirect") {
          return new Response(null, {
            status: 302,
            headers: { location: "/final" },
          });
        }
        received.authorization = req.headers.get("authorization");
        return new Response("ok");
      },
    });

    try {
      await createFetchDocumentFetcher().fetch({
        url: `http://127.0.0.1:${server.port}/redirect`,
        headers: { Authorization: "Bearer same-origin" },
      });
      expect(received.authorization).toBe("Bearer same-origin");
    } finally {
      server.stop(true);
    }
  });
});
