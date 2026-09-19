import { describe, expect, test } from "bun:test";
import { extractPage, semanticAttributes, srcCategory, stripStyleResidue, structureSummary, text } from "./extract-dom.ts";
import { parseHTML } from "../../packages/parser/src/dom.ts";
import type { Element } from "linkedom";

const PAGE_URL = "https://example.test/guides/setup";

function first(html: string, selector: string): Element {
  const { document } = parseHTML(html);
  const element = document.querySelector(selector);
  if (!element) throw new Error(`synthetic fixture has no ${selector}`);
  return element as unknown as Element;
}

function candidate(html: string, locatorEnd: string) {
  const { candidates } = extractPage(html, PAGE_URL);
  const found = candidates.find((item) => String(item.locator).endsWith(locatorEnd));
  if (!found) throw new Error(`no candidate whose locator ends with ${locatorEnd}`);
  return found;
}

describe("stripStyleResidue", () => {
  test("drops a rule block together with its selector", () => {
    expect(stripStyleResidue(".menu__link{color:red;padding:0}Real prose").trim()).toBe("Real prose");
    expect(stripStyleResidue("#header .nav > li:first-child{display:none}Kept").trim()).toBe("Kept");
  });

  test("drops a nested at-rule, prelude included", () => {
    const residue = "@media (min-width:767px){.menu__submenu>.menu__item:before{content:''}}Visible copy";
    expect(stripStyleResidue(residue).replace(/\s+/g, " ").trim()).toBe("Visible copy");
  });

  test("drops an at-rule whose block was truncated mid-capture", () => {
    expect(stripStyleResidue("@import url(other.css); Body text").replace(/\s+/g, " ").trim()).toBe("Body text");
  });

  test("leaves prose that merely looks like a selector", () => {
    const prose = "Built with .NET and ranked #1 by readers; see the {braces} guide.";
    expect(stripStyleResidue(prose)).toBe(prose);
  });

  test("drops a rule truncated mid-declaration by a text cap", () => {
    const residue = "Add to cart #zoid-paypal-buttons-uid_768 { position: relative; display: inline-";
    expect(stripStyleResidue(residue).trim()).toBe("Add to cart");
  });

  test("keeps a JSON object shown as visible page content", () => {
    const sample = 'A CI job can branch on the cause: {"status":"failed","statusReasonCode":"dns"} and retry.';
    expect(stripStyleResidue(sample)).toBe(sample);
  });

  test("keeps prose in front of a rule and drops only the selector", () => {
    expect(stripStyleResidue("Read our guide .promo{color:red}").replace(/\s+/g, " ").trim()).toBe("Read our guide");
  });

  test("leaves ordinary prose untouched", () => {
    const prose = "A short paragraph about pricing, support and delivery.";
    expect(stripStyleResidue(prose)).toBe(prose);
  });
});

describe("text extraction", () => {
  test("excludes script, style, noscript, template and JSON-LD subtrees", () => {
    const html = `<body><section>
      <style>.a{color:#fff}</style>
      <script>var tracked = 1; window.dataLayer.push({});</script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget"}</script>
      <noscript>Enable JavaScript to continue</noscript>
      <template><p>Client side template</p></template>
      <p>Visible product copy</p>
    </section></body>`;
    const value = text(first(html, "section"));
    expect(value).toBe("Visible product copy");
    expect(value).not.toContain("schema.org");
    expect(value).not.toContain("dataLayer");
    expect(value).not.toContain("Enable JavaScript");
    expect(value).not.toContain("Client side template");
  });

  test("removes inline CSS a CMS wrote into an ordinary element", () => {
    const html = `<body><section><div>#wrap .promo{margin:0 auto;padding:12px}</div><p>Spring sale details</p></section></body>`;
    expect(text(first(html, "section"))).toBe("Spring sale details");
  });

  test("reports an element with no readable text as empty", () => {
    const html = `<body><figure><img src="https://cdn.example.test/a.png" alt=""></figure></body>`;
    expect(text(first(html, "figure"))).toBe("");
  });
});

