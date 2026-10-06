// schema/json-ld-valid accepts the shapes schema.org and Google document (#463).
//
// `image` and `logo` have the schema.org range `ImageObject | URL`, so a URL, an
// ImageObject, or an array of either is valid. The validator only accepted
// strings, which flagged every page `@unhead/schema-org` (Nuxt) renders: it
// emits nested ImageObjects and links its `@graph` nodes by bare `{"@id"}`
// references.

import { describe, expect, test } from "bun:test";

import { parsePage, schemaCollectionFromJSON } from "@squirrelscan/parser";

import { jsonLdValidRule } from "../src/schema/json-ld-valid";
import type { CheckItem, CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/blog/post";

function html(...blocks: unknown[]): string {
  const scripts = blocks
    .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
    .join("");
  return `<!doctype html><html lang="en"><head><title>Post</title>${scripts}</head><body><h1>Post</h1></body></html>`;
}

function ctx(pageHtml: string): RuleContext {
  return {
    page: { url: URL, html: pageHtml, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(pageHtml, URL),
    options: {},
  };
}

async function run(pageHtml: string): Promise<CheckResult> {
  const result = await Promise.resolve(jsonLdValidRule.run(ctx(pageHtml)));
  expect(result.checks).toHaveLength(1);
  return result.checks[0]!;
}

function itemIds(check: CheckResult): string[] {
  return (check.items ?? []).map((item: CheckItem) => item.id);
}

/** An Article valid in every respect but `image`. */
function article(image: unknown): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "Post",
    ...(image === undefined ? {} : { image }),
    datePublished: "2026-01-01",
    author: { "@type": "Person", name: "A" },
    publisher: {
      "@type": "Organization",
      name: "P",
      logo: "https://example.com/logo.png",
    },
  };
}

const IMAGE_OBJECT = {
  "@type": "ImageObject",
  url: "https://example.com/a.png",
  width: 1200,
  height: 630,
};

