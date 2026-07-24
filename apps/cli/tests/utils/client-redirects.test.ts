import { describe, expect, test } from "bun:test";

import { findClientRedirects } from "@/utils/client-redirects";

describe("findClientRedirects", () => {
  const baseUrl = "https://example.com/page";

  describe("meta refresh detection", () => {
    test("detects standard meta refresh", () => {
      const html =
        '<meta http-equiv="refresh" content="0;url=https://target.com/">';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("detects meta refresh with reversed attributes", () => {
      const html =
        '<meta content="0;url=https://target.com/" http-equiv="refresh">';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("detects meta refresh with extra attributes", () => {
      const html =
        '<meta name="viewport" content="0;url=https://target.com/" http-equiv="refresh">';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("detects meta refresh with delay", () => {
      const html =
        '<meta http-equiv="refresh" content="5; url=https://target.com/">';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("resolves relative URL in meta refresh", () => {
      const html = '<meta http-equiv="refresh" content="0;url=/redirect">';
      expect(findClientRedirects(html, baseUrl)).toBe(
        "https://example.com/redirect"
      );
    });

    test("handles meta refresh with single quotes", () => {
      const html =
        "<meta http-equiv='refresh' content='0;url=https://target.com/'>";
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("handles case-insensitive attributes separated by newlines", () => {
      const html =
        '<META\nHTTP-EQUIV="REFRESH"\nCONTENT="0; URL=https://target.com/">';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });
  });

  describe("JavaScript redirect detection", () => {
    test("detects window.location.href assignment", () => {
      const html =
        '<script>window.location.href = "https://target.com/";</script>';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("detects window.location assignment", () => {
      const html = '<script>window.location = "https://target.com/";</script>';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("detects window.location.replace()", () => {
      const html =
        '<script>window.location.replace("https://target.com/");</script>';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("detects location.href assignment", () => {
      const html = '<script>location.href = "https://target.com/";</script>';
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("handles single quotes in JS", () => {
      const html =
        "<script>window.location.href = 'https://target.com/';</script>";
      expect(findClientRedirects(html, baseUrl)).toBe("https://target.com/");
    });

    test("resolves relative path in JS redirect", () => {
      const html = '<script>window.location.href = "/redirect";</script>';
      expect(findClientRedirects(html, baseUrl)).toBe(
        "https://example.com/redirect"
      );
    });

    test("handles absolute URL in JS redirect", () => {
      const html =
        '<script>window.location.href = "https://target.com/path";</script>';
      expect(findClientRedirects(html, baseUrl)).toBe(
        "https://target.com/path"
      );
    });
  });

  describe("edge cases", () => {
    test("returns null when no redirects found", () => {
      const html = "<html><body>No redirects here</body></html>";
      expect(findClientRedirects(html, baseUrl)).toBeNull();
    });

    test("handles relative path in meta refresh", () => {
      const html =
        '<meta http-equiv="refresh" content="0;url=not-a-valid-url">';
      // Relative paths are resolved against base URL
      expect(findClientRedirects(html, baseUrl)).toBe(
        "https://example.com/not-a-valid-url"
      );
    });

    test("prefers meta refresh over JS redirect", () => {
      const html = `
				<meta http-equiv="refresh" content="0;url=https://meta.com/">
				<script>window.location.href = "https://js.com/";</script>
			`;
      expect(findClientRedirects(html, baseUrl)).toBe("https://meta.com/");
    });

    test("handles empty HTML", () => {
      expect(findClientRedirects("", baseUrl)).toBeNull();
    });

    test("handles malformed meta tags", () => {
      const html = '<meta http-equiv="refresh" content="invalid">';
      expect(findClientRedirects(html, baseUrl)).toBeNull();
    });
  });
});
