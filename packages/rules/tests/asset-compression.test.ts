// perf/asset-compression — uncompressed text sub-resources (#9).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { ASSET_COMPRESSION_LIMITS } from "@squirrelscan/utils/constants";

import { assetCompressionRule } from "../src/performance/asset-compression";
import { compressionRule } from "../src/performance/compression";
import type {
  ParsedPage,
  ResourceSizeData,
  RuleContext,
  ScriptContentData,
  SiteData,
} from "../src/types";

const BIG = ASSET_COMPRESSION_LIMITS.MIN_BYTES * 2;
const SMALL = Math.floor(ASSET_COMPRESSION_LIMITS.MIN_BYTES / 2);

function css(overrides: Partial<ResourceSizeData> = {}): ResourceSizeData {
  return {
    url: "https://example.com/app.css",
    status: 200,
    error: null,
    contentType: "text/css",
    sizeBytes: BIG,
    sourcePages: ["https://example.com/"],
    contentEncoding: null,
    ...overrides,
  };
}

function script(overrides: Partial<ScriptContentData> = {}): ScriptContentData {
  return {
    url: "https://example.com/app.js",
    status: 200,
    error: null,
    contentType: "application/javascript",
    sizeBytes: BIG,
    content: null,
    sourcePages: ["https://example.com/"],
    contentEncoding: null,
    ...overrides,
  };
}

function ctx(site: Partial<SiteData["resourceSizes"]> & {
  scripts?: ScriptContentData[];
  css?: ResourceSizeData[];
  images?: ResourceSizeData[];
} = {}): RuleContext {
  return {
    page: {
      url: "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      resourceSizes: { css: site.css ?? [], images: site.images ?? [] },
      scripts: site.scripts ?? [],
    },
    options: {},
  };
}

function run(c: RuleContext): CheckResult[] {
  return assetCompressionRule.run(c).checks as CheckResult[];
}