describe("image accepts a URL, an ImageObject, or an array of either", () => {
  test("the #463 repro: a nested ImageObject is not reported", async () => {
    const check = await run(
      html({
        "@context": "https://schema.org",
        "@type": "Article",
        headline: "Repro",
        image: IMAGE_OBJECT,
        datePublished: "2026-01-01",
        author: { "@type": "Person", name: "A" },
        publisher: { "@type": "Organization", name: "P" },
      })
    );
    // publisher.logo is a separate, genuine finding on the repro page.
    expect(itemIds(check)).toEqual(["Article:publisher.logo"]);
    expect(check.message).toBe("Schema.org validation errors detected");
  });

  const accepted: Array<[string, unknown]> = [
    ["a URL", "https://example.com/a.png"],
    ["an ImageObject", IMAGE_OBJECT],
    ["an @id reference", { "@id": "https://example.com/#/schema/image/1" }],
    ["an array of URLs", ["https://example.com/a.png", "https://example.com/b.png"]],
    ["an array of ImageObjects", [IMAGE_OBJECT, IMAGE_OBJECT]],
    ["a mixed array", ["https://example.com/a.png", IMAGE_OBJECT]],
    ["an untyped object with a url", { url: "https://example.com/a.png" }],
    [
      "an ImageObject with only a contentUrl",
      { "@type": "ImageObject", contentUrl: "https://example.com/a.png" },
    ],
    ["a full schema.org type IRI", { ...IMAGE_OBJECT, "@type": "https://schema.org/ImageObject" }],
    ["a typed reference", { "@id": "https://example.com/#logo", "@type": "ImageObject" }],
  ];
  for (const [label, image] of accepted) {
    test(`${label} passes`, async () => {
      const check = await run(html(article(image)));
      expect(check.status).toBe("pass");
    });
  }

  test("the same holds for Product, LocalBusiness and Recipe", async () => {
    const check = await run(
      html(
        {
          "@context": "https://schema.org",
          "@type": "Product",
          name: "Widget",
          image: IMAGE_OBJECT,
          offers: {
            "@type": "Offer",
            price: "1",
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
          },
        },
        {
          "@context": "https://schema.org",
          "@type": "LocalBusiness",
          name: "Shop",
          url: "https://example.com/",
          address: { "@type": "PostalAddress", streetAddress: "1 Main St" },
          image: [IMAGE_OBJECT],
        },
        {
          "@context": "https://schema.org",
          "@type": "Recipe",
          name: "Soup",
          image: IMAGE_OBJECT,
          recipeIngredient: ["water"],
          recipeInstructions: ["boil"],
        }
      )
    );
    expect(check.status).toBe("pass");
  });

  test("Organization.logo accepts an ImageObject", async () => {
    const check = await run(
      html({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "P",
        url: "https://example.com/",
        logo: IMAGE_OBJECT,
      })
    );
    expect(check.status).toBe("pass");
  });

  const rejected: Array<[string, unknown]> = [
    ["a number", 42],
    ["a boolean", true],
    ["an array holding a number", ["https://example.com/a.png", 7]],
    ["a nested array", [["https://example.com/a.png"]]],
    ["an object of another type", { "@type": "Person", name: "Not an image" }],
    ["an empty object", {}],
    ["an ImageObject with no URL", { "@type": "ImageObject", width: 1200 }],
  ];
  for (const [label, image] of rejected) {
    test(`${label} is still reported as invalid`, async () => {
      const check = await run(html(article(image)));
      expect(check.status).toBe("fail");
      const item = check.items?.find((i) => i.id === "Article:image");
      expect(item?.label).toBe("Article has an invalid image");
      expect(item?.meta?.message).toBe(
        "Validation: Article.image must be a URL, an ImageObject, or an array of either"
      );
    });
  }

  test("a missing image is still reported as missing", async () => {
    const check = await run(html(article(undefined)));
    expect(itemIds(check)).toEqual(["Article:image"]);
    expect(check.items?.[0]?.label).toBe("Article missing image");
  });

  test("Organization.logo given as a number is still invalid", async () => {
    const check = await run(
      html({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "P",
        url: "https://example.com/",
        logo: 1,
      })
    );
    expect(itemIds(check)).toEqual(["Organization:logo"]);
  });
});

/**
 * The shape `@unhead/schema-org` renders for a Nuxt blog post: one `@graph`,
 * the identity's logo and the article's author, publisher and image all linked
 * by bare `{"@id"}` references (its `idReference()`).
 */
const UNHEAD_GRAPH = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@id": "https://example.com/#identity",
      "@type": "Organization",
      name: "Example",
      url: "https://example.com",
      logo: { "@id": "https://example.com/#logo" },
    },
    {
      "@id": "https://example.com/#logo",
      "@type": "ImageObject",
      url: "https://example.com/logo.png",
      contentUrl: "https://example.com/logo.png",
      caption: "Example",
      inLanguage: "en",
    },
    {
      "@id": "https://example.com/#website",
      "@type": "WebSite",
      name: "Example",
      url: "https://example.com",
      inLanguage: "en",
      publisher: { "@id": "https://example.com/#identity" },
    },
    {
      "@id": "https://example.com/blog/post/#webpage",
      "@type": "WebPage",
      name: "Post",
      url: "https://example.com/blog/post",
      isPartOf: { "@id": "https://example.com/#website" },
      primaryImageOfPage: { "@id": "https://example.com/#logo" },
      potentialAction: [{ "@type": "ReadAction", target: ["https://example.com/blog/post"] }],
    },
    {
      "@id": "https://example.com/blog/post/#article",
      "@type": "Article",
      headline: "Post",
      image: { "@id": "https://example.com/#/schema/image/abc" },
      datePublished: "2026-01-01T00:00:00+00:00",
      author: { "@id": "https://example.com/#/schema/person/def" },
      publisher: { "@id": "https://example.com/#identity" },
      isPartOf: { "@id": "https://example.com/blog/post/#webpage" },
      mainEntityOfPage: { "@id": "https://example.com/blog/post/#webpage" },
      inLanguage: "en",
      thumbnailUrl: "https://example.com/a.png",
    },
    {
      "@id": "https://example.com/#/schema/image/abc",
      "@type": "ImageObject",
      url: "https://example.com/a.png",
      contentUrl: "https://example.com/a.png",
      width: 1200,
      height: 630,
    },
    {
      "@id": "https://example.com/#/schema/person/def",
      "@type": "Person",
      name: "A",
    },
  ],
};

