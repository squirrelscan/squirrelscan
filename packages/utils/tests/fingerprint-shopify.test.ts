// #1899 — a Shopify storefront serves one cached body for a while and then
// regenerates it. The regenerated body is the same page, but it carries fresh
// request identity AND emits its app blocks and app-extension asset tags in a
// different order. Measured from the hosted probe vantage on drscholls.com:
// fetches six seconds apart are byte-identical, fetches two minutes apart never
// are, and the render cache missed on essentially every page.
//
// Order-insensitivity here is deliberate and narrow, so most of these tests are
// about what is NOT normalized.

import { describe, expect, test } from "bun:test";

import { normalizeHtmlForFingerprint } from "../src/fingerprint";

function shopifyPage(opts: {
  reqid: string;
  u: string;
  requestId: string;
  blockOrder: readonly string[];
  assetOrder: readonly string[];
}): string {
  const blocks = opts.blockOrder
    .map(
      (app) =>
        `<!-- BEGIN app block: shopify://apps/${app}/blocks/x/abc --><div>${app}</div><!-- END app block -->`,
    )
    .join("");
  const assets = opts.assetOrder
    .map(
      (a) =>
        `<script src="https://cdn.shopify.com/extensions/${a}/assets/${a}.js" defer="defer"></script>`,
    )
    .join("\n");
  return `<!doctype html><html><head><title>Bunion Cushions</title></head><body>
<h1>Bunion Cushions</h1>
<script id="__st">var __st={"a":83120324884,"reqid":"${opts.reqid}","u":"${opts.u}","p":"product"};</script>
${blocks}
${assets}
<script>window.ShopifyAnalytics.meta={"page":{"requestId":"${opts.requestId}"}};</script>
</body></html>`;
}

const FIRST = {
  reqid: "0cfba0f1-a17b-485d-b540-81af6543af9e-1788783388",
  u: "fc3e51fed339",
  requestId: "d95d8a62-c404-4417-b6ab-289c89e9dd61-1788784074",
  blockOrder: ["pandectes-gdpr", "webrex-ai-seo-schema", "klaviyo"],
  assetOrder: ["smart-product-filters", "simple-bundle"],
} as const;

const REGENERATED = {
  reqid: "8a98bd8b-5e11-4fe1-809f-a90fbda45938-1788783953",
  u: "be9f47fdfff1",
  requestId: "33449930-e1b6-47fe-934c-09410b1932fe-1788784195",
  blockOrder: ["klaviyo", "pandectes-gdpr", "webrex-ai-seo-schema"],
  assetOrder: ["simple-bundle", "smart-product-filters"],
} as const;

describe("Shopify cache-entry churn (#1899)", () => {
  test("a regenerated cache entry of the same page normalizes identically", () => {
    const a = shopifyPage(FIRST);
    const b = shopifyPage(REGENERATED);
    expect(a).not.toBe(b);
    expect(normalizeHtmlForFingerprint(a)).toBe(normalizeHtmlForFingerprint(b));
  });

  test("each churn source alone is neutralized", () => {
    const base = normalizeHtmlForFingerprint(shopifyPage(FIRST));
    for (const [name, over] of [
      ["request id", { reqid: REGENERATED.reqid }],
      ["visitor token", { u: REGENERATED.u }],
      ["analytics requestId", { requestId: REGENERATED.requestId }],
      ["app block order", { blockOrder: REGENERATED.blockOrder }],
      ["asset tag order", { assetOrder: REGENERATED.assetOrder }],
    ] as const) {
      const changed = normalizeHtmlForFingerprint(shopifyPage({ ...FIRST, ...over }));
      expect(`${name}: ${changed === base}`).toBe(`${name}: true`);
    }
  });

  test("a real content change still moves the fingerprint", () => {
    // The real difference between two captured drscholls fetches: an app block
    // that rendered once and failed to render the next time.
    const rendered = shopifyPage(FIRST);
    const failed = rendered.replace(
      "<div>webrex-ai-seo-schema</div>",
      '<!-- Failed to render app block "webrex" -->',
    );
    expect(normalizeHtmlForFingerprint(failed)).not.toBe(normalizeHtmlForFingerprint(rendered));
  });

  test("a dropped block changes the fingerprint even though sorting reorders", () => {
    const three = shopifyPage(FIRST);
    const two = shopifyPage({ ...FIRST, blockOrder: ["pandectes-gdpr", "klaviyo"] });
    expect(normalizeHtmlForFingerprint(two)).not.toBe(normalizeHtmlForFingerprint(three));
  });
});

