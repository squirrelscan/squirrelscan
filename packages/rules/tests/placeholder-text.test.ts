// content/placeholder-text: template leftovers a reader can actually see.
//
// Every family here is something a page is also allowed to QUOTE, so the
// no-false-positive fixtures (a docs page showing template syntax, a technical
// page writing "undefined behaviour", a task board with a TODO column) carry
// more weight than any of the detection cases.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { findPlaceholders, normalizeProse, placeholderTextRule } from "../src/content/placeholder-text";
import { getRenderedProseText } from "../src/content/text-content";
import type { ParsedPage, RuleContext } from "../src/types";

function run(html: string) {
  const { document } = parseHTML(html);
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document } as unknown as ParsedPage,
    options: {},
  };
  return placeholderTextRule.run(ctx).checks;
}

const page = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;

const kinds = (text: string) => findPlaceholders(text).map((f) => f.kind);

describe("normalizeProse", () => {
  test("collapses horizontal whitespace but keeps newlines", () => {
    expect(normalizeProse("a  \t b\n\n\nc")).toBe("a b\nc");
  });

  test("a newline absorbs the spaces around it, so a boundary is exactly one \\n", () => {
    expect(normalizeProse("your \n company \t name")).toBe("your\ncompany name");
  });

  test("a phrase must not span a boundary", () => {
    // "\n" is what stands in for a skipped subtree, so `your <code>x</code>
    // company name` is not the boilerplate phrase.
    expect(kinds("your\ncompany name")).toEqual([]);
    expect(kinds("your company name")).toContain("boilerplate-copy");
  });
});

describe("findPlaceholders — lorem ipsum", () => {
  test("the bigram is enough on its own", () => {
    expect(kinds("Lorem ipsum dolor sit amet")).toContain("lorem-ipsum");
  });

  test("three distinct marker tokens corroborate each other", () => {
    expect(kinds("consectetur adipiscing eiusmod")).toContain("lorem-ipsum");
  });

  test("the bigram alone is never enough, at any position", () => {
    // Block boundaries put a "\n" before every heading and every bolded lede, so
    // "opens a block" would flag this rule's own documentation.
    expect(kinds("Generates some lorem ipsum for the template.")).toEqual([]);
    expect(kinds("\nLorem ipsum explained\n")).toEqual([]);
    expect(kinds("\nLorem ipsum needs corroboration: three distinct words.")).toEqual([]);
  });

  test("one stray token is not evidence", () => {
    // A single Latin-looking word is how a page about Cicero gets flagged.
    expect(kinds("The word nostrud appears once in this sentence.")).not.toContain("lorem-ipsum");
  });

  test("Spanish and Latin prose stay clean", () => {
    // `dolor`, `sit`, `amet`, `elit` and `sed` are deliberately not markers.
    expect(kinds("El dolor de cabeza es sed de agua, sit down.")).toEqual([]);
  });
});

describe("findPlaceholders — boilerplate copy", () => {
  test("theme filler is caught", () => {
    expect(kinds("Welcome to Your Company Name")).toContain("boilerplate-copy");
    expect(kinds("Insert text here to get started")).toContain("boilerplate-copy");
    expect(kinds("Sample text for the hero")).toContain("boilerplate-copy");
  });

  test("the single words on their own are ordinary English", () => {
    expect(kinds("Request a sample of our placeholder API for your company.")).toEqual([]);
  });

  test("a phrase must be whole words, not a substring", () => {
    expect(kinds("We resample textures at load time.")).toEqual([]);
    expect(kinds("Order a free sample textile swatch.")).toEqual([]);
    expect(kinds("Your company names are stored separately.")).toEqual([]);
  });

  test("the ordinary way to NAME this subject is not filler", () => {
    // Otherwise the rule flags its own documentation page and every article
    // about page builders.
    expect(kinds("Placeholder Text")).toEqual([]);
    expect(kinds("Example text for the docs")).toEqual([]);
  });
});