describe("bare @id references resolve against the page's JSON-LD", () => {
  test("an @unhead/schema-org page comes out clean", async () => {
    const check = await run(html(UNHEAD_GRAPH));
    expect(check.status).toBe("pass");
  });

  test("references resolve across separate script blocks", async () => {
    const graph = UNHEAD_GRAPH["@graph"];
    const check = await run(
      html(
        { "@context": "https://schema.org", "@graph": graph.slice(0, 3) },
        { "@context": "https://schema.org", "@graph": graph.slice(3) }
      )
    );
    expect(check.status).toBe("pass");
  });

  test("a referenced node missing a required field is still reported", async () => {
    const graph = UNHEAD_GRAPH["@graph"].map((node) =>
      node["@id"] === "https://example.com/#identity"
        ? { "@id": node["@id"], "@type": "Organization", url: "https://example.com" }
        : node
    );
    const check = await run(html({ "@context": "https://schema.org", "@graph": graph }));
    // Article.publisher points at the identity, which has neither a name nor a
    // logo; the Organization node itself is missing its name.
    expect(itemIds(check).sort()).toEqual([
      "Article:publisher.logo",
      "Article:publisher.name",
      "Organization:name",
    ]);
  });

  test("a reference to a node not on the page is checked as written", async () => {
    const check = await run(
      html({
        ...article("https://example.com/a.png"),
        publisher: { "@id": "https://elsewhere.example/#org" },
      })
    );
    expect(itemIds(check).sort()).toEqual(["Article:publisher.logo", "Article:publisher.name"]);
  });

  test("every description of an @id counts, whatever the order", async () => {
    const withLogo = {
      "@id": "#org",
      "@type": "Organization",
      name: "P",
      url: "https://example.com/",
      logo: "https://example.com/logo.png",
    };
    const withoutLogo = {
      "@id": "#org",
      "@type": "Organization",
      name: "P",
      url: "https://example.com/",
    };
    const post = {
      ...article("https://example.com/a.png"),
      "@context": undefined,
      publisher: { "@id": "#org" },
    };
    for (const graph of [
      [post, withLogo, withoutLogo],
      [post, withoutLogo, withLogo],
    ]) {
      const check = await run(html({ "@context": "https://schema.org", "@graph": graph }));
      expect(check.status).toBe("pass");
    }
  });

  test("an inline node with an @id merges with its other descriptions", async () => {
    const check = await run(
      html({
        "@context": "https://schema.org",
        "@graph": [
          {
            ...article("https://example.com/a.png"),
            "@context": undefined,
            publisher: { "@id": "#org", "@type": "Organization", name: "P" },
          },
          {
            "@id": "#org",
            "@type": "Organization",
            name: "P",
            url: "https://example.com/",
            logo: "https://example.com/logo.png",
          },
        ],
      })
    );
    expect(check.status).toBe("pass");
  });

  test("deeply nested JSON-LD does not overflow the stack", async () => {
    let nested: Record<string, unknown> = { name: "leaf" };
    for (let i = 0; i < 30_000; i++) nested = { "@id": `#n${i}`, about: nested };
    const check = await run(html({ ...article("https://example.com/a.png"), about: nested }));
    expect(check.status).toBe("pass");
  });

  test("a reference carrying a @type is still a reference", async () => {
    const check = await run(
      html({
        "@context": "https://schema.org",
        "@graph": [
          {
            ...article("https://example.com/a.png"),
            "@context": undefined,
            author: { "@id": "#a", "@type": "Person" },
          },
          { "@id": "#a", "@type": "Person", name: "A" },
        ],
      })
    );
    expect(check.status).toBe("pass");
  });
});

