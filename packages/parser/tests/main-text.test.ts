// extractMainText (#2359): markup fallback, placer decisions, markdown structure, safety.

import { describe, expect, test } from "bun:test";
import type { Element } from "linkedom";

import {
  extractMainText,
  hasFurnitureToken,
  MAIN_TEXT_DROPPED_REGIONS,
  MAIN_TEXT_DROPPED_SECTIONS,
  MAIN_TEXT_KEPT_REGIONS,
  type ContentPlacement,
  type ContentPlacer,
} from "../src/extractors/main-text";
import { parseDocument } from "../src/index";

function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
}
const run = (body: string, place?: ContentPlacer) =>
  extractMainText(parseDocument(page(body)), place ? { place } : {});

describe("markup fallback: landmarks", () => {
  test("nav, header, footer and aside are dropped; main text is kept", () => {
    const out = run(`
      <header><h1>Site name</h1><nav><a href="/">Home</a></nav></header>
      <main><h2>Real heading</h2><p>Real paragraph text.</p></main>
      <aside><p>Related junk</p></aside>
      <footer><p>Copyright junk</p></footer>`);
    expect(out.text).toBe("Real heading\n\nReal paragraph text.");
    expect(out.placer).toBe("markup");
  });

  test("a header and footer inside article are the article's own and are kept", () => {
    const out = run(`
      <nav><a href="/">Home</a></nav>
      <article><header><h1>Post title</h1><p>By Ada</p></header>
      <p>Body text here.</p><footer><p>Filed under tests</p></footer></article>`);
    expect(out.text).toBe("Post title\n\nBy Ada\n\nBody text here.\n\nFiled under tests");
    expect(out.blocks[0]!.region).toMatchObject({ label: "main_content", source: "rules" });
  });

  test("ARIA roles: banner, contentinfo, navigation, complementary and dialog are dropped", () => {
    const out = run(`
      <div role="banner"><p>b</p></div><div role="navigation"><p>n</p></div>
      <div role="complementary"><p>c</p></div><div role="contentinfo"><p>f</p></div>
      <div role="dialog"><p>d</p></div><div role="alertdialog"><p>a</p></div>
      <div><p>kept</p></div>`);
    expect(out.text).toBe("kept");
  });

  test("hidden, aria-hidden, sr-only and script/style never contribute", () => {
    const out = run(`<div><p hidden>h</p><p aria-hidden="true">x</p><span class="sr-only">y</span>
      <p style="display:none">z</p><script>var a=1</script><style>p{}</style><p>seen</p></div>`);
    expect(out.text).toBe("seen");
  });
});

describe("markup fallback: furniture tokens", () => {
  test("cookie banners, ad slots, chat widgets, newsletter and share bars are dropped", () => {
    const out = run(`
      <div class="content"><p>Para one.</p>
        <div class="cookie-banner"><p>We use cookies</p></div>
        <div class="adsbygoogle"><p>buy now</p></div>
        <div id="div-gpt-ad-123"><p>gpt ad</p></div>
        <div class="intercom-lightweight-app"><p>chat with us</p></div>
        <div id="hubspot-messages-iframe-container"><p>hs chat</p></div>
        <div class="newsletter-signup"><p>join the list</p></div>
        <div class="share-buttons"><span>Share this</span></div>
        <div class="onetrust-banner-sdk"><p>consent</p></div>
        <p>Para two.</p></div>`);
    expect(out.text).toBe("Para one.\n\nPara two.");
  });

  test("inline furniture between sentences is dropped", () => {
    const out = run(`<p>Before <ins class="adsbygoogle">AD</ins> after.</p>`);
    expect(out.text).toBe("Before after.");
  });

  test("false-positive guards: whole tokens only", () => {
    for (const cls of [
      "header",
      "shadow",
      "download",
      "breadcrumb",
      "heading",
      "added",
      "badge",
      "ad-free",
      "page-header",
      "readmore",
      "loading",
      "cookie-policy-link",
      "share-price",
      "has-sidebar",
      "content-with-sidebar",
      "drift-chart",
      "chat-log",
    ]) {
      const document = parseDocument(`<div class="${cls}" id="x-${cls}">t</div>`);
      const el = document.querySelector("div") as unknown as Element;
      expect([cls, hasFurnitureToken(el)]).toEqual([cls, false]);
    }
    const out = run(`<div class="header shadow download breadcrumb"><p>kept text</p></div>`);
    expect(out.text).toBe("kept text");
  });

  test("tokens that must match do match", () => {
    for (const cls of [
      "ad",
      "ads",
      "ad-slot",
      "cookie-consent",
      "CybotCookiebotDialog",
      "tawk-widget",
      "sidebar",
    ]) {
      const document = parseDocument(`<div class="${cls}">t</div>`);
      expect([cls, hasFurnitureToken(document.querySelector("div") as unknown as Element)]).toEqual(
        [cls, true],
      );
    }
  });

  test("comment threads are kept and labelled", () => {
    const out = run(`<article><p>Post.</p><div id="comments"><p>Nice post!</p></div></article>`);
    expect(out.text).toBe("Post.\n\nNice post!");
    expect(out.blocks[1]!.section).toMatchObject({ label: "comments", source: "rules" });
    expect(out.blocks[0]!.section).toBeNull();
  });
});

