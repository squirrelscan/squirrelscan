import { describe, expect, test } from "bun:test";

import { extractScripts, MAX_SERVER_ONLY_SCRIPTS, mergeServerOnlyScripts } from "../src/extractors";
import { parseDocument } from "../src";

const BASE = "https://example.com/p";
const page = (head: string, body = "<h1>x</h1>") =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

describe("mergeServerOnlyScripts (#1769)", () => {
  test("adds an external and an inline script only the server HTML holds, marked", () => {
    const server = page('<script src="/a.js"></script><script>var k = 1;</script>');
    const out = mergeServerOnlyScripts(page(""), server, BASE);
    expect(out.added).toBe(2);
    const doc = parseDocument(out.html);
    expect(extractScripts(doc, BASE).map((s) => s.src)).toEqual(["https://example.com/a.js"]);
    expect(doc.querySelectorAll("head script[data-sq-server-only]").length).toBe(2);
  });

  test("dedupes by normalized src and by inline body", () => {
    const server = page('<script src="/a.js#x"></script><script>var k = 1;</script><script>var k = 1;</script>');
    const rendered = page('<script src="https://example.com/a.js"></script><script> var k = 1; </script>');
    const out = mergeServerOnlyScripts(rendered, server, BASE);
    expect(out.added).toBe(0);
    expect(out.html).toBe(rendered);
  });

  test("a server page repeating a script adds it once", () => {
    const out = mergeServerOnlyScripts(page(""), page('<script src="/a.js"></script><script src="/a.js"></script>'), BASE);
    expect(out.added).toBe(1);
  });

  test("skips noscript, data URLs and non-JS types", () => {
    const server = page(
      '<noscript><script src="/n.js"></script></noscript><script src="data:text/javascript,1"></script><script type="application/ld+json">{}</script>',
    );
    expect(mergeServerOnlyScripts(page(""), server, BASE).added).toBe(0);
  });

  test("keeps a body script in the body", () => {
    const out = mergeServerOnlyScripts(page(""), page("", '<script src="/b.js"></script>'), BASE);
    expect(parseDocument(out.html).querySelectorAll("body script[data-sq-server-only]").length).toBe(1);
  });

  test("the cap leaves scripts out and says so", () => {
    const many = Array.from({ length: MAX_SERVER_ONLY_SCRIPTS + 3 }, (_, i) => `<script src="/s${i}.js"></script>`).join("");
    const out = mergeServerOnlyScripts(page(""), page(many), BASE);
    expect(out.added).toBe(MAX_SERVER_ONLY_SCRIPTS);
    expect(out.omitted).toBe(3);
    expect(out.html).toContain('data-sq-server-scripts-omitted="3"');
  });

  test("no server HTML or no scripts leaves the rendered HTML untouched", () => {
    const rendered = page("");
    expect(mergeServerOnlyScripts(rendered, undefined, BASE).html).toBe(rendered);
    expect(mergeServerOnlyScripts(rendered, page(""), BASE).html).toBe(rendered);
  });
});
