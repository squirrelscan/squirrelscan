// Unit tests for CDN identification from response headers (pub#600).

import { describe, expect, test } from "bun:test";

import { detectCdnFromHeaders } from "../src/cdn";

describe("detectCdnFromHeaders", () => {
  test("each Cloudflare header identifies Cloudflare on its own", () => {
    expect(detectCdnFromHeaders({ server: "cloudflare" })).toBe("cloudflare");
    expect(detectCdnFromHeaders({ "cf-cache-status": "HIT" })).toBe("cloudflare");
    expect(detectCdnFromHeaders({ "cf-ray": "8d1f2a3b4c5d6e7f-SYD" })).toBe("cloudflare");
  });

  test("matches the server value case-insensitively", () => {
    expect(detectCdnFromHeaders({ server: "CloudFlare" })).toBe("cloudflare");
  });

  test("accepts a Headers object", () => {
    expect(detectCdnFromHeaders(new Headers({ "CF-Ray": "abc-SYD" }))).toBe("cloudflare");
    expect(detectCdnFromHeaders(new Headers({ Server: "nginx" }))).toBeNull();
  });

  test("other servers and CDNs are not Cloudflare", () => {
    expect(detectCdnFromHeaders({ server: "Vercel", "x-vercel-cache": "HIT" })).toBeNull();
    expect(detectCdnFromHeaders({ server: "Netlify" })).toBeNull();
    expect(detectCdnFromHeaders({ "x-cache": "Miss from cloudfront" })).toBeNull();
    // waf-detect reads this as AWS WAF, which is still not Cloudflare.
    expect(detectCdnFromHeaders({ "x-amz-cf-id": "abc" })).toBeNull();
  });

  test("Cloudflare wins when another provider's headers are present too", () => {
    expect(detectCdnFromHeaders({ "x-amz-cf-id": "abc", server: "cloudflare" })).toBe("cloudflare");
  });

  test("no headers is no CDN", () => {
    expect(detectCdnFromHeaders({})).toBeNull();
  });

  test("a header value Headers would reject does not throw", () => {
    // Rules see Set-Cookie "\n"-joined, which `new Headers(record)` refuses.
    const headers = {
      "set-cookie": "a=1\nb=2",
      "x-bad": "line\r\nbreak",
      "cf-cache-status": "DYNAMIC",
    };
    expect(detectCdnFromHeaders(headers)).toBe("cloudflare");
  });
});
