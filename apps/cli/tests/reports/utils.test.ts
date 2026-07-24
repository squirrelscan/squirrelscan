// Tests for report utilities

import { describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  escapeHtml,
  formatReportDate,
  parseIndentedLines,
  sanitizeUrl,
  wrapText,
  writeReportFile,
} from "@/reports/utils";

describe("escapeHtml", () => {
  test("escapes ampersand", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  test("escapes less than", () => {
    expect(escapeHtml("a < b")).toBe("a &lt; b");
  });

  test("escapes greater than", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  test("escapes single quotes", () => {
    expect(escapeHtml("it's fine")).toBe("it&#39;s fine");
  });

  test("handles multiple special chars", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("wrapText", () => {
  test("wraps long text at specified width", () => {
    const text =
      "This is a long line that should be wrapped at a certain width";
    const result = wrapText(text, 20);
    expect(result.length).toBeGreaterThan(1);
    for (const line of result) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  test("keeps short text on single line", () => {
    const text = "Short text";
    const result = wrapText(text, 50);
    expect(result).toEqual(["Short text"]);
  });

  test("handles empty string", () => {
    const result = wrapText("", 50);
    expect(result).toEqual([]);
  });

  test("handles single long word", () => {
    const text = "superlongwordthatcannotbewrapped";
    const result = wrapText(text, 10);
    expect(result).toEqual(["superlongwordthatcannotbewrapped"]);
  });
});

describe("parseIndentedLines", () => {
  test("groups main lines with sub-items", () => {
    const text = "Main 1\n  Sub 1a\n  Sub 1b\nMain 2\n  Sub 2a";
    const result = parseIndentedLines(text);
    expect(result).toEqual([
      { main: "Main 1", subs: ["Sub 1a", "Sub 1b"] },
      { main: "Main 2", subs: ["Sub 2a"] },
    ]);
  });

  test("handles text with no sub-items", () => {
    const text = "Line 1\nLine 2\nLine 3";
    const result = parseIndentedLines(text);
    expect(result).toEqual([
      { main: "Line 1", subs: [] },
      { main: "Line 2", subs: [] },
      { main: "Line 3", subs: [] },
    ]);
  });

  test("ignores empty lines", () => {
    const text = "Line 1\n\nLine 2\n   \nLine 3";
    const result = parseIndentedLines(text);
    expect(result.length).toBe(3);
  });

  test("handles empty string", () => {
    const result = parseIndentedLines("");
    expect(result).toEqual([]);
  });
});

describe("sanitizeUrl", () => {
  test("allows http URLs", () => {
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
  });

  test("allows https URLs", () => {
    expect(sanitizeUrl("https://example.com/path")).toBe(
      "https://example.com/path"
    );
  });

  test("blocks javascript URLs", () => {
    expect(sanitizeUrl("javascript:alert('xss')")).toBe("#");
  });

  test("blocks data URLs", () => {
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("#");
  });

  test("blocks relative paths", () => {
    expect(sanitizeUrl("/path/to/page")).toBe("#");
  });

  test("handles case insensitive protocol", () => {
    expect(sanitizeUrl("HTTPS://example.com")).toBe("HTTPS://example.com");
  });

  test("handles whitespace", () => {
    expect(sanitizeUrl("  https://example.com  ")).toBe(
      "  https://example.com  "
    );
  });
});

describe("formatReportDate", () => {
  test("formats timestamp to ISO string", () => {
    const timestamp = "2024-01-15T10:30:00.000Z";
    const result = formatReportDate(timestamp);
    expect(result).toBe("2024-01-15T10:30:00.000Z");
  });

  test("converts date string to ISO format", () => {
    const timestamp = "2024-01-15";
    const result = formatReportDate(timestamp);
    expect(result).toContain("2024-01-15");
    expect(result).toContain("T");
  });
});

describe("writeReportFile", () => {
  const testDir = tmpdir();

  test("writes content to file", () => {
    const path = join(testDir, `test-report-${Date.now()}.txt`);
    writeReportFile(path, "test content");
    expect(existsSync(path)).toBe(true);
    unlinkSync(path);
  });

  test("throws descriptive error for invalid path", () => {
    const invalidPath = "/nonexistent/dir/file.txt";
    expect(() => writeReportFile(invalidPath, "content")).toThrow(
      /Failed to write report/
    );
  });

  test("throws descriptive error for permission denied", () => {
    // Create a read-only file
    const path = join(testDir, `readonly-${Date.now()}.txt`);
    writeFileSync(path, "original");
    try {
      // Try to write to a directory (should fail)
      expect(() => writeReportFile(testDir, "content")).toThrow(
        /Failed to write report/
      );
    } finally {
      unlinkSync(path);
    }
  });
});
