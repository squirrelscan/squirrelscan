// auth login — actionable error hints (#1 of the auth/cloud guardrails).

import { describe, expect, test } from "bun:test";

import { localApiHint, normalizeBrowserUrl } from "@/controllers/auth/login";
import { DEFAULT_API_URL } from "@/self/api";

describe("auth/login — localApiHint", () => {
  test("points local/dev targets at the production override", () => {
    for (const url of [
      "https://api.squirrelscan.localhost",
      "http://localhost:4001",
      "http://127.0.0.1:8787/v1",
      "http://[::1]:8787/v1",
    ]) {
      const hint = localApiHint(url);
      expect(hint).toContain(`SQUIRREL_API_SERVER=${DEFAULT_API_URL}`);
      expect(hint).toContain("local API may be down");
    }
  });

  test("is empty for a production/remote target (no misleading hint)", () => {
    for (const url of [
      DEFAULT_API_URL,
      "https://api.squirrelscan.com",
      "https://api.example.com",
    ]) {
      expect(localApiHint(url)).toBe("");
    }
  });
});

describe("auth/login — browser URL validation", () => {
  test("accepts HTTP(S) authentication URLs", () => {
    expect(normalizeBrowserUrl("https://example.com/login?a=1")).toBe(
      "https://example.com/login?a=1"
    );
  });

  test("rejects shell-like and executable URL schemes", () => {
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow(
      "must use HTTP or HTTPS"
    );
    expect(() => normalizeBrowserUrl("file:///tmp/payload")).toThrow(
      "must use HTTP or HTTPS"
    );
  });
});
