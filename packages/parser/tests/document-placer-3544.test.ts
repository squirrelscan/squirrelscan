import { describe, expect, test } from "bun:test";

import { getDocumentPlacer, parsePage, type PageClassifierHook } from "../src";

const html = "<html><body><nav><a href='/a'>A</a></nav></body></html>";

describe("document placer (repo#3544)", () => {
  test("a classified parse leaves the placer reachable from its document", () => {
    const hook: PageClassifierHook = () => ({
      classification: { pageType: { label: "other", confidence: 1, source: "model" } } as never,
      placeLink: () => ({ region: { label: "navigation", confidence: 1, source: "model" }, section: null }) as never,
    });
    const parsed = parsePage(html, "https://example.com/", { classify: hook });
    const place = getDocumentPlacer(parsed.document);
    expect(place?.(parsed.document!.querySelector("a")!)?.region?.label).toBe("navigation");
  });
  test("a parse without a classifier has no placer", () => {
    expect(getDocumentPlacer(parsePage(html, "https://example.com/").document)).toBeNull();
  });
});