describe("semantic attributes for elements without text", () => {
  test("collects the readable attributes and skips blank ones", () => {
    const html = `<body><input type="email" name="subscriber" placeholder="Your email" aria-label="Email address" title="" role="textbox"></body>`;
    expect(semanticAttributes(first(html, "input"))).toEqual({
      "aria-label": "Email address",
      name: "subscriber",
      placeholder: "Your email",
      role: "textbox",
      type: "email",
    });
  });

  test("names a known embed provider without emitting the host or the URL", () => {
    const html = `<body><iframe src="https://www.youtube-nocookie.com/embed/abc123?token=secret&t=90"></iframe></body>`;
    const category = srcCategory(first(html, "iframe"), PAGE_URL);
    expect(category).toBe("youtube");
    expect(category).not.toContain("youtube-nocookie.com");
    expect(category).not.toContain("abc123");
    expect(category).not.toContain("secret");
  });

  test("never reveals a first-party host: a relative or same-site src is a category", () => {
    const html = `<body><img src="/assets/logo.png"><img id="cdn" src="https://cdn.example.test/a.png"></body>`;
    expect(srcCategory(first(html, "img"), PAGE_URL)).toBe("same-site");
    // A subdomain of the page's registrable domain is still the site itself.
    expect(srcCategory(first(html, "#cdn"), PAGE_URL)).toBe("same-site");
  });

  test("falls back to other-third-party for an unknown host, and null for a data URI", () => {
    const html = `<body><iframe src="https://widgets.somevendor.test/w/42"></iframe><img id="inline" src="data:image/gif;base64,R0lGOD"></body>`;
    const category = srcCategory(first(html, "iframe"), PAGE_URL);
    expect(category).toBe("other-third-party");
    expect(category).not.toContain("somevendor");
    expect(srcCategory(first(html, "#inline"), PAGE_URL)).toBeNull();
  });

  test("every category is a fixed token, never a hostname", () => {
    const hosts = [
      "https://maps.google.com/maps?q=1", "https://js.stripe.com/v3/",
      "https://player.vimeo.com/video/1", "https://www.google.com/recaptcha/api.js",
      "https://tracker.unknown-vendor.test/p.gif", "/local.png",
    ];
    for (const src of hosts) {
      const category = srcCategory(first(`<body><iframe src="${src}"></iframe></body>`, "iframe"), PAGE_URL);
      expect(category).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(category).not.toContain(".");
    }
  });
});

describe("link scheme categories", () => {
  function categories(hrefs: string[]) {
    const anchors = hrefs.map((href) => `<a href="${href}">x</a>`).join("");
    const html = `<body><main><div>${anchors}</div></main></body>`;
    return candidate(html, "div[0]").linkCategories as Record<string, number>;
  }

  test("treats every non-navigable scheme as unsafe, not just javascript and data", () => {
    // vbscript: is what the denylist missed; the allowlist covers it and any
    // scheme added later without this test needing to know the name.
    expect(categories(["vbscript:msgbox(1)"])).toEqual({ unsafe: 1 });
    expect(categories(["javascript:alert(1)"])).toEqual({ unsafe: 1 });
    expect(categories(["data:text/html,<script>x</script>"])).toEqual({ unsafe: 1 });
    expect(categories(["file:///etc/passwd"])).toEqual({ unsafe: 1 });
    expect(categories(["blob:https://example.test/abc"])).toEqual({ unsafe: 1 });
  });

  test("ignores case and embedded whitespace the way a browser does", () => {
    // A browser strips these before reading the scheme, so "java\tscript:" runs.
    expect(categories(["JaVaScRiPt:alert(1)"])).toEqual({ unsafe: 1 });
    expect(categories(["  vbscript:msgbox(1)"])).toEqual({ unsafe: 1 });
    expect(categories(["java\tscript:alert(1)"])).toEqual({ unsafe: 1 });
    expect(categories(["java\nscript:alert(1)"])).toEqual({ unsafe: 1 });
  });

  test("keeps the ordinary categories intact", () => {
    expect(categories(["https://example.test/guides/other"])).toEqual({ same_site: 1 });
    expect(categories(["https://other.test/x"])).toEqual({ external: 1 });
    expect(categories(["/relative"])).toEqual({ relative: 1 });
    expect(categories(["#section"])).toEqual({ anchor: 1 });
    expect(categories(["mailto:a@b.test"])).toEqual({ mailto: 1 });
    expect(categories(["tel:+15550134"])).toEqual({ tel: 1 });
  });
});