describe("findPlaceholders — unrendered template syntax", () => {
  test("every delimiter pair is caught", () => {
    expect(kinds("Hello {{ name }}")).toContain("unrendered-template");
    expect(kinds("{% for item in items %}")).toContain("unrendered-template");
    expect(kinds("Hello <%= user.name %>")).toContain("unrendered-template");
    expect(kinds("Total: ${cart.total}")).toContain("unrendered-template");
    expect(kinds("See [[page-title]]")).toContain("unrendered-template");
  });

  test("one leftover nesting two delimiters counts once", () => {
    const [found] = findPlaceholders("<%= ${x} %>");
    expect(found?.kind).toBe("unrendered-template");
    expect(found?.count).toBe(1);
    expect(found?.samples).toEqual(["<%= ${x} %>"]);
  });

  test("ordinary punctuation and prices are not template syntax", () => {
    expect(kinds("Costs $19.99, or {see the table} for details [1].")).toEqual([]);
  });
});

describe("findPlaceholders — JavaScript artifacts", () => {
  test("a value that occupies its own line is caught", () => {
    // What `<h1>{title}</h1>` renders as when the title is missing.
    expect(kinds("Author\nundefined\nPublished")).toContain("js-artifact");
  });

  test("a value that follows its label is caught", () => {
    expect(kinds("Rating: NaN")).toContain("js-artifact");
    expect(kinds("Author: null")).toContain("js-artifact");
    expect(kinds("Price: $undefined")).toContain("js-artifact");
    expect(kinds("Home > undefined")).toContain("js-artifact");
  });

  test("[object Object] needs no corroboration at all", () => {
    expect(kinds("Tags: [object Object]")).toContain("stringified-object");
    expect(kinds("the value [object Array] appeared")).toContain("stringified-object");
  });

  test("a leading comma is a clause break, not a list slot", () => {
    // The shape of every API reference and every JS tutorial written in prose.
    expect(kinds("Accepts a string, null, or undefined.")).toEqual([]);
    expect(kinds("The three falsy values are 0, null, and NaN.")).toEqual([]);
    expect(kinds("Valid JSON values are true, false, null.")).toEqual([]);
    expect(kinds("In JavaScript, NaN, Infinity and -Infinity are special.")).toEqual([]);
  });

  test("a pipe is a TypeScript union, not a list slot", () => {
    expect(kinds("The parameter accepts string | null | undefined")).toEqual([]);
  });

  test("a word at the end of a line is NOT a slot", () => {
    // `Posted by undefined` and `Comparison with NaN` are the same shape in flat
    // text. This family fails an audit, so the trade is made for precision.
    expect(kinds("Comparison with NaN")).toEqual([]);
    expect(kinds("Operations generating NaN")).toEqual([]);
  });

  test("a trailing comma is a sentence, not a list", () => {
    expect(kinds("If an operand is a quiet NaN, there is no exception.")).toEqual([]);
  });

  test("a preceding section number is not a label", () => {
    expect(kinds("See 30.3 NaN Boxing in Crafting Interpreters.")).toEqual([]);
  });

  test("quoting delimiters mean the page is naming the word", () => {
    expect(kinds("Reject the [null] hypothesis")).toEqual([]);
    expect(kinds('The literal "null" is written like this')).toEqual([]);
  });

  test("a word glued to a slash is a compound", () => {
    // MDN: `TypeError: null/undefined has no properties`.
    expect(kinds("TypeError: null/undefined has no properties")).toEqual([]);
  });

  test("technical English about the same words stays clean", () => {
    // The whole reason for the collocation lists.
    expect(kinds("This triggers undefined behaviour in C++.")).toEqual([]);
    expect(kinds("We reject the null hypothesis.")).toEqual([]);
    expect(kinds("The function returns undefined when the key is missing.")).toEqual([]);
    expect(kinds("A null pointer dereference is not the same as a null value.")).toEqual([]);
  });

  test("only the JavaScript spellings match", () => {
    // SQL prose and sentence-initial capitals are not artifacts.
    expect(kinds("Set the column to NULL. Undefined stays empty. Nan is a name.")).toEqual([]);
  });

  test("the word must stand alone", () => {
    expect(kinds("Use the nullable flag or undefinedValue helper.")).toEqual([]);
  });
});

