// squirrelscan/repo#3332: a cross-origin redirect hop keeps only generic browser
// headers. A User-Agent set through the custom headers is one of them, on
// purpose: it names the client, it is not a credential.

import { describe, expect, test } from "bun:test";

import { headersForRedirect } from "../src/headers";

describe("headersForRedirect and the User-Agent", () => {
  test("a custom User-Agent survives a cross-origin hop; the credentials beside it do not", () => {
    const next = headersForRedirect(
      {
        "User-Agent": "acme-monitor/2.0",
        Authorization: "Bearer secret",
        "X-Api-Key": "secret",
        Cookie: "session=secret",
      },
      "https://site.test/a",
      "https://other.test/b",
    );
    expect(next.get("user-agent")).toBe("acme-monitor/2.0");
    expect(next.has("authorization")).toBe(false);
    expect(next.has("x-api-key")).toBe(false);
    expect(next.has("cookie")).toBe(false);
  });

  test("a same-origin hop keeps everything", () => {
    const next = headersForRedirect(
      { "User-Agent": "acme-monitor/2.0", Authorization: "Bearer secret" },
      "https://site.test/a",
      "https://site.test/b",
    );
    expect(next.get("authorization")).toBe("Bearer secret");
  });
});
