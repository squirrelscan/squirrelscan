// shared/serialized-prefix (#1864): the first characters of `innerHTML`, built
// without serialising the rest, must be exactly the first characters of
// `innerHTML`. a11y/skip-link's early-heading test reads them.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { skipLinkRule } from "../src/a11y/skip-link";
import { serializeChildren, serializedPrefix } from "../src/shared/serialized-prefix";
import type { ParsedPage, RuleContext } from "../src/types";
import { CASES } from "./security/leaked-secrets/cases";

const URL_ = "https://example.com/";

const EDGE_PAGES: string[] = [
  `<!doctype html><html><body></body></html>`,
  `<!doctype html><html><body>just text &amp; an entity &lt;tag&gt;</body></html>`,
  `<!doctype html><html><body><div id="" class="" style="">empty id, class and style</div><p id="x" class="a b" data-q='a"b'>q</p></body></html>`,
  `<!doctype html><html><body><img src="a.png" alt=""><br><input type="text" disabled><hr/><p>after voids</p></body></html>`,
  `<!doctype html><html><body><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/><g><circle r="1"/></g></svg><svg width="1"></svg><h1>after svg</h1></body></html>`,
  `<!doctype html><html><body><!-- a comment --><div><!-- nested --><span>x</span></div><h2>h</h2></body></html>`,
  `<!doctype html><html><body><template><div>tpl</div><script>tpl()</script></template><h1>after template</h1></body></html>`,
  `<!doctype html><html><body><textarea name="t">a < b &amp; c</textarea><title>in body</title><style>.a>.b{x:1}</style><h1>t</h1></body></html>`,
  `<!doctype html><html><body><div><div><script>if(a<b&&c>d){"</div>"}</script></div><h1>deep</h1></div><script>${"x".repeat(5000)}</script></body></html>`,
  `<!doctype html><html><body><noscript><img src="p.gif"></noscript><main><h1>Main</h1></main><math><mi>x</mi></math></body></html>`,
  `<!doctype html><html><body><custom-el foo="bar"><slot-x>s</slot-x></custom-el><table><tr><td>c</td></tr></table><select><option selected>o</option></select></body></html>`,
];

const LENGTHS = [0, 1, 7, 64, 500, 2000, 2050, 10_000, Number.MAX_SAFE_INTEGER];

function bodyOf(html: string): Element | null {
  return parsePage(html, URL_).document?.querySelector("body") ?? null;
}

describe("serializedPrefix", () => {
  test("matches innerHTML on hand-written edge pages, at every length", () => {
    for (const html of EDGE_PAGES) {
      const body = bodyOf(html);
      expect(body).not.toBeNull();
      const full = body!.innerHTML;
      for (const n of LENGTHS) expect(serializedPrefix(body!, n).slice(0, n)).toBe(full.slice(0, n));
    }
  });

  test("matches innerHTML on every page of the leaked-secrets corpus", () => {
    let pages = 0;
    for (const c of CASES) {
      const body = bodyOf(c.html);
      if (!body) continue;
      pages++;
      const full = body.innerHTML;
      for (const n of [0, 100, 2000, Number.MAX_SAFE_INTEGER]) {
        expect(serializedPrefix(body, n).slice(0, n)).toBe(full.slice(0, n));
      }
    }
    expect(pages).toBeGreaterThan(1000);
  });

  test("stops early: a megabyte of trailing script is not serialised", () => {
    const html = `<!doctype html><html><body><h1>Top</h1><script>${"var a=1;".repeat(150_000)}</script></body></html>`;
    const body = bodyOf(html)!;
    const prefix = serializedPrefix(body, 10);
    expect(prefix.length).toBeLessThan(200);
    expect(prefix).toBe(body.innerHTML.slice(0, prefix.length));
  });
});

describe("a11y/skip-link early heading, read from the prefix", () => {
  const run = (html: string) => {
    const ctx: RuleContext = {
      page: { url: URL_, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, URL_) as ParsedPage,
      options: {},
    };
    return skipLinkRule.run(ctx) as { checks: Array<{ status: string; details?: Record<string, unknown> }> };
  };

  test("a heading behind a large inline script in the first 2000 characters still counts", () => {
    const html = `<!doctype html><html><body><main><script>${"x".repeat(1500)}</script><h1>Title</h1></main><script>${"y".repeat(500_000)}</script></body></html>`;
    const [check] = run(html).checks;
    expect(check?.status).toBe("pass");
    expect(check?.details?.methods).toContain("early heading");
  });

  test("a heading past 2000 characters does not", () => {
    const html = `<!doctype html><html><body><main><script>${"x".repeat(2500)}</script><h1>Title</h1></main></body></html>`;
    const [check] = run(html).checks;
    expect(check?.details?.methods ?? check?.details?.found).not.toContain("early heading");
  });
});

describe("serializeChildren", () => {
  test("a document serialises exactly as doc.toString(), on every corpus and edge page", () => {
    let pages = 0;
    for (const html of [...EDGE_PAGES, ...CASES.map((c) => c.html)]) {
      const doc = parsePage(html, URL_).document;
      if (!doc) continue;
      pages++;
      expect(serializeChildren(doc)).toBe(doc.toString());
      // Taking apart every element that holds a script, each script's text put back as it is, changes nothing either.
      const scripts = new Map(Array.from(doc.querySelectorAll("script")).map((s) => [s, s.textContent ?? ""] as const));
      expect(serializeChildren(doc, { replaceText: scripts })).toBe(doc.toString());
    }
    expect(pages).toBeGreaterThan(1000);
  });

  test("replaceText swaps only the text of the elements it names, exactly where the element puts its text", () => {
    const html = `<!doctype html><html><head><script type="a" data-x="q">var a=1;</script><style>.x{}</style></head><body><script>var b=2;</script><p>t</p></body></html>`;
    const doc = parsePage(html, URL_).document!;
    const scripts = Array.from(doc.querySelectorAll("script"));
    const out = serializeChildren(doc, { replaceText: new Map([[scripts[1]!, "XX"]]) });
    expect(out).toBe(doc.toString().replace("var b=2;", "XX"));
  });
});
