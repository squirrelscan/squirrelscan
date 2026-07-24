import { describe, it, expect } from "bun:test";

import { normalizeUrl, isInScope } from "../../../src/crawler/frontier";

describe("normalizeUrl", () => {
  it("normalizes fragments, trailing slashes, and query parameters", () => {
    const normalized = normalizeUrl(
      "https://example.com/about/?utm_source=test#section",
      {
        baseUrl: "https://example.com",
        allowQueryParams: [],
        dropQueryPrefixes: ["utm_"],
      }
    );

    expect(normalized).toBe("https://example.com/about");
  });

  it("filters query params with allow list", () => {
    const normalized = normalizeUrl("https://example.com/page?keep=1&drop=2", {
      baseUrl: "https://example.com",
      allowQueryParams: ["keep"],
      dropQueryPrefixes: [],
    });

    expect(normalized).toBe("https://example.com/page?keep=1");
  });
});

describe("isInScope", () => {
  it("restricts to base host by default", () => {
    const decision = isInScope("https://other.com/page", {
      baseUrl: "https://example.com",
      include: [],
      exclude: [],
    });

    expect(decision.allowed).toBe(false);
  });

  it("respects include and exclude patterns", () => {
    const allowed = isInScope("https://docs.example.com/guide", {
      baseUrl: "https://example.com",
      include: ["https://docs.example.com/*"],
      exclude: ["https://docs.example.com/private/*"],
    });

    const blocked = isInScope("https://docs.example.com/private/secret", {
      baseUrl: "https://example.com",
      include: ["https://docs.example.com/*"],
      exclude: ["https://docs.example.com/private/*"],
    });

    expect(allowed.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
  });

  it("allows configured domains and subdomains, including localhost ports", () => {
    const allowed = isInScope("https://docs.example.com/guide", {
      baseUrl: "https://example.com",
      include: [],
      exclude: [],
      allowedDomains: ["example.com"],
    });

    const localAllowed = isInScope("http://localhost:3000/page", {
      baseUrl: "http://localhost:8080",
      include: [],
      exclude: [],
      allowedDomains: ["localhost"],
    });

    const blocked = isInScope("https://other.com/page", {
      baseUrl: "https://example.com",
      include: [],
      exclude: [],
      allowedDomains: ["example.com"],
    });

    expect(allowed.allowed).toBe(true);
    expect(localAllowed.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
  });
});