function only(checks: CheckResult[]): CheckResult {
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

function itemIds(check: CheckResult): string[] {
  return (check.items ?? []).map((i) => i.id);
}

describe("perf/asset-compression — reports", () => {
  test("a large uncompressed CSS file is reported with its URL and size", () => {
    const check = only(run(ctx({ css: [css()] })));
    expect(check.status).toBe("warn");
    expect(itemIds(check)).toEqual(["https://example.com/app.css"]);
    expect(check.items?.[0]?.meta?.sizeBytes).toBe(BIG);
    expect(check.items?.[0]?.meta?.size).toBe("200.0 KB");
  });

  test("a large uncompressed JS file is reported", () => {
    const check = only(run(ctx({ scripts: [script()] })));
    expect(check.status).toBe("warn");
    expect(itemIds(check)).toEqual(["https://example.com/app.js"]);
  });

  test("an SVG in the image pool is reported (image/svg+xml is text)", () => {
    const check = only(
      run(
        ctx({
          images: [
            css({ url: "https://example.com/hero.svg", contentType: "image/svg+xml" }),
          ],
        })
      )
    );
    expect(check.status).toBe("warn");
    expect(itemIds(check)).toEqual(["https://example.com/hero.svg"]);
  });

  test.each([
    ["identity", "identity"],
    ["IDENTITY (uppercase)", "IDENTITY"],
  ])("%s is reported — it means compression is off, not unknown", (_l, enc) => {
    const check = only(run(ctx({ css: [css({ contentEncoding: enc })] })));
    expect(check.status).toBe("warn");
  });

  test("findings are sorted biggest-first and totalled", () => {
    const check = only(
      run(
        ctx({
          css: [
            css({ url: "https://example.com/small.css", sizeBytes: BIG }),
            css({ url: "https://example.com/huge.css", sizeBytes: BIG * 3 }),
          ],
        })
      )
    );
    expect(itemIds(check)).toEqual([
      "https://example.com/huge.css",
      "https://example.com/small.css",
    ]);
    expect(check.details?.uncompressedBytes).toBe(BIG * 4);
  });
});

describe("perf/asset-compression — stays silent", () => {
  // Each case is the reporting test above with exactly ONE field changed, so a
  // rule that stopped filtering would flip these to "warn" rather than pass for
  // an unrelated reason.
  test.each([
    ["gzip", { contentEncoding: "gzip" }],
    ["brotli", { contentEncoding: "br" }],
    ["zstd", { contentEncoding: "zstd" }],
    ["deflate", { contentEncoding: "deflate" }],
    ["mixed codings", { contentEncoding: "gzip, br" }],
    ["uppercase header value", { contentEncoding: "GZIP" }],
    ["padded header value", { contentEncoding: "  br  " }],
    // A coding this file has never heard of is still a coding. Reporting it as
    // uncompressed is the false positive the rule most needs to avoid.
    ["shared-dictionary (dcb)", { contentEncoding: "dcb" }],
    ["some future coding", { contentEncoding: "not-invented-yet" }],
  ])("a %s-compressed asset is not reported", (_label, override) => {
    const check = only(run(ctx({ css: [css(override)] })));
    expect(check.status).toBe("pass");
  });


  test("an all-identity coding list is still reported as uncompressed", () => {
    // Content-Encoding is a LIST. The fetchers normalize a lone `identity` to
    // null, but they match one token, so `identity, identity` arrives verbatim
    // and must not be mistaken for a real coding.
    const check = only(run(ctx({ css: [css({ contentEncoding: "identity, identity" })] })));
    expect(check.status).toBe("warn");
    expect(itemIds(check)).toEqual(["https://example.com/app.css"]);
  });

  test("a list is compressed when any token is a real coding", () => {
    const check = only(run(ctx({ css: [css({ contentEncoding: "identity, gzip" })] })));
    expect(check.status).toBe("pass");
  });

  test("a 206 whose confirming GET failed is not reported", () => {
    // The end of the chain the resource checker's capture tests start: an
    // unconfirmable ranged 206 records `undefined`, and the rule must stay
    // silent rather than report a possibly-gzipped asset as uncompressed.
    const check = only(
      run(ctx({ css: [css({ status: 206, contentEncoding: undefined })] }))
    );
    expect(check.status).toBe("skipped");
  });

  test("an asset under the threshold is not reported", () => {
    const check = only(run(ctx({ css: [css({ sizeBytes: SMALL })] })));
    expect(check.status).toBe("pass");
  });

  test("an asset exactly at the threshold is not reported (strict >)", () => {
    const check = only(
      run(ctx({ css: [css({ sizeBytes: ASSET_COMPRESSION_LIMITS.MIN_BYTES })] }))
    );
    expect(check.status).toBe("pass");
  });

  test("unknown encoding (undefined) is not treated as uncompressed", () => {
    // The CLI's script content-store cache returns a hit without ever seeing
    // response headers. Defaulting that to null would report every cached script.
    const c = ctx({ scripts: [script()] });
    delete (c.site!.scripts![0] as ScriptContentData).contentEncoding;
    expect(only(run(c)).status).toBe("skipped");
  });

  test("a cache-reused record is not reported (headers are the prior crawl's)", () => {
    const check = only(run(ctx({ css: [css({ cacheReason: "max-age" })] })));
    expect(check.status).toBe("skipped");
  });

  test.each([
    ["PNG", "image/png"],
    ["WebP", "image/webp"],
    ["woff2 font", "font/woff2"],
    ["PDF", "application/pdf"],
    ["octet-stream", "application/octet-stream"],
  ])("a large %s is not reported (not compressible text)", (_label, contentType) => {
    const check = only(run(ctx({ images: [css({ contentType })] })));
    expect(check.status).toBe("skipped");
  });

  test.each([
    ["a 404", { status: 404 }],
    ["a 301", { status: 301 }],
    ["a failed fetch", { status: null }],
  ])("%s is not reported", (_label, override) => {
    const check = only(run(ctx({ css: [css(override)] })));
    expect(check.status).toBe("skipped");
  });

  test("a record carrying an error is not reported (its size is not trustworthy)", () => {
    // The script fetcher's "script too large" bail reports the byte it stopped
    // reading at, not the asset's real length — and this rule's finding names
    // that size out loud, so it must not speak for such a record.
    const check = only(
      run(ctx({ scripts: [script({ error: "script too large" })] }))
    );
    expect(check.status).toBe("skipped");
  });

  test("an unknown size is not reported", () => {
    const check = only(run(ctx({ css: [css({ sizeBytes: null })] })));
    expect(check.status).toBe("pass");
  });

  test("no crawled sub-resources at all → skipped, not pass", () => {
    const check = only(run(ctx()));
    expect(check.status).toBe("skipped");
    expect(check.skipReason).toBe("no_data");
  });
});

describe("perf/asset-compression — options", () => {
  test("min_bytes lowers the threshold", () => {
    const c = ctx({ css: [css({ sizeBytes: SMALL })] });
    c.options = { min_bytes: 1024 };
    expect(only(run(c)).status).toBe("warn");
  });
});

describe("perf/compression is untouched by this rule", () => {
  // #9's acceptance criteria: the HTML-document check keeps its behaviour. The
  // new rule is site-scope and reads ctx.site; perf/compression is page-scope
  // and reads ctx.page.headers, so asset data must not reach it.
  test("still judges only the page's own response headers", () => {
    const c = ctx({ css: [css()] });
    c.page.headers = { "content-type": "text/html", "content-encoding": "br" };
    const checks = compressionRule.run(c).checks as CheckResult[];
    expect(only(checks).status).toBe("pass");
    expect(only(checks).value).toBe("br");
  });

  test("still fails an uncompressed HTML document", () => {
    const c = ctx();
    c.page.headers = { "content-type": "text/html" };
    c.page.html = "x".repeat(5000);
    const checks = compressionRule.run(c).checks as CheckResult[];
    expect(only(checks).status).toBe("fail");
  });

  test("perf/compression is page-scope, perf/asset-compression is site-scope", () => {
    expect(compressionRule.meta.scope).toBe("page");
    expect(assetCompressionRule.meta.scope).toBe("site");
  });
});