describe("structure and markdown", () => {
  test("headings, paragraphs, links as text, inline code", () => {
    const out = run(`<main><h1>Title</h1><h3>Sub</h3>
      <p>See <a href="https://x.example/doc">the docs</a> and run <code>npm test</code>.<img src="a.png" alt="pic"></p></main>`);
    expect(out.blocks.map((b) => [b.kind, b.level])).toEqual([
      ["heading", 1],
      ["heading", 3],
      ["paragraph", undefined],
    ]);
    expect(out.markdown).toBe("# Title\n\n### Sub\n\nSee the docs and run `npm test`.");
    expect(out.text).not.toContain("x.example");
  });

  test("lists, ordered lists and nested lists", () => {
    const out = run(`<main><ul><li>One<ul><li>Inner</li></ul></li><li>Two</li></ul>
      <ol><li>First</li><li>Second</li></ol></main>`);
    expect(out.blocks.map((b) => b.kind)).toEqual(["list", "list"]);
    expect(out.blocks[0]!.markdown).toBe("- One\n  - Inner\n- Two");
    expect(out.blocks[0]!.text).toBe("One\nInner\nTwo");
    expect(out.blocks[1]!.markdown).toBe("1. First\n2. Second");
  });

  test("tables become GFM pipe tables and escape pipes", () => {
    const out = run(`<main><table><thead><tr><th>Name</th><th>Value</th></tr></thead>
      <tbody><tr><td>a|b</td><td>1</td></tr><tr><td>c</td></tr></tbody></table></main>`);
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]!.markdown).toBe(
      "| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| c |  |",
    );
  });

  test("table cells escape backslashes so a trailing backslash cannot escape the separator", () => {
    const out = run(`<main><table><tr><th>Path</th><th>Note</th></tr>
      <tr><td>C:\\dir\\</td><td>x\\|y</td></tr></table></main>`);
    expect(out.blocks[0]!.markdown).toBe(
      "| Path | Note |\n| --- | --- |\n| C:\\\\dir\\\\ | x\\\\\\|y |",
    );
  });

  test("code blocks drop trailing whitespace without slow backtracking on long whitespace runs", () => {
    const run_ = "\t".repeat(50_000);
    const out = run(`<main><pre><code>a${run_}b${run_}</code></pre></main>`);
    expect(out.blocks[0]!.text).toBe(`a${run_}b`);
  });

  test("a layout table is walked through, not flattened into one table block", () => {
    const out = run(
      `<table role="presentation"><tr><td><h2>Heading</h2><p>Para</p></td></tr></table>`,
    );
    expect(out.blocks.map((b) => b.kind)).toEqual(["heading", "paragraph"]);
  });

  test("blockquote and loose text become quote and paragraph blocks", () => {
    const out = run(
      `<div>Loose <b>text</b> here<blockquote><p>Quoted words</p></blockquote>tail</div>`,
    );
    expect(out.blocks.map((b) => [b.kind, b.text])).toEqual([
      ["paragraph", "Loose text here"],
      ["quote", "Quoted words"],
      ["paragraph", "tail"],
    ]);
    expect(out.blocks[1]!.markdown).toBe("> Quoted words");
  });
});

