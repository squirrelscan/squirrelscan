// Unit tests for the shared host/scheme validation used by parseUserUrl (CLI)
// and normalizeWebsiteInput (api) — collapsed into one source (#892).

import { describe, expect, test } from "bun:test";

import { hasNonHttpScheme, isLoopbackHost, isValidDomain, setReservedNames } from "../src/url";

describe("isLoopbackHost", () => {
  test("matches loopback hosts", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "app.localhost",
      "127.0.0.1",
      "127.5.6.7",
      "::1",
      "[::1]",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("rejects non-loopback (public + private LAN) hosts", () => {
    for (const host of [
      "example.com",
      "192.168.1.10", // private LAN, not loopback
      "10.0.0.5",
      "172.16.0.1",
      "8.8.8.8",
      "notlocalhost.com",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("hasNonHttpScheme", () => {
  test("rejects explicit non-http(s) schemes", () => {
    expect(hasNonHttpScheme("ftp://example.com")).toBe(true);
    expect(hasNonHttpScheme("javascript:alert(1)")).toBe(false); // no "://"
  });

  test("accepts http(s), case-insensitively", () => {
    expect(hasNonHttpScheme("http://example.com")).toBe(false);
    expect(hasNonHttpScheme("HTTPS://example.com")).toBe(false);
  });

  test("accepts schemeless input", () => {
    expect(hasNonHttpScheme("example.com")).toBe(false);
  });
});

describe("isValidDomain", () => {
  test("accepts dotted hosts", () => {
    expect(isValidDomain("example.com").valid).toBe(true);
    expect(isValidDomain("sub.example.com").valid).toBe(true);
  });

  test("accepts localhost and subdomains", () => {
    expect(isValidDomain("localhost").valid).toBe(true);
    expect(isValidDomain("foo.localhost").valid).toBe(true);
  });

  test("accepts IP addresses, bracketed IPv6 included", () => {
    expect(isValidDomain("192.168.1.1").valid).toBe(true);
    expect(isValidDomain("::1").valid).toBe(true);
    expect(isValidDomain("[::1]").valid).toBe(true);
  });

  test("rejects dotless junk words", () => {
    expect(isValidDomain("asdfghjkl").valid).toBe(false);
  });

  test("rejects invalid TLDs", () => {
    expect(isValidDomain("example.1").valid).toBe(false);
  });

  test("rejects reserved names when set", () => {
    setReservedNames(["audit", "init"]);
    expect(isValidDomain("audit").valid).toBe(false);
    setReservedNames([]);
  });
});