describe("what is deliberately NOT reordered", () => {
  const ext = (n: string) =>
    `<script src="https://cdn.shopify.com/extensions/${n}/a.js"></script>`;
  const plain = (n: string) => `<script src="/assets/${n}.js"></script>`;
  const sheet = (n: string) => `<link rel="stylesheet" href="/assets/${n}.css">`;

  test("ordinary scripts keep their order significant", () => {
    // Execution order decides initialization. We have not established that
    // reordering these is immaterial, so it must still rotate the hash.
    const a = `<body>${plain("a")}${plain("b")}</body>`;
    const b = `<body>${plain("b")}${plain("a")}</body>`;
    expect(normalizeHtmlForFingerprint(a)).not.toBe(normalizeHtmlForFingerprint(b));
  });

  test("ordinary stylesheets keep their order significant", () => {
    // The CSS cascade depends on it.
    const a = `<head>${sheet("a")}${sheet("b")}</head>`;
    const b = `<head>${sheet("b")}${sheet("a")}</head>`;
    expect(normalizeHtmlForFingerprint(a)).not.toBe(normalizeHtmlForFingerprint(b));
  });

  test("sorting never moves a tag past unrelated content", () => {
    const a = `<body>${ext("b")}${ext("a")}<h1>Heading</h1>${ext("d")}${ext("c")}</body>`;
    // Swapping ACROSS the heading is a structural change, not noise.
    const across = `<body>${ext("d")}${ext("c")}<h1>Heading</h1>${ext("b")}${ext("a")}</body>`;
    expect(normalizeHtmlForFingerprint(a)).not.toBe(normalizeHtmlForFingerprint(across));
    // Swapping WITHIN each run is noise, and is normalized.
    const within = `<body>${ext("a")}${ext("b")}<h1>Heading</h1>${ext("c")}${ext("d")}</body>`;
    expect(normalizeHtmlForFingerprint(a)).toBe(normalizeHtmlForFingerprint(within));
  });

  test("markup-looking text inside a textarea or title is left alone", () => {
    // A regex matches in here; a tokenizer must not. Reordering what a textarea
    // DISPLAYS would change the page while claiming to normalize noise.
    const a = `<body><textarea>${ext("b")}${ext("a")}</textarea></body>`;
    const b = `<body><textarea>${ext("a")}${ext("b")}</textarea></body>`;
    expect(normalizeHtmlForFingerprint(a)).not.toBe(normalizeHtmlForFingerprint(b));
    expect(normalizeHtmlForFingerprint(a)).toBe(a);
  });

  test("a uuid in a src stays significant", () => {
    // Extension asset paths carry a uuid identifying the extension VERSION.
    // Neutralizing it would reuse a render across an app upgrade.
    const v1 = `<body><script src="/x/019feafe-a942-7fff-96d6-964177000000/app.js"></script></body>`;
    const v2 = `<body><script src="/x/019feafe-a942-7fff-96d6-964177999999/app.js"></script></body>`;
    expect(normalizeHtmlForFingerprint(v1)).not.toBe(normalizeHtmlForFingerprint(v2));
  });

  test("a quoted '>' inside an open tag does not end the tag", () => {
    // The parser weakness that let a body-only rewrite reach a src attribute.
    const a = `<body><script data-x=">" src="/1111111111111.js"></script></body>`;
    expect(normalizeHtmlForFingerprint(a)).toBe(a);
  });

  test("a data-id attribute is not the __st bootstrap", () => {
    const a = `<body><script data-id="__st">document.body.textContent="A"</script></body>`;
    const b = `<body><script data-id="__st">document.body.textContent="B"</script></body>`;
    expect(normalizeHtmlForFingerprint(a)).not.toBe(normalizeHtmlForFingerprint(b));
  });

  test("a page with none of this passes through unchanged", () => {
    const plainPage = `<!doctype html><html><body><h1>Hello</h1><p>No scripts here.</p></body></html>`;
    expect(normalizeHtmlForFingerprint(plainPage)).toBe(plainPage);
  });
});

describe("hostile and malformed input", () => {
  test("unterminated markup terminates the scan rather than looping", () => {
    for (const broken of [
      "<body><!-- never closed",
      "<body><script>never closed",
      "<body><textarea>never closed",
      "<body><script",
      "<body><",
      "<<<<<<",
    ]) {
      expect(typeof normalizeHtmlForFingerprint(broken)).toBe("string");
    }
  });

  test("input that made the regex quadratic is linear here", () => {
    // The regex form measured 9 / 68 / 523 ms at 3.5 / 7 / 14 KB — cubic,
    // against a 2 MB ceiling. This is 10x the largest of those inputs.
    const hostile = "<link cdn.shopify.com/extensions/x ".repeat(4000);
    const started = performance.now();
    normalizeHtmlForFingerprint(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("many unclosed app-block BEGINs do not rescan the document", () => {
    const hostile = "<!-- BEGIN app block: shopify://apps/x/blocks/y/z -->".repeat(4000);
    const started = performance.now();
    normalizeHtmlForFingerprint(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