describe("structure summary", () => {
  test("orders by count, drops the element's own tag and caps the list", () => {
    expect(structureSummary({ div: 4, a: 3, img: 1, span: 2 }, "div")).toBe("a*3,span*2,img");
  });

  test("is empty for an element with no descendants", () => {
    expect(structureSummary({ section: 1 }, "section")).toBe("");
  });
});

describe("extractPage output", () => {
  test("an empty figure still carries its media evidence", () => {
    const html = `<body><main><figure>
      <iframe src="https://player.vimeo.com/video/xyz" title="Install walkthrough" aria-label="Video player"></iframe>
    </figure></main></body>`;
    const figure = candidate(html, "figure[0]");
    expect(figure.emptyText).toBe(true);
    expect(figure.text).toBe("");
    expect(figure.structureSummary).toBe("iframe");
    expect(figure.mediaDescendants).toEqual([
      {
        tag: "iframe",
        attributes: { "aria-label": "Video player", title: "Install walkthrough" },
        srcCategory: "vimeo",
      },
    ]);
  });

  test("no candidate field carries a hostname from a src", () => {
    const html = `<body><main><figure><img src="https://cdn.private-site.test/hero.png" alt="Hero"></figure></main></body>`;
    const serialized = JSON.stringify(extractPage(html, PAGE_URL).candidates);
    expect(serialized).not.toContain("private-site");
    expect(serialized).toContain("other-third-party");
  });

  test("keeps every pre-existing field so consumers stay backward compatible", () => {
    const html = `<body><main><section class="promo" id="lead"><h2>Setup</h2><p>${"Enough visible prose to pass the candidate threshold. ".repeat(3)}</p><a href="/docs">Docs</a></section></main></body>`;
    const section = candidate(html, "section[0]");
    for (const field of [
      "tag", "roles", "context", "ancestorTags", "siblingPosition", "siblingCount",
      "childCount", "childTags", "subtreeTagCounts", "linkCategories", "text",
      "contextText", "locator", "semanticAncestorChain", "classTokens", "idTokens",
      "textWordCount", "linkCount", "repeatedSiblingPatternCount", "weakSignals",
    ]) {
      expect(section).toHaveProperty(field);
    }
    expect(section.tag).toBe("section");
    expect(section.classTokens).toContain("promo");
    expect(section.emptyText).toBe(false);
    expect(String(section.text)).toContain("Enough visible prose");
  });

  test("a container holding only a stylesheet is not promoted on CSS length alone", () => {
    const html = `<body><main><div><style>.a{color:#fff;padding:4px}.b{margin:0;border:1px solid #000}</style><span></span><span></span></div></main></body>`;
    const { candidates } = extractPage(html, PAGE_URL);
    const div = candidates.find((item) => String(item.locator).endsWith("div[0]"));
    expect(div?.text).toBe("");
    expect(div?.emptyText).toBe(true);
  });

  test("a page's clean text signal excludes stylesheet bytes", () => {
    const styled = `<body><main><style>${".x{color:red}".repeat(40)}</style><p>Short visible line</p></main></body>`;
    const plain = `<body><main><p>Short visible line</p></main></body>`;
    expect(extractPage(styled, PAGE_URL).pageSignals.cleanTextLength).toBe(
      extractPage(plain, PAGE_URL).pageSignals.cleanTextLength,
    );
  });
});