describe("code blocks", () => {
  const body = `<main><p>Install it:</p>
    <pre><code class="language-ts">const a = 1;\n  const b = "two";\n</code></pre>
    <p>Then run it.</p><pre class="lang-sh">npm run build</pre></main>`;

  test("are marked, carry the language and are kept verbatim", () => {
    const out = run(body);
    const code = out.blocks.filter((b) => b.code);
    expect(code.map((b) => [b.kind, b.language])).toEqual([
      ["code", "ts"],
      ["code", "sh"],
    ]);
    expect(code[0]!.text).toBe('const a = 1;\n  const b = "two";');
    expect(out.markdown).toContain('```ts\nconst a = 1;\n  const b = "two";\n```');
    expect(out.markdown).toContain("```sh\nnpm run build\n```");
  });

  test("proseText excludes them, text keeps them", () => {
    const out = run(body);
    expect(out.proseText).toBe("Install it:\n\nThen run it.");
    expect(out.text).toContain("const a = 1;");
  });

  test("a fence longer than any backtick run in the code", () => {
    const out = run("<main><pre>a ``` b</pre></main>");
    expect(out.markdown).toBe("````\na ``` b\n````");
  });
});

describe("safety", () => {
  test("50k nested divs do not throw", () => {
    const depth = 50_000;
    const html = page(`${"<div>".repeat(depth)}<p>deep text</p>${"</div>".repeat(depth)}`);
    const doc = parseDocument(html);
    const seen: string[] = [];
    const out = extractMainText(doc, {
      place: (el) => {
        seen.push(el.tagName);
        return null;
      },
    });
    expect(out.text).toBe("deep text");
    // The placer is not asked past its depth cap.
    expect(seen.length).toBeLessThan(2000);
  });

  test("an empty document gives an empty extraction", () => {
    const out = extractMainText(parseDocument(""));
    expect(out).toMatchObject({ text: "", markdown: "", proseText: "", blocks: [] });
  });
});

