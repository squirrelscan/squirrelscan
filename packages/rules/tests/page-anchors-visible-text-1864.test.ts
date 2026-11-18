// links/page-anchors' client-shell test measures the body's visible text as `body.textContent.length` less the text of
// every script, style, noscript and template in it. #1864 reads it from the text nodes' lengths instead, so the scripts'
// text is not materialised twice; the number must be the same, nested elements included.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { visibleTextLength } from "../src/links/page-anchors";
import { CASES } from "./security/leaked-secrets/cases";

const URL_ = "https://example.com/";

/** The measurement as it was written before #1864. */
function materialised(body: Element): number {
  let visible = (body.textContent ?? "").length;
  for (const el of body.querySelectorAll("script, style, noscript, template")) visible -= (el.textContent ?? "").length;
  return visible;
}

const EDGE = [
  `<html><body>a<noscript><style>x{}</style>b</noscript><template><p>t</p><script>s()</script></template>c</body></html>`,
  `<html><body><svg><style>.s{}</style><text>svg text</text></svg><![CDATA[cdata]]><!-- comment -->d</body></html>`,
  `<html><body><div><script>var a = "<p>not text</p>";</script><p>visible</p></div><textarea>typed</textarea></body></html>`,
  `<html><body></body></html>`,
  `<html><body><noscript><noscript><p>nested</p></noscript></noscript>e</body></html>`,
];

describe("visibleTextLength", () => {
  test("equals the materialised measurement on edge pages and every corpus page", () => {
    let pages = 0;
    for (const html of [...EDGE, ...CASES.map((c) => c.html)]) {
      const body = parsePage(html, URL_).document?.querySelector("body");
      if (!body) continue;
      pages++;
      expect(visibleTextLength(body)).toBe(materialised(body));
    }
    expect(pages).toBeGreaterThan(1000);
  });
});
