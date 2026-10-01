// A browser with scripting enabled parses <noscript> content as raw text, so
// the images, scripts and stylesheets in it never load (#434). The resource
// extractors that feed the image, script and stylesheet rules (and the
// same-domain resource fetches behind the file-size rules) skip them. Anchors
// are a crawl question, not a rendering one, so link extraction keeps them.

import { describe, expect, test } from "bun:test";

import { extractImages as extractParsedImages, parsePage } from "../src/html";
import { parseHTML } from "../src/dom";
import { extractImages } from "../src/extractors/images";
import { extractScripts } from "../src/extractors/scripts";
import { extractStylesheets } from "../src/extractors/stylesheets";

const URL = "https://example.com/";

const HTML = `<!DOCTYPE html><html><head><title>t</title>
<link rel="stylesheet" href="/live.css">
<noscript><link rel="stylesheet" href="/fallback.css"></noscript>
<script src="/live.js"></script>
</head><body>
<img src="/live.jpg" alt="Live">
<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=1&amp;ev=PageView&amp;noscript=1"></noscript>
<noscript><div><picture><source srcset="/fallback.webp"><img src="/fallback.jpg"></picture></div></noscript>
<noscript><script src="https://example.net/tracker.js"></script></noscript>
<noscript><a href="/no-js">No-JS version</a></noscript>
</body></html>`;

describe("resource extractors skip <noscript> content (#434)", () => {
  const { document } = parseHTML(HTML);

  test("parsePage images (the crawl-time ParsedPage)", () => {
    expect(parsePage(HTML, URL).images.map((i) => i.src)).toEqual(["https://example.com/live.jpg"]);
    expect(extractParsedImages(document, URL).map((i) => i.src)).toEqual([
      "https://example.com/live.jpg",
    ]);
  });

  test("extractors/images (the rule-input ParsedPage), including picture sources", () => {
    expect(extractImages(document, URL).map((i) => i.src)).toEqual(["https://example.com/live.jpg"]);
  });

  test("extractScripts", () => {
    expect(extractScripts(document, URL).map((s) => s.src)).toEqual(["https://example.com/live.js"]);
  });

  test("extractStylesheets", () => {
    expect(extractStylesheets(document, URL).map((s) => s.href)).toEqual([
      "https://example.com/live.css",
    ]);
  });

  test("links inside <noscript> are still extracted", () => {
    expect(parsePage(HTML, URL).links.map((l) => l.url)).toContain("https://example.com/no-js");
  });
});