describe("parse errors and validation issues are reported once each", () => {
  test("a syntax error reads as a syntax error", async () => {
    const check = await run(
      `<html><head><script type="application/ld+json">{ "@type": "Article", </script></head><body></body></html>`
    );
    expect(check.message).toBe("Invalid JSON-LD syntax");
    expect(itemIds(check)).toEqual(["parse-0"]);
  });

  test("several parse errors keep their ids next to validation issues", async () => {
    const broken = `<script type="application/ld+json">{ "@type": </script>`;
    const pageHtml = html(article(42)).replace("</head>", `${broken}${broken}</head>`);
    const check = await run(pageHtml);
    expect(check.message).toBe("Invalid JSON-LD syntax");
    expect(itemIds(check)).toEqual(["parse-0", "parse-1", "Article:image"]);
  });

  test("validation issues are not repeated as parse errors", async () => {
    const check = await run(html(article(42)));
    expect(check.message).toBe("Schema.org validation errors detected");
    expect(itemIds(check)).toEqual(["Article:image"]);
  });
});

describe("parsed data stored by an older release", () => {
  test("re-validates instead of replaying stored validation issues", async () => {
    // A page reused from the crawl cache carries the parse of the release that
    // fetched it: here 0.0.103's verdict on the #463 repro.
    const pageHtml = html(article(IMAGE_OBJECT));
    const parsed = parsePage(pageHtml, URL);
    const stale = "Validation: Article.image must be a string or array of strings";
    const schemas = schemaCollectionFromJSON({
      _schemas: parsed.schemas.all,
      _errors: [stale],
      _raw: parsed.schemas.raw,
      _validationIssues: [
        { type: "Article", property: "image", message: stale, severity: "invalid", path: ["image"] },
      ],
    });
    const result = await Promise.resolve(
      jsonLdValidRule.run({
        page: { url: URL, html: pageHtml, statusCode: 200, loadTime: 0, headers: {} },
        parsed: {
          ...parsed,
          schemas,
          schema: { ...parsed.schema, valid: false, errors: [stale] },
        },
        options: {},
      })
    );
    expect(result.checks.map((c) => c.status)).toEqual(["pass"]);
  });

  test("falls back to the stored issues when the parsed schemas were not kept", async () => {
    const pageHtml = html(article(42));
    const parsed = parsePage(pageHtml, URL);
    const stored = parsed.schemas.validationIssues;
    const result = await Promise.resolve(
      jsonLdValidRule.run({
        page: { url: URL, html: pageHtml, statusCode: 200, loadTime: 0, headers: {} },
        parsed: {
          ...parsed,
          schemas: { validationIssues: stored } as unknown as typeof parsed.schemas,
        },
        options: {},
      })
    );
    expect(result.checks[0]?.items?.map((i) => i.id)).toEqual(["Article:image"]);

    // The same record through the rehydration the CLI and the engine use.
    const rehydrated = await Promise.resolve(
      jsonLdValidRule.run({
        page: { url: URL, html: pageHtml, statusCode: 200, loadTime: 0, headers: {} },
        parsed: {
          ...parsed,
          schemas: schemaCollectionFromJSON({
            _errors: parsed.schemas.errors,
            _raw: parsed.schemas.raw,
            _validationIssues: stored,
          }),
        },
        options: {},
      })
    );
    expect(rehydrated.checks[0]?.items?.map((i) => i.id)).toEqual(["Article:image"]);
  });
});
