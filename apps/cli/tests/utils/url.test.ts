// Tests for URL utilities

import { describe, expect, test } from "bun:test";

import {
  getProjectNameContext,
  isLocalhost,
  parseUserUrl,
} from "../../src/utils/url";

describe("parseUserUrl", () => {
  test("normalizes bare domain to https", () => {
    const result = parseUserUrl("example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("https://example.com/");
    }
  });

  test("normalizes localhost to http", () => {
    const result = parseUserUrl("localhost:3000");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("http://localhost:3000/");
    }
  });

  test("preserves explicit http:// on public domains", () => {
    const result = parseUserUrl("http://example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("http://example.com/");
    }
  });

  test("normalizes private IPv4 to http", () => {
    const resultA = parseUserUrl("192.168.1.1");
    expect(resultA.ok).toBe(true);
    if (resultA.ok) {
      expect(resultA.url).toBe("http://192.168.1.1/");
    }

    const resultB = parseUserUrl("10.0.0.1:8080");
    expect(resultB.ok).toBe(true);
    if (resultB.ok) {
      expect(resultB.url).toBe("http://10.0.0.1:8080/");
    }
  });

  test("handles IPv6 localhost", () => {
    const result = parseUserUrl("[::1]:3000");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("http://[::1]:3000/");
    }
  });

  test("normalizes private IPv6 to http", () => {
    const result = parseUserUrl("[fc00::1]");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe("http://[fc00::1]/");
    }
  });
});

describe("isLocalhost", () => {
  test("detects localhost variants", () => {
    expect(isLocalhost("localhost")).toBe(true);
    expect(isLocalhost("foo.localhost")).toBe(true);
    expect(isLocalhost("127.0.0.1")).toBe(true);
    expect(isLocalhost("::1")).toBe(true);
    expect(isLocalhost("[::1]")).toBe(true);
  });

  test("detects private IPv4 ranges", () => {
    expect(isLocalhost("10.0.0.1")).toBe(true);
    expect(isLocalhost("172.16.0.1")).toBe(true);
    expect(isLocalhost("192.168.1.1")).toBe(true);
  });

  test("detects private IPv6 ranges", () => {
    expect(isLocalhost("fc00::1")).toBe(true);
    expect(isLocalhost("FD00::1")).toBe(true);
    expect(isLocalhost("fe80::1")).toBe(true);
  });

  test("rejects public domains", () => {
    expect(isLocalhost("example.com")).toBe(false);
    expect(isLocalhost("8.8.8.8")).toBe(false);
    expect(isLocalhost("2001:db8::1")).toBe(false);
  });
});

describe("parseUserUrl domain validation", () => {
  test("rejects CLI reserved names", () => {
    const reservedNames = [
      "list",
      "help",
      "config",
      "audit",
      "crawl",
      "report",
    ];
    for (const name of reservedNames) {
      const result = parseUserUrl(name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("doesn't look like a valid domain");
      }
    }
  });

  test("rejects domains without TLD", () => {
    const result = parseUserUrl("foo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing TLD");
    }
  });

  test("accepts valid domains", () => {
    expect(parseUserUrl("example.com").ok).toBe(true);
    expect(parseUserUrl("sub.example.com").ok).toBe(true);
    expect(parseUserUrl("example.co.uk").ok).toBe(true);
  });

  test("accepts localhost variants", () => {
    expect(parseUserUrl("localhost").ok).toBe(true);
    expect(parseUserUrl("localhost:3000").ok).toBe(true);
    expect(parseUserUrl("foo.localhost").ok).toBe(true);
  });

  test("accepts IP addresses", () => {
    expect(parseUserUrl("192.168.1.1").ok).toBe(true);
    expect(parseUserUrl("10.0.0.1:8080").ok).toBe(true);
    expect(parseUserUrl("[::1]:3000").ok).toBe(true);
    expect(parseUserUrl("[fc00::1]").ok).toBe(true);
  });
});

describe("getProjectNameContext", () => {
  test("detects local URLs needing custom name", () => {
    const ctx = getProjectNameContext("http://localhost:3000/");
    expect(ctx.isLocal).toBe(true);
    expect(ctx.needsCustomName).toBe(true);
    expect(ctx.suggestedName).toBe("localhost-3000");
  });

  test("skips prompt when config name provided", () => {
    const ctx = getProjectNameContext("http://localhost:3000/", "my-project");
    expect(ctx.isLocal).toBe(true);
    expect(ctx.needsCustomName).toBe(false);
  });

  test("does not need custom name for public domains", () => {
    const ctx = getProjectNameContext("https://example.com/");
    expect(ctx.isLocal).toBe(false);
    expect(ctx.needsCustomName).toBe(false);
    expect(ctx.suggestedName).toBe("example-com");
  });

  test("generates correct suggested name for subdomains", () => {
    const ctx = getProjectNameContext("https://sub.example.com/");
    expect(ctx.suggestedName).toBe("sub-example-com");
  });
});
