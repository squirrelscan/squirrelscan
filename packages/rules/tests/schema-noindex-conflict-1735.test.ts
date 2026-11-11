// #1735: crawl/schema-noindex-conflict emits a capped page sample and each page's evidence as
// structured data, with the true count in details, on top of the prose it always carried.

import { describe, expect, test } from "bun:test";

import { URL_ITEM_SAMPLE } from "../src/shared/sample-items";
import { schemaNoindexConflict } from "../src/crawl/schema-noindex-conflict";
import type { RuleContext } from "../src/types";

function page(url: string, over: { noindex?: "meta" | "header" } = {}) {
  return {
    url,
    headers: over.noindex === "header" ? { "x-robots-tag": "noindex" } : {},
    parsed: {
      meta: { robots: over.noindex === "meta" ? "noindex" : null },
      schemas: { types: ["Article", "Product"], valid: true, errors: [], raw: null },
    },
  };
}

function run(pages: ReturnType<typeof page>[]) {
  const ctx = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    site: { baseUrl: "https://example.com", pages, robotsTxt: null },
    options: {},
  } as unknown as RuleContext;
  const result = schemaNoindexConflict.run(ctx);
  if (result instanceof Promise) throw new Error("legacy path is sync");
  return result.checks[0]!;
}

describe("schema-noindex-conflict evidence (#1735)", () => {
  test("each conflict carries its blocking source and schema types as structured data", () => {
    const check = run([
      page("https://example.com/m", { noindex: "meta" }),
      page("https://example.com/h", { noindex: "header" }),
      page("https://example.com/ok"),
    ]);
    expect(check.status).toBe("fail");
    // Sorted by URL, so the sample does not follow crawl order.
    expect(check.pages).toEqual(["https://example.com/h", "https://example.com/m"]);
    expect(check.items?.map((i) => i.id)).toEqual(check.pages!);
    expect(check.items?.[0]?.meta).toMatchObject({ blockedBy: ["header:noindex"] });
    expect(check.items?.[1]?.meta).toMatchObject({ blockedBy: ["meta:noindex"] });
    expect((check.items?.[0]?.meta as { schemaTypes: string[] }).schemaTypes).toEqual(
      expect.arrayContaining(["Article", "Product"]),
    );
    expect(check.details).toMatchObject({ occurrences: 2, pagesTruncated: 2 });
    // The prose is unchanged.
    expect(String(check.value)).toContain("Blocked by: header:noindex");
    expect(check.message).toBe("2 page(s) have rich schema but are blocked from indexing");
  });

  test("a long list is a capped sample with the true count in details", () => {
    const pages = Array.from({ length: URL_ITEM_SAMPLE + 50 }, (_, i) =>
      page(`https://example.com/p${String(i).padStart(4, "0")}`, { noindex: "meta" }),
    );
    const check = run(pages);
    expect(check.pages!.length).toBe(URL_ITEM_SAMPLE);
    expect(check.items!.length).toBe(check.pages!.length);
    const total = URL_ITEM_SAMPLE + 50;
    expect(check.details).toMatchObject({ occurrences: total, pagesTruncated: total });
    expect(check.message).toBe(`${total} page(s) have rich schema but are blocked from indexing`);
  });

  test("no conflict: a pass with no page list", () => {
    const check = run([page("https://example.com/ok")]);
    expect(check.status).toBe("pass");
    expect(check.pages).toBeUndefined();
    expect(check.items).toBeUndefined();
  });
});
