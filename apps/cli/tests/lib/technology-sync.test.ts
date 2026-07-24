import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { syncTechnologies } from "@/lib/technology-sync";

// technology-sync resolves a credential from SQUIRREL_API_TOKEN (env path of
// resolveCredential) and calls global fetch via cliApi.send. We swap both per
// test and restore after. The contract under test: syncTechnologies POSTs the
// per-website endpoint but is best-effort — it NEVER throws, even on a
// non-2xx or a network error.
const originalFetch = globalThis.fetch;
const originalToken = process.env.SQUIRREL_API_TOKEN;

const tech = (id: string, name: string) => ({
  id,
  name,
  category: "cms" as const,
  version: null,
  confidence: "high" as const,
  detectedBy: "html:generator",
});

beforeEach(() => {
  process.env.SQUIRREL_API_TOKEN = "sqcli_test_token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.SQUIRREL_API_TOKEN;
  } else {
    process.env.SQUIRREL_API_TOKEN = originalToken;
  }
});

describe("syncTechnologies", () => {
  test("POSTs the per-website endpoint with auditId and technologies (no domain)", async () => {
    let captured: {
      url: string;
      method?: string;
      body: Record<string, unknown>;
    } | null = null;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      captured = {
        url: input.toString(),
        method: init?.method,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await syncTechnologies({
      websiteId: "web 1",
      auditId: "aud_1",
      technologies: [tech("wordpress", "WordPress")],
    });

    expect(captured!.method).toBe("POST");
    // websiteId is URL-encoded into the path.
    expect(captured!.url).toContain("/v1/technologies/web%201");
    expect(captured!.body.auditId).toBe("aud_1");
    expect(captured!.body.technologies).toEqual([
      tech("wordpress", "WordPress"),
    ]);
  });

  test("sends no domain — the server derives it from the owned website", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await syncTechnologies({
      websiteId: "web_1",
      auditId: "aud_1",
      technologies: [],
    });

    expect("domain" in body).toBe(false);
    expect(body.technologies).toEqual([]);
  });

  test("never throws on a non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(
      syncTechnologies({
        websiteId: "web_1",
        auditId: "aud_1",
        technologies: [tech("react", "React")],
      })
    ).resolves.toBeUndefined();
  });

  test("never throws on a network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      syncTechnologies({
        websiteId: "web_1",
        auditId: "aud_1",
        technologies: [tech("react", "React")],
      })
    ).resolves.toBeUndefined();
  });
});
