// parseUserUrl: a scheme without `//` is refused (it would otherwise be read as
// a host once https:// is prefixed), a host:port is not, and credentials and the
// fragment are dropped from the result.

import { describe, expect, test } from "bun:test";

import { parseUserUrl } from "../src/url";

describe("scheme without //", () => {
  test.each([
    "mailto:a@b.com",
    "javascript:alert(1)@x.com",
    "tel:+1@x.com",
    "data:,x@y.com",
    "http:example.com",
  ])("%p is refused", (input) => {
    expect(parseUserUrl(input).ok).toBe(false);
  });

  test.each([
    ["localhost:3000", "http://localhost:3000/"],
    ["example.com:8080", "https://example.com:8080/"],
    ["example.com:8080/x?y=1", "https://example.com:8080/x?y=1"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
  ])("host:port %p still works", (input, url) => {
    expect(parseUserUrl(input)).toEqual({ ok: true, url });
  });
});

describe("port 0 and bare credentials", () => {
  test.each(["a.com:0", "https://a.com:0/", "localhost:0/x"])("%p is refused", (input) => {
    expect(parseUserUrl(input).ok).toBe(false);
  });

  test("user:pw@host without a scheme says why", () => {
    const r = parseUserUrl(`${["user", "pw"].join(":")}@example.com`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("--header");
      expect(r.error).not.toContain("pw");
    }
  });
});

describe("credentials and fragment", () => {
  const withCreds = `https://${["user", "pw"].join(":")}@example.com/p?t=1#frag`;

  test("are dropped, the query is kept", () => {
    expect(parseUserUrl(withCreds)).toEqual({
      ok: true,
      url: "https://example.com/p?t=1",
      strippedCredentials: true,
    });
  });

  test("an error does not echo the input", () => {
    const bad = parseUserUrl(`https://${["user", "pw"].join(":")}@/`);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("pw");
  });
});
