// #1435: an inline loader the browser runs is read whatever deferral wrapper a cache or CDN puts on it
// (litespeed/javascript, Cloudflare Rocket Loader), and inside a Next.js App Router flight script over 16 KB;
// data blocks, a CSP meta, prose and whole inlined bundles stay excluded (#1430).

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { pageMarkup } from "../src/detect";

const SNIPPET =
  '(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;' +
  't.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","abc123");';

const page = (head: string, body = "<p>Hello</p>") =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const BODIES = [{ url: "https://example.com/assets/app.js", content: "var a=1;" }];
const ids = (html: string, scripts: Array<{ url: string; content?: string }> | undefined = BODIES): string[] =>
  detectTechnologies({ url: "https://example.com/", headers: {}, html, ...(scripts ? { scripts } : {}) }).map((t) => t.id);
const both = (html: string): string[][] => [ids(html), ids(html, undefined)];

describe("a loader wrapped by a cache or CDN is still read", () => {
  test("LiteSpeed Cache: type=litespeed/javascript", () => {
    for (const found of both(page(`<script type="litespeed/javascript">${SNIPPET}</script>`))) expect(found).toContain("clarity");
  });

  test("Cloudflare Rocket Loader: type=<hash>-text/javascript", () => {
    const html = page(`<script type="0123456789abcdef01234567-text/javascript">${SNIPPET}</script>`);
    for (const found of both(html)) expect(found).toContain("clarity");
  });

  test("other executable wrappers: Partytown and a consent tool's text/plain", () => {
    for (const type of ["text/partytown", "text/plain", "text/javascript", "module", "application/javascript; charset=utf-8"]) {
      expect(ids(page(`<script type="${type}">${SNIPPET}</script>`))).toContain("clarity");
    }
  });
});

describe("a Next.js App Router flight script over 16 KB", () => {
  const layout = `self.__next_f.push([1,${JSON.stringify(`5:["$","$L6",null,{"children":${JSON.stringify(SNIPPET)}}]`)}])`;
  const big = `${layout};${"/* flight padding */ ".repeat(2_000)}`;

  test("the layout's inline loader snippet is found", () => {
    expect(big.length).toBeGreaterThan(16 * 1024);
    for (const found of both(page(`<script>${big}</script>`))) expect(found).toContain("clarity");
  });

  test("an untyped script over 16 KB that is not a flight payload is a bundle and is not read", () => {
    const bundle = `var s=${JSON.stringify(SNIPPET)};${"x=1;".repeat(8_000)}`;
    expect(bundle.length).toBeGreaterThan(16 * 1024);
    for (const found of both(page(`<script>${bundle}</script>`))) expect(found).not.toContain("clarity");
  });
});

describe("still not read", () => {
  test("a CSP meta, prose, a link, JSON-LD, __NEXT_DATA__ and __nuxt_data__", () => {
    const html = page(
      '<meta http-equiv="Content-Security-Policy" content="script-src https://www.clarity.ms">' +
        `<script type="application/ld+json">{"sameAs":["https://www.clarity.ms/"]}</script>` +
        `<script id="__NEXT_DATA__" type="application/json">{"u":"https://www.clarity.ms/tag/x"}</script>` +
        `<script id="__nuxt_data__" type="application/json" data-ssr="true">["https://www.clarity.ms/tag/x"]</script>` +
        `<script type="importmap">{"imports":{"c":"https://www.clarity.ms/c.js"}}</script>` +
        `<script type="text/template"><a href="https://www.clarity.ms/">x</a></script>`,
      '<p>We use clarity.ms for analytics.</p><a href="https://www.clarity.ms/">Clarity</a>',
    );
    for (const found of both(html)) expect(found).not.toContain("clarity");
  });

  test("a data type with a wrapper-like prefix is still data", () => {
    expect(ids(page(`<script type="0123456789abcdef01234567-application/json">{"u":"https://www.clarity.ms/x"}</script>`))).not.toContain("clarity");
  });
});

describe("cost", () => {
  test("a 5 MB tag-heavy page with many scripts stays fast and bounded", () => {
    const html = page("", `${'<div class="a" data-x="1"><img src="/i.png" alt="x"><a href="/y">y</a><script>var z=1;</script></div>'.repeat(40_000)}`);
    expect(html.length).toBeGreaterThan(3_000_000);
    const started = performance.now();
    const markup = pageMarkup(html);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(markup.length).toBeLessThan(html.length);
  });

  test("inline script text is capped per page", () => {
    const flight = `self.__next_f.push([1,"${"a".repeat(1_900_000)}"])`;
    const html = page(Array.from({ length: 8 }, () => `<script>${flight}</script>`).join("") + `<script>${SNIPPET}</script>`);
    const markup = pageMarkup(html);
    expect(markup.length).toBeLessThan(9 * 1024 * 1024);
  });
});
