// A node with both @graph and its own @type keeps both (#341).

import { describe, expect, test } from "bun:test";

import { flattenJsonLdNodes } from "@squirrelscan/utils/schema-rich-results";

import { parsePage } from "../src/index";

const page = (jsonLd: unknown): string =>
  `<!doctype html><html><head><title>t</title><script type="application/ld+json">${JSON.stringify(
    jsonLd
  )}</script></head><body><p>hi</p></body></html>`;

const typesOf = (nodes: Record<string, unknown>[]): string[] =>
  nodes.flatMap((n) =>
    n["@type"] === undefined ? [] : [n["@type"]].flat()
  ) as string[];

const wrapper = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "@id": "https://example.com/#webpage",
  name: "About",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://example.com/#org",
      name: "Example Ltd",
    },
  ],
};

describe("extractSchemas with @graph and own @type", () => {
  test("keeps the wrapper and its children, wrapper first", () => {
    const parsed = parsePage(page(wrapper), "https://example.com/about");
    expect(parsed.schemas.types).toEqual(["WebPage", "Organization"]);
  });

  test("parsePage and flattenJsonLdNodes agree on the node set", () => {
    const parsed = parsePage(page(wrapper), "https://example.com/about");
    const flat = typesOf(flattenJsonLdNodes(JSON.stringify(wrapper)));
    expect(parsed.schemas.types).toEqual(flat);
  });

  test("the stored wrapper does not nest its children again", () => {
    const parsed = parsePage(page(wrapper), "https://example.com/about");
    const own = parsed.schemas.all.find((s) => s["@type"] === "WebPage");
    expect(own).toBeDefined();
    expect("@graph" in (own as object)).toBe(false);
  });

  test("negative control: a typeless wrapper contributes only its children", () => {
    const yoast = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", "@id": "https://example.com/#webpage" },
        { "@type": "Organization", "@id": "https://example.com/#org" },
      ],
    };
    const parsed = parsePage(page(yoast), "https://example.com/");
    expect(parsed.schemas.types).toEqual(["WebPage", "Organization"]);
    expect(parsed.schemas.types).toEqual(
      typesOf(flattenJsonLdNodes(JSON.stringify(yoast)))
    );
  });
});
