import { describe, expect, test } from "bun:test";

import {
  isEquivalentAuditTarget,
  parseAuditTarget,
} from "../../src/utils/audit-target";

describe("parseAuditTarget", () => {
  test("parses valid URL", () => {
    const parsed = parseAuditTarget("https://example.com/path?q=1");
    expect(parsed).not.toBeNull();
    expect(parsed?.origin).toBe("https://example.com");
  });

  test("returns null for invalid URL", () => {
    expect(parseAuditTarget("not a url")).toBeNull();
  });
});

describe("isEquivalentAuditTarget", () => {
  test("treats apex and www as equivalent", () => {
    const apex = new URL("https://gymshark.com");
    const www = new URL("https://www.gymshark.com");
    expect(isEquivalentAuditTarget(apex, www)).toBe(true);
  });

  test("treats http and https default ports as equivalent", () => {
    const http = new URL("http://example.com");
    const https = new URL("https://example.com");
    expect(isEquivalentAuditTarget(http, https)).toBe(true);
  });

  test("requires non-default explicit ports to match", () => {
    const first = new URL("https://example.com:8443");
    const second = new URL("https://www.example.com:9443");
    expect(isEquivalentAuditTarget(first, second)).toBe(false);
  });

  test("does not match different registrable hosts", () => {
    const first = new URL("https://example.com");
    const second = new URL("https://example.org");
    expect(isEquivalentAuditTarget(first, second)).toBe(false);
  });
});
