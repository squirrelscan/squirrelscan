// content/unrendered-markup: markdown and escaped HTML a reader can actually see.
//
// The rule accuses a page of a rendering bug, so the false-positive fixtures
// carry more weight here than the detection ones. Three classes matter: a
// documentation page that displays markdown source on purpose, prose full of
// snake_case identifiers and file paths, and arithmetic written with asterisks.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import {
  findUnrenderedMarkup,
  isCodeLikeElement,
  unrenderedMarkupRule,
} from "../src/content/unrendered-markup";
import type { ParsedPage, RuleContext } from "../src/types";

function run(html: string) {
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: {},
  };
  return unrenderedMarkupRule.run(ctx).checks;
}

const page = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;

const kinds = (text: string) => findUnrenderedMarkup(text).map((f) => f.kind);

describe("findUnrenderedMarkup: literal markdown", () => {
  test("asterisk emphasis, bold and italic", () => {
    expect(kinds("We are **the best** at this")).toContain("markdown-emphasis");
    expect(kinds("This is *important* to know")).toContain("markdown-emphasis");
  });

  test("underscore emphasis when the run is a phrase", () => {
    expect(kinds("Read the __getting started__ guide")).toContain("markdown-emphasis");
    expect(kinds("A _short phrase_ here")).toContain("markdown-emphasis");
  });

  test("link and image syntax", () => {
    expect(kinds("See [our docs](https://docs.example.com/start) for more")).toContain(
      "markdown-link",
    );
    expect(kinds("Go [home](/) now")).toContain("markdown-link");
    expect(kinds("Jump to [the top](#top)")).toContain("markdown-link");
    expect(kinds("![a squirrel](/img/mascot.png)")).toContain("markdown-link");
  });

  test("a leading heading marker in a text node", () => {
    expect(kinds("## Pricing\nOur plans start at ten dollars.")).toContain("markdown-heading");
    expect(kinds("### Frequently asked questions")).toContain("markdown-heading");
    expect(kinds("# Welcome to the site")).toContain("markdown-heading");
  });

  test("an unrendered code fence", () => {
    expect(kinds("```js\nconst a = 1\n```")).toContain("markdown-code-fence");
    expect(kinds("~~~\nplain\n~~~")).toContain("markdown-code-fence");
  });

  test("an inline code span", () => {
    expect(kinds("Run `squirrel audit` to start")).toContain("markdown-inline-code");
  });

  test("counts every occurrence, not just the first", () => {
    const found = findUnrenderedMarkup("**one** and **two** and **three**");
    expect(found.find((f) => f.kind === "markdown-emphasis")?.count).toBe(3);
  });
});

describe("findUnrenderedMarkup: escaped HTML and entities", () => {
  // The page source said `&lt;p&gt;`; textContent hands the rule a literal `<p>`.
  test("visible structural tags", () => {
    expect(kinds("<p>Welcome to the store</p>")).toContain("escaped-html-tag");
    expect(kinds('<div class="row">Contents</div>')).toContain("escaped-html-tag");
    expect(kinds('Read <a href="/terms">the terms</a> first')).toContain("escaped-html-tag");
  });

  test("a closing ambiguous tag counts, a bare opening one does not", () => {
    expect(kinds("end of the quote</a> follows")).toContain("escaped-html-tag");
    // `x<b>y` is a comparison chain in mathematical prose, not leaked markup.
    expect(kinds("when x<b>y the value grows")).not.toContain("escaped-html-tag");
  });

  test("double-encoded named and numeric entities", () => {
    expect(kinds("Ten&nbsp;dollars")).toContain("double-encoded-entity");
    expect(kinds("Fish &amp; chips")).toContain("double-encoded-entity");
    expect(kinds("He said &quot;yes&quot;")).toContain("double-encoded-entity");
    expect(kinds("Caf&#233; open now")).toContain("double-encoded-entity");
  });

  test("a capitalised component name is not a leaked tag", () => {
    // astro.build renders exactly this row in its hero. Escaped markup that
    // really leaked came from HTML a server emitted, and that is lowercase.
    expect(kinds("<Logo><NavLinks><Hero><Article><Video>")).not.toContain("escaped-html-tag");
    expect(kinds("Compose <Header> and <Footer> in your layout")).not.toContain("escaped-html-tag");
  });

  test("bare element names are documentation, not a leak", () => {
    // MDN's reference for the pre element, outside any code span: a breadcrumb
    // and a see-also list. No closing form, no attribute with a value.
    expect(kinds("Elements <pre>\nThe <pre> element\n<meta name> and <meta http-equiv>")).not.toContain(
      "escaped-html-tag",
    );
    expect(kinds("Compose <header>, <main> and <footer> in the layout")).not.toContain(
      "escaped-html-tag",
    );
  });

  test("one leaked tag vouches for the bare ones beside it", () => {
    const found = findUnrenderedMarkup("<p>Line one</p><br><br>");
    expect(found.find((f) => f.kind === "escaped-html-tag")?.count).toBe(4);
  });

  test("a company name with an ampersand is not an entity", () => {
    // The generic `&[a-z]+;` shape reads this as a named entity. A curated list
    // does not, which is the point of having one.
    expect(kinds("Johnson&Johnson; a long history")).not.toContain("double-encoded-entity");
    expect(kinds("AT&T; the carrier")).not.toContain("double-encoded-entity");
  });
});

