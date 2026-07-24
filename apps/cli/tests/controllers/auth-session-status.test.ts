import { describe, expect, test } from "bun:test";

import { fetchSessionStatus } from "../../src/controllers/auth/login";

describe("fetchSessionStatus", () => {
  test("sends the PKCE verifier in a POST body rather than the URL", async () => {
    let requestUrl = "";
    let requestMethod = "";
    let requestBody: unknown;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        requestUrl = req.url;
        requestMethod = req.method;
        requestBody = await req.json();
        return Response.json({ status: "pending" });
      },
    });

    try {
      const response = await fetchSessionStatus(
        `http://127.0.0.1:${server.port}`,
        "session-id",
        "verifier-secret"
      );
      expect(response.ok).toBe(true);
      expect(requestMethod).toBe("POST");
      expect(new URL(requestUrl).search).toBe("");
      expect(requestBody).toEqual({ codeVerifier: "verifier-secret" });
    } finally {
      server.stop(true);
    }
  });
});
