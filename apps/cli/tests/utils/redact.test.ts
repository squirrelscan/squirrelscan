// Tests for sensitive data redaction utilities

import { describe, expect, test } from "bun:test";

import {
  redactString,
  redactValue,
  isSensitiveHeader,
  SENSITIVE_HEADERS,
} from "../../src/utils/redact";

describe("redactString", () => {
  describe("URL credentials", () => {
    test("redacts username:password in https URLs", () => {
      expect(redactString("https://user:pass@example.com")).toBe(
        "https://[REDACTED]@example.com"
      );
    });

    test("redacts username:password in http URLs", () => {
      expect(redactString("http://admin:secret123@api.example.com:8080/")).toBe(
        "http://[REDACTED]@api.example.com:8080/"
      );
    });

    test("preserves URLs without credentials", () => {
      expect(redactString("https://example.com/path")).toBe(
        "https://example.com/path"
      );
    });

    test("redacts credentials with URL-encoded characters", () => {
      // Note: Passwords containing literal @ are a known limitation - use %40 instead
      expect(redactString("https://user:p%40ss%20word@example.com")).toBe(
        "https://[REDACTED]@example.com"
      );
    });
  });

  describe("API keys in query params", () => {
    test("redacts api_key parameter", () => {
      expect(redactString("https://api.com?api_key=secret123")).toBe(
        "https://api.com?api_key=[REDACTED]"
      );
    });

    test("redacts api-key parameter (hyphen variant)", () => {
      expect(redactString("https://api.com?api-key=secret123")).toBe(
        "https://api.com?api-key=[REDACTED]"
      );
    });

    test("redacts apikey parameter (no separator)", () => {
      expect(redactString("https://api.com?apikey=secret123")).toBe(
        "https://api.com?apikey=[REDACTED]"
      );
    });

    test("redacts token parameter", () => {
      expect(redactString("https://api.com?token=xyz789")).toBe(
        "https://api.com?token=[REDACTED]"
      );
    });

    test("redacts access_token parameter", () => {
      expect(redactString("https://api.com?access_token=bearer123")).toBe(
        "https://api.com?access_token=[REDACTED]"
      );
    });

    test("redacts password parameter", () => {
      expect(redactString("https://login.com?password=secret")).toBe(
        "https://login.com?password=[REDACTED]"
      );
    });

    test("redacts pwd parameter", () => {
      expect(redactString("https://login.com?pwd=secret")).toBe(
        "https://login.com?pwd=[REDACTED]"
      );
    });

    test("redacts secret parameter", () => {
      expect(redactString("https://api.com?secret=mysecret")).toBe(
        "https://api.com?secret=[REDACTED]"
      );
    });

    test("redacts client_secret parameter", () => {
      expect(redactString("https://oauth.com?client_secret=abc")).toBe(
        "https://oauth.com?client_secret=[REDACTED]"
      );
    });

    test("redacts key parameter", () => {
      expect(redactString("https://api.com?key=abc123")).toBe(
        "https://api.com?key=[REDACTED]"
      );
    });

    test("redacts auth parameter", () => {
      expect(redactString("https://api.com?auth=token123")).toBe(
        "https://api.com?auth=[REDACTED]"
      );
    });

    test("redacts multiple sensitive params in one URL", () => {
      expect(
        redactString("https://api.com?api_key=abc&token=xyz&other=visible")
      ).toBe(
        "https://api.com?api_key=[REDACTED]&token=[REDACTED]&other=visible"
      );
    });

    test("handles params in middle of URL", () => {
      expect(
        redactString("https://api.com?foo=bar&api_key=secret&baz=qux")
      ).toBe("https://api.com?foo=bar&api_key=[REDACTED]&baz=qux");
    });

    test("case insensitive matching", () => {
      expect(redactString("https://api.com?API_KEY=secret")).toBe(
        "https://api.com?API_KEY=[REDACTED]"
      );
      expect(redactString("https://api.com?Token=secret")).toBe(
        "https://api.com?Token=[REDACTED]"
      );
    });
  });

  describe("Bearer tokens", () => {
    test("redacts Bearer token with JWT-like format", () => {
      expect(
        redactString("Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature")
      ).toBe("Bearer [REDACTED]");
    });

    test("redacts Bearer token with simple token", () => {
      expect(redactString("Bearer abc123xyz")).toBe("Bearer [REDACTED]");
    });

    test("redacts Bearer token with base64 padding", () => {
      expect(redactString("Bearer dXNlcjpwYXNz==")).toBe("Bearer [REDACTED]");
    });

    test("case insensitive Bearer", () => {
      expect(redactString("bearer abc123")).toBe("Bearer [REDACTED]");
      expect(redactString("BEARER abc123")).toBe("Bearer [REDACTED]");
    });
  });

  describe("Basic auth", () => {
    test("redacts Basic auth header", () => {
      expect(redactString("Basic dXNlcjpwYXNz")).toBe("Basic [REDACTED]");
    });

    test("redacts Basic auth with padding", () => {
      expect(redactString("Basic dXNlcjpwYXNz==")).toBe("Basic [REDACTED]");
    });

    test("case insensitive Basic", () => {
      expect(redactString("basic dXNlcjpwYXNz")).toBe("Basic [REDACTED]");
      expect(redactString("BASIC dXNlcjpwYXNz")).toBe("Basic [REDACTED]");
    });
  });

  describe("multiple patterns in one string", () => {
    test("redacts URL credentials and query params together", () => {
      expect(redactString("https://user:pass@api.com?api_key=abc")).toBe(
        "https://[REDACTED]@api.com?api_key=[REDACTED]"
      );
    });

    test("handles log-like strings with multiple sensitive values", () => {
      const input =
        'request url="https://user:pass@api.com" auth="Bearer token123"';
      const expected =
        'request url="https://[REDACTED]@api.com" auth="Bearer [REDACTED]"';
      expect(redactString(input)).toBe(expected);
    });

    test("handles multiple URLs in one string", () => {
      const input =
        "Fetched https://user:pass@api1.com and https://admin:secret@api2.com";
      expect(redactString(input)).toBe(
        "Fetched https://[REDACTED]@api1.com and https://[REDACTED]@api2.com"
      );
    });
  });

  describe("edge cases", () => {
    test("handles empty string", () => {
      expect(redactString("")).toBe("");
    });

    test("handles string with no sensitive data", () => {
      expect(redactString("Hello, world!")).toBe("Hello, world!");
    });

    test("preserves non-sensitive query params", () => {
      expect(redactString("https://api.com?page=1&limit=10")).toBe(
        "https://api.com?page=1&limit=10"
      );
    });

    test("handles malformed URLs gracefully", () => {
      expect(redactString("not a url at all")).toBe("not a url at all");
    });

    test("handles partial matches", () => {
      // Should not redact 'tokenizer' since it's not 'token='
      expect(redactString("https://api.com?tokenizer=fast")).toBe(
        "https://api.com?tokenizer=fast"
      );
    });
  });
});