describe("findUnrenderedMarkup: identifiers and arithmetic stay clean", () => {
  test("snake_case identifiers are not emphasis", () => {
    expect(findUnrenderedMarkup("Set CLOUDFLARE_API_TOKEN in the environment")).toEqual([]);
    expect(findUnrenderedMarkup("Edit some_file_name.ts to continue")).toEqual([]);
    expect(findUnrenderedMarkup("The max_pages option caps the crawl")).toEqual([]);
    expect(findUnrenderedMarkup("Both user_id and org_id are required")).toEqual([]);
  });

  test("Python dunders are not emphasis", () => {
    // Flanked exactly like bold, and common in prose outside a code span. This
    // is why the underscore form insists on a space inside the run.
    expect(findUnrenderedMarkup("Define __init__ on the class")).toEqual([]);
    expect(findUnrenderedMarkup("The __main__ guard runs it")).toEqual([]);
  });

  test("arithmetic and footnote asterisks are not emphasis", () => {
    expect(findUnrenderedMarkup("Area is width * height * depth")).toEqual([]);
    expect(findUnrenderedMarkup("Compute 2 * 3 * 4 first")).toEqual([]);
    expect(findUnrenderedMarkup("Prices exclude tax*")).toEqual([]);
  });

  test("bracketed prose without a URL target is not a link", () => {
    expect(findUnrenderedMarkup("The array[i](arg) call returns early")).toEqual([]);
    expect(findUnrenderedMarkup("See [note] (below) for detail")).toEqual([]);
    expect(findUnrenderedMarkup("Apply f[x](y) to the input")).toEqual([]);
  });

  test("hash-prefixed prose is not a heading", () => {
    expect(findUnrenderedMarkup("#1 in customer satisfaction")).toEqual([]);
    expect(findUnrenderedMarkup("Order #4821 has shipped")).toEqual([]);
  });

  test("ordinary marketing copy is clean", () => {
    expect(
      findUnrenderedMarkup(
        "We build tools for developers. Our pricing is simple: ten dollars a month, " +
          "cancel any time. Read about the team, or get in touch — we reply within a day.",
      ),
    ).toEqual([]);
  });
});

describe("isCodeLikeElement", () => {
  const el = (html: string) => parseHTML(`<body>${html}</body>`).document.querySelector("body")!
    .firstElementChild!;

  test("the code-like tags", () => {
    for (const tag of ["code", "pre", "samp", "kbd", "textarea", "script", "style", "noscript"]) {
      expect(isCodeLikeElement(el(`<${tag}>x</${tag}>`))).toBe(true);
    }
  });

  test("syntax-highlighter containers, by whole class token", () => {
    expect(isCodeLikeElement(el('<div class="highlight">x</div>'))).toBe(true);
    expect(isCodeLikeElement(el('<div class="wrap hljs dark">x</div>'))).toBe(true);
    expect(isCodeLikeElement(el('<div class="language-ts">x</div>'))).toBe(true);
    expect(isCodeLikeElement(el('<div data-language="bash">x</div>'))).toBe(true);
    // Case-insensitive attribute read, matching every other rule in the package.
    expect(isCodeLikeElement(el('<div CLASS="shiki">x</div>'))).toBe(true);
  });

  test("a callout that merely contains the word is prose", () => {
    expect(isCodeLikeElement(el('<div class="highlight-box">x</div>'))).toBe(false);
    expect(isCodeLikeElement(el('<div class="codeblocks-intro">x</div>'))).toBe(false);
    expect(isCodeLikeElement(el("<p>x</p>"))).toBe(false);
  });
});

