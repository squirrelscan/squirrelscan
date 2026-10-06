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
    // The page also lacks publisher.logo, which #469 stopped requiring.
    expect(check.status).toBe("pass");
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
    // Article.publisher points at the identity, which has no name; the
    // Organization node itself is missing its name too.
    expect(itemIds(check).sort()).toEqual(["Article:publisher.name", "Organization:name"]);
  });

  test("a reference to a node not on the page is checked as written", async () => {
    const check = await run(
      html({
        ...article("https://example.com/a.png"),
        publisher: { "@id": "https://elsewhere.example/#org" },
      })
    );
    expect(itemIds(check)).toEqual(["Article:publisher.name"]);
  });

  test("every description of an @id counts, whatever the order", async () => {
    const named = { "@id": "#a", "@type": "Person", name: "A" };
    const unnamed = { "@id": "#a", "@type": "Person", url: "https://example.com/a" };
    const post = {
      ...article("https://example.com/a.png"),
      "@context": undefined,
      author: { "@id": "#a" },
    };
    for (const graph of [
      [post, named, unnamed],
      [post, unnamed, named],
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

// #469: single values where an array is usual, AggregateOffer, an optional
// publisher, untyped @graph nodes, and the BreadcrumbList / FAQPage entry
// checks that never ran.
describe("the validator follows schema.org and Google, not a stricter reading (#469)", () => {
  const recipe = (extra: Record<string, unknown>) => ({
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: "Soup",
    image: "https://example.com/soup.png",
    recipeIngredient: ["water"],
    recipeInstructions: ["boil"],
    ...extra,
  });

  const recipeAccepted: Array<[string, Record<string, unknown>]> = [
    ["a single ingredient string", { recipeIngredient: "1 cup water" }],
    ["a single instruction string", { recipeInstructions: "Boil the water." }],
    ["one HowToStep", { recipeInstructions: { "@type": "HowToStep", text: "Boil." } }],
    [
      "a list of HowToSteps",
      {
        recipeInstructions: [
          { "@type": "HowToStep", text: "Boil." },
          { "@type": "HowToStep", text: "Serve." },
        ],
      },
    ],
  ];
  for (const [label, extra] of recipeAccepted) {
    test(`Recipe: ${label} passes`, async () => {
      expect((await run(html(recipe(extra)))).status).toBe("pass");
    });
  }

  test("Recipe: instructions given as a number are still invalid", async () => {
    const check = await run(html(recipe({ recipeInstructions: 3 })));
    expect(itemIds(check)).toEqual(["Recipe:recipeInstructions"]);
    expect(check.items?.[0]?.meta?.message).toBe(
      "Validation: Recipe.recipeInstructions must be text, an object, or an array of either"
    );
  });

  const faq = (mainEntity: unknown) => ({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity,
  });
  const question = (extra: Record<string, unknown> = {}) => ({
    "@type": "Question",
    name: "Does it ship abroad?",
    acceptedAnswer: { "@type": "Answer", text: "Yes." },
    ...extra,
  });

  test("FAQPage: a single Question passes", async () => {
    expect((await run(html(faq(question())))).status).toBe("pass");
  });

  test("FAQPage: a Question without an answer is reported", async () => {
    const check = await run(html(faq([question(), question({ acceptedAnswer: undefined })])));
    expect(itemIds(check)).toEqual(["FAQPage:mainEntity.acceptedAnswer"]);
  });

  const crumb = (position: number, extra: Record<string, unknown> = {}) => ({
    "@type": "ListItem",
    position,
    name: `Crumb ${position}`,
    item: `https://example.com/${position}`,
    ...extra,
  });
  const breadcrumbs = (itemListElement: unknown) => ({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement,
  });

  test("BreadcrumbList: the last crumb needs no item", async () => {
    const check = await run(html(breadcrumbs([crumb(1), crumb(2), crumb(3, { item: undefined })])));
    expect(check.status).toBe("pass");
  });

  test("BreadcrumbList: a single crumb is the last one", async () => {
    expect((await run(html(breadcrumbs(crumb(1, { item: undefined }))))).status).toBe("pass");
  });

  test("BreadcrumbList: the highest position is the last crumb, in any written order", async () => {
    const check = await run(html(breadcrumbs([crumb(3, { item: undefined }), crumb(1), crumb(2)])));
    expect(check.status).toBe("pass");
  });

  test("BreadcrumbList: written last is not last when positions say otherwise", async () => {
    const check = await run(
      html(breadcrumbs([crumb(2, { item: undefined }), crumb(1, { item: undefined })]))
    );
    // Position 1 is the first crumb, wherever it is written, so it needs an item.
    expect(itemIds(check)).toEqual(["BreadcrumbList:itemListElement.item"]);
  });

  test("BreadcrumbList: crumbs given by @id reference take their position and name from the graph", async () => {
    const check = await run(
      html({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "BreadcrumbList",
            itemListElement: [{ "@id": "#second" }, { "@id": "#first" }],
          },
          { "@id": "#first", "@type": "ListItem", position: 1, item: { "@id": "#home" } },
          { "@id": "#second", "@type": "ListItem", position: 2, name: "This page" },
          { "@id": "#home", name: "Home" },
        ],
      })
    );
    expect(check.status).toBe("pass");
  });

  test("malformed values do not throw", async () => {
    const odd = await run(
      html(
        breadcrumbs([
          crumb(1, { position: { toString: "1" } }),
          crumb(2, { position: "2" }),
        ]),
        product({ "@type": "constructor", price: "1", priceCurrency: "USD", availability: "x" })
      )
    );
    expect(odd.status).toBe("pass");
  });

  test("BreadcrumbList: a crumb before the last without an item is reported", async () => {
    const check = await run(html(breadcrumbs([crumb(1), crumb(2, { item: undefined }), crumb(3)])));
    expect(itemIds(check)).toEqual(["BreadcrumbList:itemListElement.item"]);
  });

  test("BreadcrumbList: a crumb named on its item node passes, an unnamed one does not", async () => {
    const onItem = crumb(1, {
      name: undefined,
      item: { "@id": "https://example.com/1", name: "Home" },
    });
    expect((await run(html(breadcrumbs([onItem, crumb(2)])))).status).toBe("pass");

    const unnamed = crumb(1, { name: undefined });
    const check = await run(html(breadcrumbs([unnamed, crumb(2)])));
    expect(itemIds(check)).toEqual(["BreadcrumbList:itemListElement.name"]);
  });

  const product = (offers: unknown) => ({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Widget",
    image: "https://example.com/w.png",
    offers,
  });

  test("Product: an AggregateOffer with lowPrice and priceCurrency passes", async () => {
    const check = await run(
      html(
        product({ "@type": "AggregateOffer", lowPrice: "10", highPrice: "20", priceCurrency: "USD" })
      )
    );
    expect(check.status).toBe("pass");
  });

  test("Product: an AggregateOffer without lowPrice, and an Offer without price, are reported", async () => {
    const aggregate = await run(
      html(product({ "@type": "AggregateOffer", highPrice: "20", priceCurrency: "USD" }))
    );
    expect(itemIds(aggregate)).toEqual(["Product:offers.lowPrice"]);

    const offer = await run(
      html(
        product({
          "@type": "Offer",
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
        })
      )
    );
    expect(itemIds(offer)).toEqual(["Product:offers.price"]);
  });

  test("Article: no publisher, or a Person publisher with no logo, passes", async () => {
    const { publisher: _omitted, ...withoutPublisher } = article("https://example.com/a.png");
    expect((await run(html(withoutPublisher))).status).toBe("pass");

    const personPublisher = {
      ...article("https://example.com/a.png"),
      publisher: { "@type": "Person", name: "Jo Writer" },
    };
    expect((await run(html(personPublisher))).status).toBe("pass");
  });

  test("Article: a publisher given without a name is still reported", async () => {
    const check = await run(
      html({ ...article("https://example.com/a.png"), publisher: { "@type": "Organization" } })
    );
    expect(itemIds(check)).toEqual(["Article:publisher.name"]);
  });

  test("a reference to an untyped top-level @graph node resolves", async () => {
    const post = {
      ...article("https://example.com/a.png"),
      "@context": undefined,
      author: { "@id": "#p" },
    };
    const inGraph = await run(
      html({ "@context": "https://schema.org", "@graph": [post, { "@id": "#p", name: "A" }] })
    );
    expect(inGraph.status).toBe("pass");

    // The same node in its own script block.
    const separate = await run(
      html({ ...post, "@context": "https://schema.org" }, { "@id": "#p", name: "A" })
    );
    expect(separate.status).toBe("pass");

    // Without the node, the reference is checked as written.
    const missing = await run(html({ ...post, "@context": "https://schema.org" }));
    expect(itemIds(missing)).toEqual(["Article:author.name"]);
  });
});
