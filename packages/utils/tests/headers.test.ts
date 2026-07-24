// Unit tests for shared HTTP header validation (#532) and record→Headers
// rehydration (#973/#1035).

import { describe, expect, test } from "bun:test";

import { isValidHeaderName, isValidHeaderValue, recordToHeaders } from "../src/headers";

describe("isValidHeaderName", () => {
  test("accepts RFC 7230 token names", () => {
    expect(isValidHeaderName("Authorization")).toBe(true);
    expect(isValidHeaderName("X-Foo")).toBe(true);
    expect(isValidHeaderName("Signature-Agent")).toBe(true);
  });

  test("rejects names with spaces or separators", () => {
    expect(isValidHeaderName("Bad Name")).toBe(false);
    expect(isValidHeaderName("X:Foo")).toBe(false);
    expect(isValidHeaderName("")).toBe(false);
  });
});

describe("isValidHeaderValue", () => {
  test("accepts normal values incl. quotes, commas, colons", () => {
    expect(isValidHeaderValue("Bearer token")).toBe(true);
    expect(isValidHeaderValue('"https://shopify.com"')).toBe(true);
    expect(isValidHeaderValue('sig=("a" "b"), x=1')).toBe(true);
    expect(isValidHeaderValue("")).toBe(true);
  });

  test("accepts HTAB and extended (obs-text) bytes", () => {
    expect(isValidHeaderValue("a\tb")).toBe(true);
    expect(isValidHeaderValue("café")).toBe(true); // é = \xe9
    expect(isValidHeaderValue("\x80\xff")).toBe(true);
  });

  test("rejects CR, LF, NUL and other control chars", () => {
    expect(isValidHeaderValue("a\r\nEvil: 1")).toBe(false);
    expect(isValidHeaderValue("a\rb")).toBe(false);
    expect(isValidHeaderValue("a\nb")).toBe(false);
    expect(isValidHeaderValue("a\x00b")).toBe(false);
    expect(isValidHeaderValue("a\x07b")).toBe(false);
  });
});

describe("recordToHeaders", () => {
  test('round-trips a "\\n"-joined multi-cookie record via getSetCookie()', () => {
    const record = {
      "content-type": "text/html",
      "set-cookie":
        "session=abc123; Path=/; HttpOnly\nconsent=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure",
    };
    const headers = recordToHeaders(record);
    expect(headers.getSetCookie()).toEqual([
      "session=abc123; Path=/; HttpOnly",
      "consent=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure",
    ]);
    expect(headers.get("content-type")).toBe("text/html");
  });

  test("round-trips three cookies", () => {
    const headers = recordToHeaders({
      "set-cookie": "a=1\nb=2\nc=3",
    });
    expect(headers.getSetCookie()).toEqual(["a=1", "b=2", "c=3"]);
  });

  test("does not throw where the naive new Headers(record)/headers.set() would", () => {
    const record = { "set-cookie": "a=1\nb=2" };
    expect(() => new Headers(record as Record<string, string>)).toThrow();
    expect(() => new Headers().set("set-cookie", record["set-cookie"])).toThrow();
    expect(() => recordToHeaders(record)).not.toThrow();
  });

  test("single cookie, no other headers", () => {
    const headers = recordToHeaders({ "set-cookie": "session=abc123; HttpOnly" });
    expect(headers.getSetCookie()).toEqual(["session=abc123; HttpOnly"]);
  });

  test("no set-cookie key: plain headers pass through untouched", () => {
    const headers = recordToHeaders({ server: "nginx", "x-custom": "value" });
    expect(headers.get("server")).toBe("nginx");
    expect(headers.get("x-custom")).toBe("value");
    expect(headers.getSetCookie()).toEqual([]);
  });
});