describe("with a placer", () => {
  // Each labelled element is its own classifier node: ids are handed out from 7 in the order asked.
  const label = (l: string, nodeId: number, source: "model" | "rules" = "model") => ({
    label: l,
    confidence: 0.93,
    source,
    nodeId,
  });
  // Label by element id, inherited from the nearest labelled ancestor as elementPlacer does:
  // `region-x` / `section-x`; `trunc` fails closed; `boom` throws.
  const byId = (calls?: Element[]): ContentPlacer => {
    const nodeIds = new Map<Element, number>();
    const idOf = (node: Element): number => {
      if (!nodeIds.has(node)) nodeIds.set(node, 7 + nodeIds.size);
      return nodeIds.get(node)!;
    };
    return (el) => {
      calls?.push(el);
      const out: ContentPlacement = { region: null, section: null };
      let hops = 0;
      for (let node: Element | null = el; node; node = node.parentElement, hops++) {
        const id = node.getAttribute("id") ?? "";
        if (id === "boom") throw new Error("placer exploded");
        if (id === "trunc") return { region: null, section: null, truncated: true };
        if (!out.region && id.startsWith("region-"))
          out.region = { ...label(id.slice(7), idOf(node)), hops };
        if (!out.section && id.startsWith("section-"))
          out.section = { ...label(id.slice(8), idOf(node)), hops };
      }
      return out.region || out.section ? out : null;
    };
  };

  test("a section labelled cookie_consent or ad is dropped, with no markup hint", () => {
    const out = run(
      `<div id="region-main_content"><p>keep me</p>
         <div id="section-cookie_consent"><p>cookies</p></div>
         <div id="section-ad"><p>ad copy</p></div>
         <div id="section-chat_widget"><p>chat</p></div></div>`,
      byId(),
    );
    expect(out.text).toBe("keep me");
    expect(out.placer).toBe("classifier");
  });

  test("placer is 'classifier' when the placer gave a real answer, even only a drop", () => {
    const out = run(`<div id="section-ad"><p>ad</p></div><p>plain</p>`, byId());
    expect(out.text).toBe("plain");
    expect(out.placer).toBe("classifier");
  });

  test("a region labelled footer (or any dropped region) is dropped", () => {
    for (const region of MAIN_TEXT_DROPPED_REGIONS) {
      const out = run(`<div id="region-${region}"><p>gone</p></div><div><p>stay</p></div>`, byId());
      expect(out.text).toBe("stay");
    }
  });

  test("article_chrome drops its text but keeps its headings", () => {
    const out = run(
      `<header id="region-article_chrome"><h1>Title</h1><p>By Ada</p>Loose byline<ul><li>Share</li></ul></header>
       <div id="region-main_content"><p>body</p></div>`,
      byId(),
    );
    expect(out.blocks.map((b) => b.text)).toEqual(["Title", "body"]);
  });

  test("markup wins over a model chrome label on main/article, but not on a plain div", () => {
    const out = run(
      `<article id="region-site_header"><h2>Opening hours</h2><p>Open nine to five.</p></article>
       <div id="region-site_header"><p>real header</p></div>`,
      byId(),
    );
    expect(out.blocks.map((b) => b.text)).toEqual(["Opening hours", "Open nine to five."]);
    // The kept blocks say what actually decided: the markup, not the overruled model label.
    expect(out.blocks[0]!.region).toMatchObject({ label: "main_content", source: "rules" });
  });

  test("a nav that inherits main_content (hops 1) is dropped by its markup; an own answer keeps a div", () => {
    const out = run(
      `<div id="region-main_content"><p>text</p><nav><p>menu</p></nav><aside><p>side</p></aside>
       <div role="navigation"><p>roles</p></div><div><p>plain</p></div></div>`,
      byId(),
    );
    expect(out.blocks.map((b) => b.text)).toEqual(["text", "plain"]);
  });

  test("a header below a placer-labelled content div (not in main/article) is that content's own", () => {
    const out = run(
      `<div id="region-main_content"><header><h2>Section title</h2></header><p>body</p></div>
       <header><h2>Site banner</h2></header>`,
      byId(),
    );
    expect(out.blocks.map((b) => b.text)).toEqual(["Section title", "body"]);
  });

  test("a div labelled main_content is kept and its block carries label, node id and source", () => {
    const out = run(`<div id="region-main_content"><p>Kept paragraph.</p></div>`, byId());
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]!.region).toEqual({
      label: "main_content",
      source: "model",
      confidence: 0.93,
      nodeId: 7,
    });
    expect(out.blocks[0]!.section).toBeNull();
  });

  test("a kept subtree can still hold a dropped child; comments stay and are labelled", () => {
    const out = run(
      `<main id="region-content_block"><p>one</p><div id="section-newsletter_signup"><p>sign up</p></div>
       <div id="section-comments"><p>a comment</p></div></main>`,
      byId(),
    );
    expect(out.blocks.map((b) => b.text)).toEqual(["one", "a comment"]);
    expect(out.blocks[1]!.section!.label).toBe("comments");
  });

  test("truncated fails closed", () => {
    const out = run(`<div id="trunc"><p>unknown extent</p></div><p>fine</p>`, byId());
    expect(out.text).toBe("fine");
  });

  test("a placer that throws is an abstention, not a crash", () => {
    const out = run(`<div id="boom"><p>still read</p></div><nav><p>menu</p></nav>`, byId());
    expect(out.text).toBe("still read");
  });

  test("an abstaining placer falls back to the markup rules", () => {
    const out = run(
      `<nav><p>menu</p></nav><div class="cookie-banner"><p>c</p></div><p>body</p>`,
      () => null,
    );
    expect(out.text).toBe("body");
    expect(out.placer).toBe("markup");
  });

  test("an 'unknown' answer counts as abstention", () => {
    const out = run(`<nav id="x"><p>menu</p></nav><p>body</p>`, () => ({
      region: { label: "unknown", confidence: 0, source: "rules" },
      section: null,
    }));
    expect(out.text).toBe("body");
  });

  test("a chat widget the classifier did not name is still dropped by its markup", () => {
    const out = run(
      `<div id="region-content_block"><p>text</p><div class="tawk-min-container"><p>chat</p></div></div>`,
      byId(),
    );
    expect(out.text).toBe("text");
  });

  test("a page-wide form that holds main is a wrapper, not a form", () => {
    const out = run(
      `<form id="region-form"><main id="region-main_content"><p>asp.net page</p></main></form>`,
      byId(),
    );
    expect(out.text).toBe("asp.net page");
    const real = run(`<form id="region-form"><p>Your name</p></form>`, byId());
    expect(real.text).toBe("");
  });

  test("one placer call per container or block, cached", () => {
    const calls: Element[] = [];
    run(`<div id="region-main_content"><p>a</p><p>b</p></div>`, byId(calls));
    expect(calls.length).toBe(3);
  });

  test("the label sets are disjoint and as documented", () => {
    expect([...MAIN_TEXT_KEPT_REGIONS].sort()).toEqual(["content_block", "main_content"]);
    expect([...MAIN_TEXT_DROPPED_SECTIONS].sort()).toEqual([
      "ad",
      "chat_widget",
      "cookie_consent",
      "newsletter_signup",
      "promo_banner",
      "social_share",
    ]);
    for (const r of MAIN_TEXT_KEPT_REGIONS) expect(MAIN_TEXT_DROPPED_REGIONS.has(r)).toBe(false);
  });
});
