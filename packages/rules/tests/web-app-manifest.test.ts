// mobile/web-app-manifest (#710): the rule reads the manifest the engine fetched
// and judges it. These tests drive the rule with hand-built manifest data; the
// engine's fetch, resolution and header reads are covered in audit-engine.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import {
  listWebAppManifestIconUrls,
  parseWebAppManifest,
  webAppManifestRule,
} from "../src/mobile/web-app-manifest";
import type {
  RuleContext,
  RuleResult,
  WebAppManifestData,
  WebAppManifestIconCheck,
} from "../src/types";

const MANIFEST_URL = "https://example.com/site.webmanifest";
const PAGE = "https://example.com/";

const VALID_MANIFEST = {
  name: "Example",
  short_name: "Example",
  start_url: "/",
  display: "standalone",
  theme_color: "#ffffff",
  icons: [
    { src: "/icons/192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

function okIcon(url: string, size: [number, number] = [0, 0]): WebAppManifestIconCheck {
  return {
    url,
    status: 200,
    error: null,
    naturalWidth: size[0] || null,
    naturalHeight: size[1] || null,
  };
}

function manifestData(over: Partial<WebAppManifestData> = {}): WebAppManifestData {
  const body = over.content === undefined ? JSON.stringify(VALID_MANIFEST) : over.content;
  return {
    url: MANIFEST_URL,
    status: 200,
    error: null,
    contentType: "application/manifest+json",
    content: body,
    sourcePages: [PAGE],
    themeColorsByPage: { [PAGE]: [{ content: "#ffffff", media: null }] },
    icons: [
      okIcon("https://example.com/icons/192.png"),
      okIcon("https://example.com/icons/512.png"),
    ],
    ...over,
  };
}

function ctx(webAppManifests: WebAppManifestData[] | undefined): RuleContext {
  return {
    page: { url: PAGE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as RuleContext["parsed"],
    site: { baseUrl: "https://example.com", pages: [], webAppManifests },
    options: {},
  } as RuleContext;
}

function run(webAppManifests: WebAppManifestData[] | undefined): CheckResult[] {
  return (webAppManifestRule.run(ctx(webAppManifests)) as RuleResult).checks;
}

/** The issue text of one check, joined so a test can match a field name in it. */
function itemText(check: CheckResult | undefined): string {
  return (check?.items ?? []).map((item) => `${item.id} ${item.label ?? ""}`).join("\n");
}

function only(checks: CheckResult[]): CheckResult {
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

describe("mobile/web-app-manifest", () => {
  test("not checked when the asset pass did not run, and an info with no penalty when no page links a manifest", () => {
    const notChecked = only(run(undefined));
    expect(notChecked.status).toBe("info");
    expect(notChecked.value).toBe("not-checked");

    const none = only(run([]));
    expect(none.status).toBe("info");
    expect(none.message).toContain("No page links a web app manifest");
  });

  test("a manifest that answers 404 is an error naming the manifest URL and the linking pages", () => {
    const check = only(
      run([
        manifestData({
          status: 404,
          content: null,
          error: "HTTP 404",
          contentType: "text/html",
          sourcePages: [PAGE, "https://example.com/about"],
        }),
      ]),
    );
    expect(check.status).toBe("fail");
    expect(check.message).toContain(MANIFEST_URL);
    expect(check.message).toContain("https://example.com/about");
    expect(check.pages).toEqual([PAGE, "https://example.com/about"]);
  });

  test("a body that is not valid JSON is an error, including an HTML page served with 200", () => {
    const junk = only(run([manifestData({ content: "{ not json" })]));
    expect(junk.status).toBe("fail");
    expect(junk.message).toContain("not a valid JSON object");

    const html = only(
      run([manifestData({ content: "<!doctype html><html></html>", contentType: "text/html" })]),
    );
    expect(html.status).toBe("fail");
  });

  test("a valid manifest as text/plain warns on the content type; as application/manifest+json it does not", () => {
    const plain = only(run([manifestData({ contentType: "text/plain" })]));
    expect(plain.status).toBe("warn");
    expect(itemText(plain)).toContain("content-type");
    expect(itemText(plain)).toContain("text/plain");

    const manifest = only(
      run([manifestData({ contentType: "application/manifest+json; charset=utf-8" })]),
    );
    expect(manifest.status).toBe("pass");
    expect(itemText(manifest)).not.toContain("content-type");

    const json = only(run([manifestData({ contentType: "application/json" })]));
    expect(json.status).toBe("pass");
  });

  test("a manifest missing name and short_name, start_url, or display warns naming each field", () => {
    const noNames = only(
      run([
        manifestData({
          content: JSON.stringify({ ...VALID_MANIFEST, name: undefined, short_name: undefined }),
        }),
      ]),
    );
    expect(noNames.status).toBe("warn");
    expect(itemText(noNames)).toContain('"name" and "short_name"');

    const noStart = only(
      run([manifestData({ content: JSON.stringify({ ...VALID_MANIFEST, start_url: undefined }) })]),
    );
    expect(noStart.status).toBe("warn");
    expect(itemText(noStart)).toContain('"start_url"');

    const noDisplay = only(
      run([manifestData({ content: JSON.stringify({ ...VALID_MANIFEST, display: undefined }) })]),
    );
    expect(noDisplay.status).toBe("warn");
    expect(itemText(noDisplay)).toContain('"display"');
  });

  test("a start_url on another origin warns; the same path on the manifest origin does not", () => {
    const other = only(
      run([
        manifestData({
          content: JSON.stringify({ ...VALID_MANIFEST, start_url: "https://elsewhere.test/app" }),
        }),
      ]),
    );
    expect(other.status).toBe("warn");
    expect(itemText(other)).toContain("another origin");

    const same = only(
      run([manifestData({ content: JSON.stringify({ ...VALID_MANIFEST, start_url: "/app" }) })]),
    );
    expect(same.status).toBe("pass");
  });

  test("a manifest with no 512px PNG icon warns; one with 192px and 512px PNG icons does not", () => {
    const noBig = only(
      run([
        manifestData({
          content: JSON.stringify({
            ...VALID_MANIFEST,
            icons: [{ src: "/icons/192.png", sizes: "192x192", type: "image/png" }],
          }),
        }),
      ]),
    );
    expect(noBig.status).toBe("warn");
    expect(itemText(noBig)).toContain("no 512x512 PNG icon");
    expect(itemText(noBig)).not.toContain("no 192x192");

    const both = only(run([manifestData()]));
    expect(itemText(both)).not.toContain("PNG icon");
  });

  test("an icon declared 512x512 whose file is 256x256 warns showing both sizes; a 404 icon warns naming its URL", () => {
    const mismatch = only(
      run([
        manifestData({
          icons: [
            okIcon("https://example.com/icons/192.png"),
            okIcon("https://example.com/icons/512.png", [256, 256]),
          ],
        }),
      ]),
    );
    expect(mismatch.status).toBe("warn");
    expect(itemText(mismatch)).toContain("declared 512x512");
    expect(itemText(mismatch)).toContain("256x256");

    const missing = only(
      run([
        manifestData({
          icons: [
            {
              url: "https://example.com/icons/192.png",
              status: 404,
              error: "HTTP 404",
              naturalWidth: null,
              naturalHeight: null,
            },
            okIcon("https://example.com/icons/512.png"),
          ],
        }),
      ]),
    );
    expect(missing.status).toBe("warn");
    expect(itemText(missing)).toContain("https://example.com/icons/192.png");
    expect(itemText(missing)).toContain("HTTP 404");
  });

  test("a theme-color that differs from the manifest warns; a light/dark pair where one matches does not", () => {
    const differs = only(
      run([manifestData({ themeColorsByPage: { [PAGE]: [{ content: "#000", media: null }] } })]),
    );
    expect(differs.status).toBe("warn");
    expect(itemText(differs)).toContain("theme-color");

    const pair = only(
      run([
        manifestData({
          themeColorsByPage: {
            [PAGE]: [
              { content: "#000000", media: "(prefers-color-scheme: dark)" },
              { content: "#FFF", media: "(prefers-color-scheme: light)" },
            ],
          },
        }),
      ]),
    );
    expect(pair.status).toBe("pass");
  });

  test("a manifest with no maskable icon is an info result, not a warning", () => {
    const check = only(
      run([
        manifestData({
          content: JSON.stringify({
            ...VALID_MANIFEST,
            icons: [
              { src: "/icons/192.png", sizes: "192x192", type: "image/png" },
              { src: "/icons/512.png", sizes: "512x512", type: "image/png" },
            ],
          }),
        }),
      ]),
    );
    expect(check.status).toBe("info");
    expect(itemText(check)).toContain("maskable");
  });

  test("ten pages linking the same manifest produce one finding listing those pages", () => {
    const pages = Array.from({ length: 10 }, (_, i) => `https://example.com/p${i}`);
    const checks = run([
      manifestData({
        sourcePages: pages,
        themeColorsByPage: Object.fromEntries(
          pages.map((p) => [p, [{ content: "#ffffff", media: null }]]),
        ),
      }),
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.pages).toEqual(pages);
    expect(checks[0]?.status).toBe("pass");
  });

  test("one finding per manifest URL when a site links two manifests", () => {
    const checks = run([
      manifestData({
        url: "https://example.com/a.webmanifest",
        content: null,
        status: 500,
        error: "HTTP 500",
      }),
      manifestData({ url: "https://example.com/b.webmanifest" }),
    ]);
    expect(checks).toHaveLength(2);
    expect(checks[0]?.value).toBe("https://example.com/a.webmanifest");
    expect(checks[1]?.value).toBe("https://example.com/b.webmanifest");
  });

  test("the rule never reports a missing apple-touch-icon; that stays with core/favicon", () => {
    const checks = run([manifestData()]);
    expect(JSON.stringify(checks)).not.toContain("apple-touch");
  });

  test("relative icon src and start_url resolve against the manifest URL, not the page", () => {
    const manifestAt = "https://example.com/static/m.json";
    expect(
      listWebAppManifestIconUrls(JSON.stringify({ icons: [{ src: "icon.png" }] }), manifestAt),
    ).toEqual(["https://example.com/static/icon.png"]);
    expect(
      listWebAppManifestIconUrls(JSON.stringify({ icons: [{ src: "../img/x.png" }] }), manifestAt),
    ).toEqual(["https://example.com/img/x.png"]);
    expect(listWebAppManifestIconUrls("not json", manifestAt)).toEqual([]);
    expect(
      listWebAppManifestIconUrls(
        JSON.stringify({ icons: [{ src: "a.png" }, { src: "a.png" }] }),
        manifestAt,
      ),
    ).toHaveLength(1);

    // start_url "./app" from /static/m.json resolves to /static/app, same origin: no warning.
    const check = only(
      run([
        manifestData({
          url: manifestAt,
          content: JSON.stringify({ ...VALID_MANIFEST, start_url: "./app" }),
        }),
      ]),
    );
    expect(check.status).toBe("pass");
  });

  test("meta severity is error, so a failed manifest reports as an error", () => {
    expect(webAppManifestRule.meta.severity).toBe("error");
  });

  test("theme colours in rgb() or named form are not compared, so they never warn falsely", () => {
    const content = JSON.stringify({ ...VALID_MANIFEST, theme_color: "rgb(255, 255, 255)" });
    const rgbManifest = only(run([manifestData({ content })]));
    expect(itemText(rgbManifest)).not.toContain("theme-color");
    const namedMeta = only(
      run([manifestData({ themeColorsByPage: { [PAGE]: [{ content: "white", media: null }] } })]),
    );
    expect(itemText(namedMeta)).not.toContain("theme-color");
  });

  test("site-controlled text in messages is cut at 120 characters", () => {
    const longStart = `http://[${"a".repeat(400)}`;
    const content = JSON.stringify({ ...VALID_MANIFEST, start_url: longStart });
    const check = only(run([manifestData({ content, contentType: `text/${"x".repeat(400)}` })]));
    for (const item of check.items ?? []) expect((item.label ?? "").length).toBeLessThan(220);
    expect(itemText(check)).toContain("...");
  });

  test("icons on another origin are counted as not checked", () => {
    const content = JSON.stringify({
      ...VALID_MANIFEST,
      icons: [
        ...VALID_MANIFEST.icons,
        { src: "https://cdn.other.net/i.png", sizes: "96x96", type: "image/png" },
      ],
    });
    const check = only(run([manifestData({ content })]));
    expect(itemText(check)).toContain("1 icon(s) on another origin not checked");
  });

  test("same-origin icons past the fetch cap are counted; data: icons are not", () => {
    const extra = Array.from({ length: 3 }, (_, n) => ({
      src: `/icons/extra-${n}.png`,
      sizes: "64x64",
      type: "image/png",
    }));
    const content = JSON.stringify({
      ...VALID_MANIFEST,
      icons: [
        ...VALID_MANIFEST.icons,
        ...extra,
        { src: "data:image/png;base64,AAAA", sizes: "16x16" },
      ],
    });
    // The engine checked only the first two (as if the cap were reached).
    const check = only(run([manifestData({ content })]));
    expect(itemText(check)).toContain("3 icon(s) past the first 20 not checked");
    expect(itemText(check)).not.toContain("another origin");
  });

  test("a hostile icons array is read only up to its scan limit", () => {
    const icons = Array.from({ length: 50_000 }, (_, n) => ({
      src: `/i/${n}.png`,
      sizes: `${"9".repeat(500)}x1`,
    }));
    const content = JSON.stringify({
      ...VALID_MANIFEST,
      icons: [...VALID_MANIFEST.icons, ...icons],
    });
    const started = performance.now();
    run([manifestData({ content })]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a manifest throttled or answered by a WAF is not checked, not an error", () => {
    const waf = only(run([manifestData({ status: 403, content: null, wafBlocked: true })]));
    expect(waf.status).toBe("info");
    const busy = only(run([manifestData({ status: 429, content: null, rateLimited: true })]));
    expect(busy.status).toBe("info");
  });

  test("parseWebAppManifest accepts only a JSON object", () => {
    expect(parseWebAppManifest("[]")).toBeNull();
    expect(parseWebAppManifest("null")).toBeNull();
    expect(parseWebAppManifest(null)).toBeNull();
    expect(parseWebAppManifest('{"name":"x"}')).toEqual({ name: "x" });
  });
});
