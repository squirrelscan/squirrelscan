import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import { ogTagsRule } from "../src/core/og-tags";

const base = (type: string, ld = "") =>
  `<!doctype html><html><head><title>t</title>
<meta property="og:title" content="t"><meta property="og:description" content="d">
<meta property="og:image" content="https://example.com/i.png">
<meta property="og:type" content="${type}">${ld}</head><body><p>x</p></body></html>`;

const jsonLd = (type: string) =>
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"${type}"}</script>`;

function run(
  url: string,
  type: string,
  ld = "",
  classification?: { label: string; source: string; confidence: number }
) {
  const html = base(type, ld);
  const parsed = parsePage(html, url);
  if (classification)
    (parsed as unknown as Record<string, unknown>).classification = {
      pageType: classification,
    };
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed,
    options: {},
  } as unknown as RuleContext;
  const result = ogTagsRule.run(ctx);
  if (result instanceof Promise) throw new Error("async");
  return result.checks;
}
const typeChecks = (checks: ReturnType<typeof run>) =>
  checks.filter((c) => c.name.startsWith("og-type"));

describe("core/og-tags og:type fit", () => {
  test("article on a pricing URL warns, naming both types", () => {
    const [c] = typeChecks(run("https://example.com/pricing", "article"));
    expect(c?.status).toBe("warn");
    expect(c?.message).toContain("article");
    expect(c?.message).toContain("pricing page");
  });

  test("article on a ContactPage schema warns", () => {
    const [c] = typeChecks(
      run("https://example.com/reach", "article", jsonLd("ContactPage"))
    );
    expect(c?.status).toBe("warn");
    expect(c?.message).toContain("contact page");
  });

  test("article with BlogPosting schema passes", () => {
    const checks = run(
      "https://example.com/pricing",
      "article",
      jsonLd("BlogPosting")
    );
    expect(typeChecks(checks)).toEqual([]);
    expect(checks.some((c) => c.name === "og-tags")).toBe(true);
  });

  test("website on a blog post is info at most", () => {
    const [c] = typeChecks(
      run("https://example.com/x", "website", jsonLd("BlogPosting"))
    );
    expect(c?.status).toBe("info");
    expect(c?.name).toBe("og-type-mismatch");
  });

  test("unknown og:type is info", () => {
    const [c] = typeChecks(run("https://example.com/x", "blog"));
    expect(c).toMatchObject({ name: "og-type-unknown", status: "info" });
  });

  test("classifier-only pricing signal is info, not warn", () => {
    const [c] = typeChecks(
      run("https://example.com/x", "article", "", {
        label: "pricing",
        source: "model",
        confidence: 0.95,
      })
    );
    expect(c?.status).toBe("info");
  });

  test("a rules-sourced or low-confidence label is never used", () => {
    expect(
      typeChecks(
        run("https://example.com/x", "article", "", {
          label: "pricing",
          source: "rules",
          confidence: 0.99,
        })
      )
    ).toEqual([]);
    expect(
      typeChecks(
        run("https://example.com/x", "article", "", {
          label: "pricing",
          source: "model",
          confidence: 0.5,
        })
      )
    ).toEqual([]);
  });

  test("a rules label derived from og:type does not judge og:type", () => {
    expect(
      typeChecks(
        run("https://example.com/x", "website", "", {
          label: "article",
          source: "rules",
          confidence: 0.99,
        })
      )
    ).toEqual([]);
  });
});