describe("redactValue", () => {
  test("returns null for null", () => {
    expect(redactValue(null)).toBe(null);
  });

  test("returns undefined for undefined", () => {
    expect(redactValue(undefined)).toBe(undefined);
  });

  test("redacts strings", () => {
    expect(redactValue("Bearer token123")).toBe("Bearer [REDACTED]");
  });

  test("preserves numbers", () => {
    expect(redactValue(42)).toBe(42);
  });

  test("preserves booleans", () => {
    expect(redactValue(true)).toBe(true);
    expect(redactValue(false)).toBe(false);
  });

  test("redacts strings in arrays", () => {
    expect(redactValue(["Bearer token1", "Bearer token2"])).toEqual([
      "Bearer [REDACTED]",
      "Bearer [REDACTED]",
    ]);
  });

  test("redacts nested objects", () => {
    const input = {
      url: "https://user:pass@api.com",
      data: {
        nested: "Bearer token",
      },
    };
    expect(redactValue(input)).toEqual({
      url: "https://[REDACTED]@api.com",
      data: {
        nested: "Bearer [REDACTED]",
      },
    });
  });

  test("redacts sensitive header keys", () => {
    const input = {
      authorization: "Bearer secret",
      "x-api-key": "key123",
      "content-type": "application/json",
    };
    expect(redactValue(input)).toEqual({
      authorization: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      "content-type": "application/json",
    });
  });

  test("handles mixed arrays", () => {
    expect(redactValue([1, "Bearer token", true, { key: "value" }])).toEqual([
      1,
      "Bearer [REDACTED]",
      true,
      { key: "value" },
    ]);
  });
});

describe("isSensitiveHeader", () => {
  test("identifies sensitive headers", () => {
    expect(isSensitiveHeader("authorization")).toBe(true);
    expect(isSensitiveHeader("Authorization")).toBe(true);
    expect(isSensitiveHeader("AUTHORIZATION")).toBe(true);
    expect(isSensitiveHeader("x-api-key")).toBe(true);
    expect(isSensitiveHeader("cookie")).toBe(true);
    expect(isSensitiveHeader("set-cookie")).toBe(true);
  });

  test("identifies non-sensitive headers", () => {
    expect(isSensitiveHeader("content-type")).toBe(false);
    expect(isSensitiveHeader("accept")).toBe(false);
    expect(isSensitiveHeader("user-agent")).toBe(false);
  });
});

describe("SENSITIVE_HEADERS", () => {
  test("contains expected headers", () => {
    expect(SENSITIVE_HEADERS).toContain("authorization");
    expect(SENSITIVE_HEADERS).toContain("x-api-key");
    expect(SENSITIVE_HEADERS).toContain("cookie");
    expect(SENSITIVE_HEADERS).toContain("set-cookie");
    expect(SENSITIVE_HEADERS).toContain("x-auth-token");
    expect(SENSITIVE_HEADERS).toContain("x-access-token");
    expect(SENSITIVE_HEADERS).toContain("x-secret-key");
  });
});