describe("unrenderedMarkupRule", () => {
  test("pass on a clean page", () => {
    const checks = run(page("<h1>Welcome</h1><p>We sell excellent coffee beans.</p>"));
    expect(checks[0]?.status).toBe("pass");
  });

  test("warn on one or two stray markdown occurrences", () => {
    const checks = run(page("<p>We are **the best** at coffee.</p>"));
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.value).toBe(1);
  });

  test("fail once markdown is systemic", () => {
    const checks = run(
      page("<p>**one** and **two** and **three** and [docs](https://example.com/d)</p>"),
    );
    expect(checks[0]?.status).toBe("fail");
  });

  test("fail on visible escaped HTML even once", () => {
    // Source: `&lt;p&gt;Welcome&lt;/p&gt;` — nothing renders that on purpose.
    const checks = run(page("<p>&lt;p&gt;Welcome&lt;/p&gt;</p>"));
    expect(checks[0]?.status).toBe("fail");
    const kindList = (checks[0]?.details as { kinds: { kind: string }[] }).kinds.map((k) => k.kind);
    expect(kindList).toContain("escaped-html-tag");
  });

  test("fail on a visible double-encoded entity", () => {
    const checks = run(page("<p>Ten&amp;nbsp;dollars a month</p>"));
    expect(checks[0]?.status).toBe("fail");
  });

  test("visible backticks alone do not accuse the page", () => {
    // Vercel's docs landing page carries a copyable agent prompt written in
    // markdown. Six visible code spans, nothing else, nothing broken.
    const prompt =
      "<p>Install the CLI globally (`npm i -g vercel`) and log in with `vercel login`. " +
      "Then run `vercel link`, `vercel env pull` and `vercel deploy`.</p>";
    expect(run(page(prompt))[0]?.status).toBe("pass");
  });

  test("backticks corroborate once something real fires", () => {
    const checks = run(page("<p>## Setup</p><p>Run `vercel deploy` to ship</p>"));
    expect(checks[0]?.status).not.toBe("pass");
    const kindList = (checks[0]?.details as { kinds: { kind: string }[] }).kinds.map((k) => k.kind);
    expect(kindList).toContain("markdown-inline-code");
    expect(kindList).toContain("markdown-heading");
  });

  test("a bare escaped div with its closing tag counts", () => {
    // The issue names `&lt;div&gt;` explicitly. It carries a closing form here,
    // which is what separates a leak from a page documenting the element.
    expect(run(page("<p>&lt;div&gt;Contents&lt;/div&gt;</p>"))[0]?.status).toBe("fail");
  });

  test("skipped when the document is missing", () => {
    const ctx: RuleContext = {
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document: null } as unknown as ParsedPage,
      options: {},
    };
    const checks = unrenderedMarkupRule.run(ctx).checks;
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBe("Parse error");
  });

  test("skipped when there is no body", () => {
    const { document } = parseHTML("<html><head><title>t</title></head></html>");
    document.querySelector("body")?.remove();
    const ctx: RuleContext = {
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document } as unknown as ParsedPage,
      options: {},
    };
    const checks = unrenderedMarkupRule.run(ctx).checks;
    expect(checks[0]?.status).toBe("skipped");
    expect(checks[0]?.skipReason).toBe("no-body");
  });

  test("the message names a real example, flattened to one line", () => {
    const checks = run(page("<p>Read [our docs](https://docs.example.com/start) today</p>"));
    expect(checks[0]?.message).toContain("[our docs](https://docs.example.com/start)");
    expect(checks[0]?.message).not.toContain("\n");
  });
});

