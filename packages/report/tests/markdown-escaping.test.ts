import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderMarkdown } from "../src/output/markdown";

function report(entityUrl: string): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-07-24T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    siteMetadata: {
      siteType: "blog",
      title: "Acme\\|Corp\nInjected",
      entityUrl,
      isYMYL: false,
      isLocalBusiness: false,
      hasOwnershipVerified: false,
      confidence: "high",
    },
  };
}

describe("Markdown report escaping", () => {
  test("escapes table control characters and rejects executable links", () => {
    const output = renderMarkdown(report("javascript:alert(1)"));
    expect(output).toContain("Acme\\\\\\|Corp<br>Injected");
    expect(output).not.toContain("](javascript:");
  });

  test("encodes parentheses in HTTP link destinations", () => {
    const output = renderMarkdown(report("https://example.com/a_(b)"));
    expect(output).toContain("https://example.com/a_%28b%29");
  });

  test("escapes link brackets and CRLF without a second escaping pass", () => {
    const value = report("https://example.com");
    value.siteMetadata!.title = "[Acme]\\|Corp\r\nInjected";
    const output = renderMarkdown(value);
    expect(output).toContain("[\\[Acme\\]\\\\\\|Corp<br>Injected](https://example.com/)");
  });
});