describe("findPlaceholders — source-comment markers", () => {
  test("a marker in both forms at once is counted once", () => {
    // `// TODO: x` is a comment sigil AND an annotation. One leftover, one count.
    const [found] = findPlaceholders("// TODO: fix this");
    expect(found?.kind).toBe("todo-marker");
    expect(found?.count).toBe(1);
    expect(found?.samples).toEqual(["// TODO"]);
  });

  test("a shell comment sigil is a marker", () => {
    expect(kinds("# TODO tidy the config")).toContain("todo-marker");
  });

  test("annotation form is caught", () => {
    expect(kinds("TODO: write the about page")).toContain("todo-marker");
    expect(kinds("FIXME(alice) broken link")).toContain("todo-marker");
    expect(kinds("// TODO polish this")).toContain("todo-marker");
    expect(kinds("// XXX remove before launch")).toContain("todo-marker");
  });

  test("XXX needs a comment sigil, because bare XXX is a Roman numeral", () => {
    expect(kinds("Super Bowl XXX: the box score")).toEqual([]);
    expect(kinds("Chapter XXX: aftermath")).toEqual([]);
    expect(kinds("Rated XXX (explicit)")).toEqual([]);
  });

  test("redaction runs behind a sigil are still not markers", () => {
    // Reaches the redaction guard, which the annotation form no longer can.
    expect(kinds("Reach us on # XXX-XXXX today")).toEqual([]);
  });

  test("a marker introducing a lowercase sentence is caught", () => {
    expect(kinds("TODO finish the pricing copy")).toContain("todo-marker");
  });

  test("a bare TODO label on a task board is not a leftover", () => {
    // Every kanban column in the world is named this.
    expect(kinds("TODO\nIn Progress\nDone")).toEqual([]);
  });

  test("redacted digits are not markers", () => {
    expect(kinds("Call 555-XXX-XXXX or send $XXX,XXX.")).toEqual([]);
  });

  test("a hashtag is not a comment sigil", () => {
    expect(kinds("Shipping it today #TODO")).toEqual([]);
  });

  test("lowercase prose is not a marker", () => {
    expect(kinds("Add it to your todo list and fix me later.")).toEqual([]);
  });
});

describe("findPlaceholders — counts and samples", () => {
  test("distinct samples are deduped, count is total occurrences", () => {
    const [found] = findPlaceholders("{{ a }} and {{ a }} and {{ b }}");
    expect(found?.kind).toBe("unrendered-template");
    expect(found?.count).toBe(3);
    expect(found?.samples).toEqual(["{{ a }}", "{{ b }}"]);
  });
});

