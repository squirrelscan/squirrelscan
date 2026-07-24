// links/dead-links — locked-list semantics (#656): zero external links is a
// real result (no plan could verify anything), not a skipped/locked one; only
// genuinely missing link data keeps the rule skipped (and thus upsellable).

import { describe, expect, test } from "bun:test";

import { deadLinksRule } from "../src/links/dead-links";
import type { ExternalLinkCheckData, ParsedPage, RuleContext } from "../src/types";

function ctx(externalLinks: ExternalLinkCheckData[] | undefined): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      externalLinks,
    },
    options: {},
  } as unknown as RuleContext;
}

const link = (over: Partial<ExternalLinkCheckData> = {}): ExternalLinkCheckData => ({
  href: "https://other.example/",
  status: 200,
  error: null,
  sourcePages: ["https://example.com/"],
  ...over,
});

describe("links/dead-links", () => {
  test("missing link data → skipped (stays in the locked upsell)", () => {
    const { checks } = deadLinksRule.run(ctx(undefined));
    expect(checks[0].status).toBe("skipped");
  });

  test("zero external links → info, NOT skipped (#656: nothing any plan could check)", () => {
    const { checks } = deadLinksRule.run(ctx([]));
    expect(checks[0].status).toBe("info");
    expect(checks[0].message).toContain("No external links");
  });

  test("checked links summarize dead count", () => {
    const { checks } = deadLinksRule.run(
      ctx([link(), link({ href: "https://dead.example/", status: 404 })]),
    );
    expect(checks[0].status).toBe("info");
    expect(checks[0].value).toBe(1);
  });
});
