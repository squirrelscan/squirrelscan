import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { content } from "@squirrelscan/rules";
import type { RuleContext } from "@squirrelscan/rules";

const { brokenHtmlRule } = content;

const VALID =
  "<!doctype html><html><head><title>t</title></head><body><p>ok</p></body></html>";
const WITH_DEPRECATED =
  "<!doctype html><html><head></head><body><center>x</center></body></html>";

function ctxFor(html: string, docHtml: string | null): RuleContext {
  return {
    page: { url: "https://example.com/", html, headers: {} },
    parsed: { document: docHtml === null ? null : parseHTML(docHtml).document },
    options: {},
  } as unknown as RuleContext;
}

const issueIds = (checks: { items?: { id: string }[] }[]) =>
  checks.flatMap((c) => (c.items ?? []).map((i) => i.id));

describe("content/broken-html DOM reuse (#262)", () => {
  test("reads ctx.parsed.document, not a re-parse of page.html", () => {
    // page.html is clean; only the parsed document carries the deprecated tag.
    // A finding therefore proves the rule consumed ctx.parsed.document.
    const ctx = ctxFor(VALID, WITH_DEPRECATED);
    const { checks } = brokenHtmlRule.run(ctx) as { checks: { items?: { id: string }[] }[] };
    expect(issueIds(checks)).toContain("deprecated-center");
  });

  test("falls back to parsing page.html when parsed.document is null", () => {
    const ctx = ctxFor(WITH_DEPRECATED, null);
    const { checks } = brokenHtmlRule.run(ctx) as { checks: { items?: { id: string }[] }[] };
    expect(issueIds(checks)).toContain("deprecated-center");
  });

  test("valid structure passes", () => {
    const ctx = ctxFor(VALID, VALID);
    const { checks } = brokenHtmlRule.run(ctx) as { checks: { name: string; status: string }[] };
    expect(checks.find((c) => c.name === "broken-html")?.status).toBe("pass");
  });
});