describe("findPlaceholders — adversarial input", () => {
  // The ReDoS guard. Every pattern is a negated class or a bounded lazy run, so
  // an unclosed delimiter followed by a huge run must fail fast, not backtrack.
  test("long unterminated delimiters and whitespace runs finish quickly", () => {
    const inputs = [
      // Many start positions, each of which must fail fast. The single-long-run
      // shapes below only ever exercise ONE expensive position.
      "<%".repeat(100_000),
      "{{".repeat(100_000),
      "{%".repeat(100_000),
      "${".repeat(100_000),
      "[[".repeat(100_000),
      `${"<%".padEnd(201, "a")}`.repeat(2_000),
      "// TODO: x ".repeat(20_000),
      ", null".repeat(20_000),
      `{{${"a".repeat(200_000)}`,
      `\${${"a".repeat(200_000)}`,
      `[[${"a".repeat(200_000)}`,
      `<%${" ".repeat(200_000)}`,
      `${"{".repeat(100_000)}${"}".repeat(100_000)}`,
      `TODO${" ".repeat(200_000)}x`,
      `${"undefined ".repeat(20_000)}`,
    ];
    const started = performance.now();
    for (const input of inputs) findPlaceholders(input);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("placeholderTextRule", () => {
  test("a clean page passes", () => {
    expect(run(page("<p>Ordinary copy about ordinary things.</p>"))[0]?.status).toBe("pass");
  });

  test("machine-generated leftovers fail", () => {
    const [check] = run(page("<p>Hello {{ user.name }}</p>"));
    expect(check?.status).toBe("fail");
    expect(check?.message).toMatch(/unrendered template syntax/i);
    expect(check?.value).toBe(1);
  });

  test("human filler only warns", () => {
    // A page could just about mean to write these, so they are not a failure.
    const [check] = run(page("<h1>Your Company Name</h1>\n<p>TODO: write this</p>"));
    expect(check?.status).toBe("warn");
    expect(check?.items?.map((i) => i.id).sort()).toEqual(["boilerplate-copy", "todo-marker"]);
  });

  test("a certain family among warnings escalates the whole check", () => {
    const [check] = run(page("<h1>Sample text</h1>\n<p>Tags: [object Object]</p>"));
    expect(check?.status).toBe("fail");
  });

  test("a bare JavaScript value warns, it does not fail", () => {
    // An API reference whose defaults column reads `null` is ordinary. Only
    // [object X], which nothing legitimate produces, is a failure.
    const [check] = run(page("<table><tr><td>onError</td><td>null</td></tr></table>"));
    expect(check?.status).toBe("warn");
    expect(check?.items?.[0]?.id).toBe("js-artifact");
  });

  test("no document is skipped, not passed", () => {
    const ctx = {
      page: { url: "https://example.com/", html: "", statusCode: 500, loadTime: 0, headers: {} },
      parsed: { document: null } as unknown as ParsedPage,
      options: {},
    } as RuleContext;
    const [check] = placeholderTextRule.run(ctx).checks;
    expect(check?.status).toBe("skipped");
    expect(check?.skipReason).toBe("Parse error");
  });

  test("a document with no body is skipped", () => {
    const { document } = parseHTML("<html><head><title>t</title></head></html>");
    document.querySelector("body")?.remove();
    const ctx = {
      page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: { document } as unknown as ParsedPage,
      options: {},
    } as RuleContext;
    const [check] = placeholderTextRule.run(ctx).checks;
    expect(check?.status).toBe("skipped");
    expect(check?.skipReason).toBe("no-body");
  });
});

describe("placeholderTextRule — what a reader never sees", () => {
  test("a docs page that shows template syntax in a code block stays clean", () => {
    // The fixture that matters: this rule's own documentation.
    const [check] = run(
      page(`
        <h1>Templating</h1>
        <p>Interpolate a value with the double-brace form:</p>
        <pre><code>&lt;h1&gt;Hello {{ user.name }}&lt;/h1&gt;</code></pre>
        <p>The ERB equivalent is <code>&lt;%= user.name %&gt;</code>,
        and in a shell script you would write <code>\${USER}</code>.</p>
        <p>A missing value renders as <code>undefined</code> or
        <samp>[object Object]</samp>. Press <kbd>XXX</kbd> to continue.</p>
      `),
    );
    expect(check?.status).toBe("pass");
  });

  test("this rule's own documentation page stays clean", () => {
    // The design constraint stated at the top of the rule module, asserted.
    const [check] = run(
      page(`
        <h1>Placeholder Text</h1>
        <p>Detects template leftovers and filler copy that shipped to production.</p>
        <h2>False positives</h2>
        <p><strong>Lorem ipsum</strong> needs corroboration: three distinct marker
        words, or the opening phrase.</p>
        <p><strong>JavaScript artifacts</strong> match only the JavaScript
        spellings. A page may write about undefined behaviour, the null
        hypothesis, or a quiet NaN, and stay clean.</p>
        <table>
          <tr><th>Kind</th><th>Example</th></tr>
          <tr><td>unrendered-template</td><td><code>{{ user.name }}</code></td></tr>
          <tr><td>js-artifact</td><td><code>Rating: NaN</code></td></tr>
        </table>
        <pre><code>disable = ["content/placeholder-text"]</code></pre>
      `),
    );
    expect(check?.status).toBe("pass");
  });

  test("script and style contents are not visible text", () => {
    const [check] = run(
      page('<script>var s = "{{ name }}";</script><style>/* TODO: colours */</style><p>Clean.</p>'),
    );
    expect(check?.status).toBe("pass");
  });

  test("an inert <template> is markup the browser never renders", () => {
    // linkedom keeps template children in childNodes, so a plain text walk would
    // read every Vue/Alpine/Handlebars page as full of unrendered syntax.
    const [check] = run(
      page('<p>Clean.</p><template id="row"><li>{{ item.name }}</li></template>'),
    );
    expect(check?.status).toBe("pass");
  });

  test("a phrase is not glued together across a skipped subtree", () => {
    // The `<code>` becomes a newline, and phrases match on literal spaces only.
    const [check] = run(page("<p>Set your <code>x</code> company name in config.</p>"));
    expect(check?.status).toBe("pass");
  });

  test("inline markup inside a phrase does not hide it", () => {
    // `<b>` is not excluded, so the text nodes concatenate with their own spaces.
    const [check] = run(page("<p>Welcome to Your <b>Company</b> Name</p>"));
    expect(check?.status).toBe("warn");
  });

  test("adjacent blocks are separated even with no whitespace between them", () => {
    // `.textContent` joins these into "HeadingTODO: write this", where no
    // word-boundary pattern can see the marker at all.
    expect(run(page("<h1>Heading</h1><p>TODO: write this</p>"))[0]?.status).toBe("warn");
  });

  test("a value alone in a table cell is a value alone on its line", () => {
    // The shape a missing field actually takes, and the reason block boundaries
    // matter: every cell here sits on one source line.
    const [check] = run(page("<table><tr><td>Author</td><td>undefined</td></tr></table>"));
    expect(check?.items?.[0]?.id).toBe("js-artifact");
    expect(check?.value).toBe(1);
  });

  test("a block boundary does not fuse two words into a placeholder", () => {
    // The boundary must SEPARATE, never join: `<p>your</p><p>company name</p>`
    // is not the boilerplate phrase.
    expect(run(page("<p>your</p><p>company name</p>"))[0]?.status).toBe("pass");
  });
});

describe("getRenderedProseText", () => {
  const prose = (body: string) => {
    const { document } = parseHTML(page(body));
    return getRenderedProseText(document.querySelector("body") as never);
  };

  test("script-like and code-like subtrees become a boundary", () => {
    expect(prose("<p>a<script>x</script>b<code>y</code>c</p>")).toBe("\na\nb\nc");
  });

  test("<template> content is inert markup, not text", () => {
    expect(prose('<p>a</p><template id="t"><li>{{ x }}</li></template><p>b</p>')).toBe("\na\n\nb");
  });

  test("every code-container class is excluded", () => {
    // Each entry is load-bearing: a typo here ships a false positive on the
    // FAILING unrendered-template family, and nothing else would notice.
    for (const cls of [
      "hljs",
      "shiki",
      "prism",
      "torchlight",
      "codeblock",
      "code-block",
      "cm-editor",
      "monaco-editor",
      "language-liquid",
      "cm-content",
      "monaco-scroller",
    ]) {
      expect(prose(`<p>a</p><div class="${cls}">{{ page_title }}</div>`)).not.toContain("{{");
    }
  });

  test("a class-list match works on any token, not just the first", () => {
    expect(prose('<div class="Card_7q5 cm-editor cm-static">{{ x }}</div>')).not.toContain("{{");
  });

  test("an ordinary class is not a code container", () => {
    expect(prose('<div class="highlight-banner">{{ x }}</div>')).toContain("{{ x }}");
  });

  test("block elements are separated, inline elements are not", () => {
    expect(prose("<p>your <b>company</b> name</p>")).toBe("\nyour company name");
    expect(prose("<tr><td>Author</td><td>undefined</td></tr>")).toBe(
      "\n\nAuthor\nundefined",
    );
  });
});