describe("unrenderedMarkupRule: the documentation page that displays markdown", () => {
  // The load-bearing fixture. A docs page teaching markdown shows every pattern
  // this rule detects, on purpose, inside code markup. It must stay clean.
  const docsPage = page(`
    <h1>Writing with markdown</h1>
    <p>Wrap a phrase in asterisks to emphasise it:</p>
    <pre><code class="language-md">**bold text** and *italic text*
## A heading
[a link](https://example.com/page)
\`\`\`js
const a = 1;
\`\`\`
</code></pre>
    <p>Inline, write <code>\`squirrel audit\`</code> to show a command.</p>
    <p>Escaped HTML is written as <code>&amp;lt;p&amp;gt;</code> and renders as
      <code>&lt;p&gt;text&lt;/p&gt;</code>.</p>
    <div class="highlight"><pre><span>&lt;div class="row"&gt;</span></pre></div>
    <div data-language="html"><span>&lt;a href="/x"&gt;link&lt;/a&gt;</span></div>
    <textarea>## Draft post

Some **bold** copy the author is still editing.</textarea>
  `);

  test("stays clean", () => {
    const checks = run(docsPage);
    expect(checks[0]?.status).toBe("pass");
  });

  test("the same page fails once one line escapes its code block", () => {
    // Same document, one paragraph moved out of <code>: the exclusion is doing
    // the work, not the patterns.
    const leaked = docsPage.replace(
      "<p>Wrap a phrase in asterisks to emphasise it:</p>",
      "<p>Wrap a phrase in **asterisks** to [emphasise](https://example.com/e) it</p>",
    );
    expect(run(leaked)[0]?.status).toBe("warn");
  });

  // "Stays clean" is only evidence if the SAME markup, outside the container,
  // is a real detection. Each row carries both spellings.
  const containers: [string, string, string][] = [
    [
      "pre + code",
      '<pre><code class="language-md">**bold** and *italic*\n## Heading\n[a](https://e.com/p)</code></pre>',
      "<p>**bold** and *italic*</p><p>## Heading</p><p>[a](https://e.com/p)</p>",
    ],
    [
      "escaped html in code",
      "<p><code>&lt;p&gt;text&lt;/p&gt;</code></p>",
      "<p>&lt;p&gt;text&lt;/p&gt;</p>",
    ],
    [
      "rouge highlight wrapper",
      '<div class="highlight"><span>&lt;div class="row"&gt;here&lt;/div&gt;</span></div>',
      '<div><span>&lt;div class="row"&gt;here&lt;/div&gt;</span></div>',
    ],
    [
      "data-language wrapper",
      '<div data-language="html"><span>&lt;a href="/x"&gt;l&lt;/a&gt;</span></div>',
      '<div><span>&lt;a href="/x"&gt;l&lt;/a&gt;</span></div>',
    ],
    [
      "textarea draft",
      "<textarea>## Draft\n\nSome **bold** copy.</textarea>",
      "<p>## Draft</p><p>Some **bold** copy.</p>",
    ],
    [
      "commonmark-style preformatted cell",
      '<table><tr><td class="preformatted">[Link](http://a.com)</td><td class="preformatted">*Italic*</td></tr></table>',
      "<table><tr><td>[Link](http://a.com)</td><td>*Italic*</td></tr></table>",
    ],
  ];

  test.each(containers)("%s is silent, and the same markup outside it is not", (_, inside, outside) => {
    expect(run(page(inside))[0]?.status).toBe("pass");
    expect(run(page(outside))[0]?.status).not.toBe("pass");
  });

  test("a skipped subtree does not glue its neighbours into a match", () => {
    // Without a boundary between excluded subtrees, `**` + `**` reads back as
    // bold text that exists in neither fragment.
    const checks = run(page("<p>**<code>x</code>**</p>"));
    expect(checks[0]?.status).toBe("pass");
  });
});

describe("unrenderedMarkupRule: adversarial input stays linear", () => {
  const budgetMs = 2000;

  const timed = (text: string) => {
    const started = performance.now();
    findUnrenderedMarkup(text);
    return performance.now() - started;
  };

  test("a long run of underscores and spaces", () => {
    // The shape that would re-partition itself if the space test lived in the
    // pattern instead of in JS.
    expect(timed(`_${"a b ".repeat(16_000)}`)).toBeLessThan(budgetMs);
  });

  test("a long run of asterisks", () => {
    expect(timed("*".repeat(64_000))).toBeLessThan(budgetMs);
    expect(timed(`*${"a ".repeat(32_000)}`)).toBeLessThan(budgetMs);
  });

  test("a long unterminated tag and bracket run", () => {
    expect(timed(`<div ${"x".repeat(64_000)}`)).toBeLessThan(budgetMs);
    expect(timed(`[${"a".repeat(64_000)}`)).toBeLessThan(budgetMs);
    expect(timed(`[x](${"a".repeat(64_000)}`)).toBeLessThan(budgetMs);
  });

  test("a long backtick and hash run", () => {
    expect(timed(`\`${"a ".repeat(32_000)}`)).toBeLessThan(budgetMs);
    expect(timed(`## ${"word ".repeat(13_000)}`)).toBeLessThan(budgetMs);
    expect(timed(`&${"a".repeat(64_000)}`)).toBeLessThan(budgetMs);
  });

  test("a page far past the scan cap still returns", () => {
    const huge = `${"clean prose. ".repeat(50_000)}**bold**`;
    expect(timed(huge)).toBeLessThan(budgetMs);
  });

  test("counts are capped rather than unbounded", () => {
    const found = findUnrenderedMarkup("**a** ".repeat(2_000));
    expect(found.find((f) => f.kind === "markdown-emphasis")?.count).toBe(500);
  });
});
