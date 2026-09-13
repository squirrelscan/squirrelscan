// The standalone entity-map page is built from untrusted site content and must
// work offline, so two things are load-bearing: the map really is inlined (no
// fetch at runtime), and nothing from the map can close the script block or
// reach the DOM as markup.

import { describe, expect, test } from "bun:test";

import { parseDocument } from "@squirrelscan/parser";

import { buildEntityMap, renderEntityMapHtml } from "../src/entity-map";

const AT = "2026-01-01T00:00:00.000Z";

function render(raw: string): string {
  const map = buildEntityMap([{ url: "https://example.com/", raw }], "https://example.com/", {
    generatedAt: AT,
  });
  return renderEntityMapHtml(map);
}

describe("renderEntityMapHtml", () => {
  test("inlines the map as JSON and loads nothing from the network", () => {
    const html = render(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": "https://example.com/#org",
        name: "Acme",
      }),
    );

    expect(html).toContain('<script type="application/json" id="em-data">');
    expect(html).toContain("Acme");
    expect(html).toContain("squirrelscan/entity-map");
    // No CDN, no external stylesheet, no runtime fetch.
    expect(html).not.toContain("https://cdn");
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/src="https?:/);
  });

  test("a script tag in an entity name cannot escape the data block", () => {
    const html = render(
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "</script><script>window.pwned=1</script>",
        description: "<img src=x onerror=alert(1)>",
      }),
    );

    // The payload survives, but only in escaped form.
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).not.toContain("window.pwned=1</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");

    // Exactly the script elements the renderer itself writes.
    const openers = html.match(/<script/g) ?? [];
    expect(openers).toHaveLength(2);

    // And the inlined JSON still parses back to the original name.
    const start = html.indexOf('id="em-data">') + 'id="em-data">'.length;
    const end = html.indexOf("</script>", start);
    const parsed = JSON.parse(html.slice(start, end)) as { nodes: { name: string | null }[] };
    expect(parsed.nodes[0]?.name).toBe("</script><script>window.pwned=1</script>");
  });

  test("a hostile site URL cannot break out of the title", () => {
    const map = buildEntityMap([], '"><script>x()</script>', { generatedAt: AT });
    const html = renderEntityMapHtml(map);
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>x()</script>");
  });

  test("renders an empty-state page for a site with no JSON-LD", () => {
    const map = buildEntityMap([{ url: "https://example.com/", raw: null }], "https://example.com/", {
      generatedAt: AT,
    });
    const html = renderEntityMapHtml(map);
    expect(html).toContain("This site declares no JSON-LD entities.");
    expect(html).toContain('"nodeCount":0');
  });
});

describe("the viewer script itself", () => {
  // The viewer is a JS program inside a TypeScript template literal, so tsgo
  // checks the TypeScript around it and NOTHING inside it. A syntax error, or a
  // stray backtick in a comment, compiles fine and ships a page whose graph
  // never renders. Twice during this feature's development a backtick in a
  // comment closed the literal, and the reported error was 200 lines away.
  const html = render(
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://example.com/#org",
      name: "Acme",
    }),
  );

  test("parses as JavaScript", () => {
    // Parsed as HTML, not matched with a regex. Two regexes here were each
    // correct for the markup we emit and each rejected by CodeQL for a case
    // HTML permits and they missed: an uppercase `<SCRIPT>`, then an end tag
    // with junk before the `>`. Both objections were right, and a third
    // iteration would only have found the fourth. The parser already knows
    // what a script element is.
    //
    // The inlined map rides in a `type="application/json"` element, which is
    // not JavaScript and must not reach the transpiler. Selected by TYPE, so
    // the two cannot be confused as the document grows.
    const document = parseDocument(html);
    const scripts = [...document.querySelectorAll("script")]
      .filter((element) => {
        const type = element.getAttribute("type");
        return type === null || type === "" || type.toLowerCase() === "text/javascript";
      })
      .map((element) => element.textContent ?? "")
      .filter((source) => source.trim().length > 0);
    expect(scripts.length).toBeGreaterThan(0);

    // Transpiler rather than `new Function`: this only needs to know the
    // script parses, and building a callable out of page-derived source would
    // be a code path that could run.
    const transpiler = new Bun.Transpiler({ loader: "js" });
    for (const source of scripts) {
      expect(() => transpiler.transformSync(source)).not.toThrow();
    }
  });

  test("caps the labels a hover grants", () => {
    // Highlighting every neighbour is right and stays unbounded. Labelling
    // every neighbour is not: hovering a hub on a real 40-page crawl granted
    // 41 labels at once, which is the unreadable centre the zoom budget exists
    // to prevent, reached through the pointer instead.
    expect(html).toContain("var HOVER_LABEL_BUDGET = 12;");
    // The granted-label test must read the capped set, not the full neighbour
    // set — using `near` here is the bug this pins.
    expect(html).toContain("neighbourLabels !== null && neighbourLabels[index]");
  });
});
