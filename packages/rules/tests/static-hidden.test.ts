// shared/static-hidden: markup, a strict inline-style reader and the narrow
// subset of `<style>` rules shared/page-styles.ts decides (pub#664, pub#665,
// pub#678). External stylesheets are not read. The CHROMIUM table pins the one
// invariant that matters: wherever Chromium shows the element, the check never
// answers "hidden" (that would silently drop a real failure). It may be more
// cautious ("unknown") or miss a hide.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "@squirrelscan/parser/dom";

import { parseSelector } from "../src/shared/page-styles";
import { createStaticVisibility, readInlineStyle } from "../src/shared/static-hidden";

/** The verdict for `#t` in a page whose body is `body`. */
function verdict(body: string, ariaHidden = false): string {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${body}</body></html>`);
  const target = document.querySelector("#t");
  if (!target) throw new Error("fixture has no #t");
  return createStaticVisibility({ ariaHidden }).visibility(target as unknown as Element).state;
}

describe("static-hidden: markup", () => {
  test("hidden (not until-found), closed dialog, popover, template, aria-hidden when asked", () => {
    expect(verdict('<div hidden><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<div HIDDEN=""><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<div hidden="until-found"><b id="t"></b></div>')).toBe("shown");
    expect(verdict('<div hidden=" until-found "><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<dialog><b id="t"></b></dialog>')).toBe("hidden");
    expect(verdict('<dialog open><b id="t"></b></dialog>')).toBe("shown");
    expect(verdict('<div popover="manual"><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<div aria-hidden="TRUE"><b id="t"></b></div>', true)).toBe("hidden");
    expect(verdict('<div aria-hidden="true"><b id="t"></b></div>', false)).toBe("shown");
    expect(verdict('<div><b id="t"></b></div>')).toBe("shown");
  });

  test("a <template> subtree is never rendered", () => {
    const { document } = parseHTML(
      "<!doctype html><html><body><template><b></b></template></body></html>",
    );
    const inner = document.querySelector("template")?.firstElementChild;
    expect(inner).toBeTruthy();
    const seen = createStaticVisibility({ ariaHidden: false }).visibility(
      inner as unknown as Element,
    );
    expect(seen.state).toBe("hidden");
  });

  test("a <style> rule it can decide hides the element (pub#678)", () => {
    expect(verdict('<style>.x{display:none}</style><b id="t" class="x"></b>')).toBe("hidden");
    expect(verdict('<style>.x{visibility:hidden}</style><div class="x"><b id="t"></b></div>')).toBe("hidden");
  });

  test("with an external stylesheet, hiding from a <style> rule is not settled", () => {
    const external = '<link rel="stylesheet" href="/site.css">';
    expect(verdict(`${external}<style>.x{display:none}</style><b id="t" class="x"></b>`)).toBe("unknown");
    // An inline style still settles it, as before.
    expect(verdict(`${external}<b id="t" style="display:none"></b>`)).toBe("hidden");
    // A <style> rule that shows an element the browser hides by default is not
    // settled either: an external `[hidden]{display:none!important}` beats it
    // (pub#938, Chromium rows "an external [hidden] !important ...").
    expect(verdict(`${external}<style>.f{display:flex}</style><div hidden class="f"><b id="t"></b></div>`)).toBe(
      "unknown",
    );
  });

  test("a rule it cannot decide makes the elements it could reach unknown, and only those", () => {
    const css = "<style>.x{display:none}@media (min-width:1px){.x{display:block}}</style>";
    expect(verdict(`${css}<b id="t" class="x"></b>`)).toBe("unknown");
    expect(verdict(`${css}<b id="t" class="y"></b>`)).toBe("shown");
  });

  test("inherited visibility is settled once every stylesheet was read", () => {
    expect(verdict('<div style="visibility:hidden"><b id="t"></b></div>')).toBe("hidden");
    expect(verdict('<link rel="stylesheet" href="/site.css"><div style="visibility:hidden"><b id="t"></b></div>')).toBe(
      "unknown",
    );
  });
});

describe("static-hidden: the inline-style reader", () => {
  test("reads only plainly written declarations", () => {
    expect(readInlineStyle("display:none")).toEqual({ display: "none" });
    expect(readInlineStyle(" Display : NONE ! important ;color:red")).toEqual({ display: "none" });
    expect(readInlineStyle("visibility:hidden;display:flex")).toEqual({
      visibility: "hidden",
      display: "shown",
    });
    expect(readInlineStyle("color:red")).toEqual({});
    expect(readInlineStyle(null)).toEqual({});
  });

  test("anything else that mentions display or visibility is unknown", () => {
    const unknown = { display: "unknown", visibility: "unknown" };
    for (const style of [
      "display:var(--d)",
      "display:/**/none",
      "display:n\\6f ne",
      "display:\u00a0none",
      "display:none !important !important",
      "display:!important none",
      "display:revert",
      "display:block flow",
      "display:",
      "all:initial",
      "visibility:nope",
    ]) {
      expect(readInlineStyle(style)).toEqual(unknown);
    }
  });

  // pub#938: the block is cut into declarations first. Only a `display`,
  // `visibility` or `all` declaration can hide, so a custom property or any
  // other property is skipped whatever its value holds.
  test("only display, visibility and all declarations are read", () => {
    const unknown = { display: "unknown", visibility: "unknown" };
    expect(readInlineStyle("content:'x';display:none")).toEqual({ display: "none" });
    expect(readInlineStyle("--font-display:swap;--gap:calc(1rem + 2px)")).toEqual({});
    expect(
      readInlineStyle(
        "--wp--custom--typography--presets--6--name: Display; --font: var(--text-display-shorthand)",
      ),
    ).toEqual({});
    expect(readInlineStyle("font-family:var(--wp--preset--font-family--display) !important")).toEqual({});
    expect(readInlineStyle("--x:'a;display:none';color:red")).toEqual({});
    expect(readInlineStyle("--x:(;display:none);display:block")).toEqual({ display: "shown" });
    // An escape outside a string can spell a name or a `url(`: not read.
    expect(readInlineStyle("--a\\;display:none")).toEqual(unknown);
    expect(readInlineStyle("display:none;--x:u\\72l(();display:block")).toEqual(unknown);
    expect(readInlineStyle("content:'\\201C';display:none")).toEqual({ display: "none" });
    expect(readInlineStyle("--d:none;display:var(--d)")).toEqual(unknown);
    expect(readInlineStyle("d\\69splay:none")).toEqual(unknown);
    expect(readInlineStyle("c\\olor:red;display:block")).toEqual(unknown);
    expect(readInlineStyle("*display:none")).toEqual(unknown);
    expect(readInlineStyle("/* c */ display:none")).toEqual(unknown);
    // A string a newline cuts: the browser reads the rest differently.
    expect(readInlineStyle("content:'a\nb';display:none")).toEqual(unknown);
    expect(readInlineStyle("content:'a")).toEqual({});
    expect(readInlineStyle("content:'a;display:none")).toEqual(unknown);
  });

  test("!important beats a later normal declaration; otherwise the last wins", () => {
    expect(readInlineStyle("display:none !important;display:block")).toEqual({ display: "none" });
    expect(readInlineStyle("display:none;display:block")).toEqual({ display: "shown" });
  });

  test("stays linear on a megabyte attribute", () => {
    const started = performance.now();
    readInlineStyle(`display:none${" ".repeat(1_000_000)}x`);
    readInlineStyle(`${"display:none;".repeat(80_000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

/**
 * Rendered in headless Chromium (chrome-headless-shell 1248), reusable by any
 * reviewer: `chromium` is "hidden" when `#t` or an ancestor computes
 * `display:none`, or `#t` computes `visibility:hidden` or `collapse`. Each
 * `html` is the body of `<!doctype html><html><head></head><body>…</body></html>`.
 * The `style: …` rows (pub#678) are the `<style>` adversarial set: invalid
 * selector lists, ignored `type` and `media`, url() and block tokens, escapes,
 * NBSP, cascade order, external sheets, `@import`, `@layer` and nesting.
 * The `width: …` rows (pub#988) are rendered at several viewport widths
 * (`widths`, one iframe per width, set by its CSS width): `chromium` is "shown"
 * when any width shows the element. static-hidden-width-media-988.test.ts adds
 * the checks that need every width.
 *
 * To regenerate or add rows: write one HTML page holding an
 * `<iframe srcdoc="…">` per row (the body above, attribute-escaped), plus a
 * `load` handler that, for each iframe, finds `#t`, walks it and its
 * ancestors with `getComputedStyle` for `display:none`, checks its own
 * `visibility`, and writes the verdicts as JSON into a `<pre>`. Render it with
 * `chrome-headless-shell --headless --disable-gpu --virtual-time-budget=5000
 * --dump-dom file:///…/page.html` (install with `bunx playwright install
 * chromium-headless-shell`), then copy each verdict into `chromium`.
 */
const CHROMIUM: Array<{
  name: string;
  html: string;
  chromium: "hidden" | "shown";
  widths?: Record<string, "hidden" | "shown">;
}> = await Bun.file(new URL("fixtures/static-hidden-chromium.json", import.meta.url)).json();

describe("static-hidden: never hidden where Chromium shows the element", () => {
  for (const row of CHROMIUM) {
    test(`${row.name} (Chromium: ${row.chromium})`, () => {
      if (row.chromium === "shown") expect(verdict(row.html)).not.toBe("hidden");
    });
  }
});

// pub#1013: CSS nesting. A rule nested inside a style rule (`b { @media (...) {
// display: none } }`, `.a { & .b { ... } }`) is not read, and it could reach the
// element, so where Chromium hides it the reader must never say "shown": an unnamed
// control there would otherwise FAIL. Rows measured in headless Chromium at 1024px.
describe("static-hidden: never shown where Chromium hides a nested-rule element", () => {
  for (const row of CHROMIUM.filter((r) => r.name.startsWith("nesting:"))) {
    test(`${row.name} (Chromium: ${row.chromium})`, () => {
      if (row.chromium === "hidden") expect(verdict(row.html)).not.toBe("shown");
    });
  }

  test("a nested rule that sets neither property keeps its answer", () => {
    expect(verdict('<style>b{& .x{color:red}}</style><b id="t"></b>')).toBe("shown");
  });

  test("an unnested rule keeps its answer", () => {
    expect(verdict('<style>b{display:none}</style><b id="t"></b>')).toBe("hidden");
  });
});

// pub#678: the <style> reader is bounded on hostile input. Past a bound it
// stops reading, and every element reads "unknown" (pub#1015): the rules it
// dropped could hide or show anything.
describe("static-hidden: <style> reading is bounded", () => {
  const timed = (body: string) => {
    const started = performance.now();
    const seen = verdict(body);
    return { seen, ms: performance.now() - started };
  };

  test("a stylesheet past the size bound is not read", () => {
    const big = `.pad{color:red}`.repeat(20_000);
    const { seen, ms } = timed(`<style>${big}.x{display:none}</style><b id="t" class="x"></b>`);
    expect(seen).toBe("unknown");
    expect(ms).toBeLessThan(2000);
  });

  test("more rules than the bound: not read", () => {
    const rules = Array.from({ length: 6000 }, (_, i) => `.r${i}{display:none}`).join("");
    const { seen, ms } = timed(`<style>${rules}.x{display:none}</style><b id="t" class="x"></b>`);
    expect(seen).toBe("unknown");
    expect(ms).toBeLessThan(2000);
  });

  test("an 11 KB nested stylesheet is dropped at the first nested rule", () => {
    const nested = `${".a{display:block;".repeat(700)}${"}".repeat(700)}`;
    expect(nested.length).toBeGreaterThan(11_000);
    const { seen, ms } = timed(`<style>${nested}.x{display:none}</style><b id="t" class="x"></b>`);
    expect(seen).toBe("unknown");
    expect(ms).toBeLessThan(2000);
  });

  test("an over-long selector is not read", () => {
    const long = `.x${".y".repeat(600)}`;
    expect(verdict(`<style>${long}{display:none}</style><b id="t" class="x"></b>`)).toBe("unknown");
  });

  test("4,000 rules against 2,000 controls stays fast", () => {
    const rules = Array.from({ length: 4000 }, (_, i) => `.r${i}{display:${i % 2 ? "none" : "block"}}`).join("");
    const buttons = Array.from({ length: 2000 }, (_, i) => `<button class="r${i} c${i}"></button>`).join("");
    const { document } = parseHTML(`<!doctype html><html><head><style>${rules}</style></head><body>${buttons}</body></html>`);
    const resolver = createStaticVisibility({ ariaHidden: false });
    const started = performance.now();
    let hidden = 0;
    for (const button of document.querySelectorAll("button")) {
      if (resolver.visibility(button as unknown as Element).state === "hidden") hidden++;
    }
    expect(hidden).toBe(1000);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("hundreds of case variants of one class stay fast", () => {
    const variants = Array.from({ length: 400 }, (_, i) =>
      [..."xxxxxxxxxx"].map((ch, bit) => ((i >> bit) & 1 ? ch.toUpperCase() : ch)).join(""),
    );
    const rules = Array.from({ length: 100 }, () => ".xxxxxxxxxx:hover{display:block}").join("");
    const { seen, ms } = timed(
      `<style>${rules}</style><b id="t" class="${variants.join(" ")}" style="display:none"></b>`,
    );
    expect(seen).toBe("hidden");
    expect(ms).toBeLessThan(500);
  });

  test("a page that needs too many rule checks stops settling, quickly", () => {
    const rules = Array.from({ length: 4990 }, (_, i) => `.c.d${i}{display:none}`).join("");
    const buttons = Array.from({ length: 2000 }, () => `<button class="c"></button>`).join("");
    const { document } = parseHTML(`<!doctype html><html><head><style>${rules}</style></head><body>${buttons}</body></html>`);
    const started = performance.now();
    const states = new Set<string>();
    for (let round = 0; round < 7; round++) {
      const resolver = createStaticVisibility({ ariaHidden: false });
      for (const button of document.querySelectorAll("button")) {
        states.add(resolver.visibility(button as unknown as Element).state);
      }
    }
    expect([...states].sort()).toEqual(["shown", "unknown"]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a control under thousands of nested elements stays fast", () => {
    const depth = 4000;
    const html = `<style>div{display:block}</style>${"<div>".repeat(depth)}<button id="t"></button>${"</div>".repeat(depth)}`;
    const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
    const resolver = createStaticVisibility({ ariaHidden: false });
    const started = performance.now();
    expect(resolver.visibility(document.querySelector("#t") as unknown as Element).state).toBe("shown");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// Review on pub#921: random selectors and declarations through the reader.
// It must never throw, and every element gets an answer quickly.
describe("static-hidden: <style> fuzz", () => {
  const PIECES = [
    ".a", ".A", "#t", "#T", "b", "B", "i", "*", "[x]", "[x=y]", "[x='1']", ":hover", ":not(.a)",
    ":is(b)", "::before", " ", ">", "+", "~", ",", "\\", "\\31 ", "\\\n", "&", "|", "-", "--", "2",
    "{", "}", "(", ")", "[", "]", ";", ":", "!", "\"", "'", "/*", "*/", "<!--", "-->", "@media screen{",
    "@keyframes k{", "from", "to", "50%", "@layer x;", "@import url(a);", "@namespace x;", "@\\6d edia",
    "display:none", "display:block", "display:contents", "display:revert", "visibility:hidden",
    "visibility:visible", "visibility:revert-layer", "animation:k 1s", "all:initial", "!important", "var(--x)",
  ];
  const ELEMENTS = [
    `<b id="t" class="a">x</b>`, `<i class="A a" x="y">x</i>`, `<b style="display:none">x</b>`,
    `<div style="visibility:hidden"><b>x</b></div>`, `<svg><rect x="1"/></svg>`, `<template><b>x</b></template>`,
    `<b hidden>x</b>`, `<dialog><b>x</b></dialog>`, `<i style="animation:k 1s">x</i>`,
  ];

  test("500 random sheets: no throw, every element answered", () => {
    let seed = 678;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)] as T;
    const started = performance.now();
    for (let round = 0; round < 500; round++) {
      const css = Array.from({ length: 1 + Math.floor(next() * 40) }, () => pick(PIECES)).join("");
      const body = Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(ELEMENTS)).join("");
      const { document } = parseHTML(
        `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`,
      );
      const resolver = createStaticVisibility({ ariaHidden: round % 2 === 0 });
      for (const el of document.querySelectorAll("*")) {
        expect(["shown", "hidden", "unknown"]).toContain(resolver.visibility(el as unknown as Element).state);
      }
    }
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

// pub#938: two side effects of reading `<style>` blocks (pub#921). A
// design-token block (`:root { --font-display: swap; … }`) made every element
// unknown, and a `<style>` rule that shows a `hidden` control overrode the
// `[hidden] { display: none !important }` an external sheet may hold.
describe("static-hidden: custom properties and shows over unread sheets (pub#938)", () => {
  const external = '<link rel="stylesheet" href="/site.css">';
  /** The WordPress global styles block github.blog serves, cut down. */
  const wordpress =
    "<style>:root{--wp--preset--color--black:#000000;" +
    '--wp--preset--font-family--display:"Mona Sans", sans-serif;' +
    "--wp--custom--typography--presets--6--name:Display;" +
    "--wp--custom--typography--presets--6--size:clamp(2.5rem, 5vw, 4rem);" +
    "--font:var(--text-display-shorthand);--wp--style--global--content-size:768px}" +
    ".has-display-font-family{font-family:var(--wp--preset--font-family--display) !important}</style>";

  test("a :root block of custom properties leaves every element settled", () => {
    const tokens = "<style>:root{--font-display:swap;--gap:calc(1rem + 2px)}</style>";
    expect(verdict(`${tokens}<button id="t" class="x"></button>`)).toBe("shown");
    expect(verdict(`${tokens}<div><p><b id="t">x</b></p></div>`)).toBe("shown");
    expect(verdict(`${tokens}<b id="t" hidden>x</b>`)).toBe("hidden");
  });

  test("the WordPress global styles shape, with and without an external sheet", () => {
    for (const head of [wordpress, `${external}${wordpress}`]) {
      expect(verdict(`${head}<button id="t" class="has-display-font-family"></button>`)).toBe("shown");
      expect(verdict(`${head}<main><nav><button id="t"></button></nav></main>`)).toBe("shown");
    }
    // A real hide on the same page is still read.
    expect(verdict(`${wordpress}<style>.drawer{display:none}</style><div class="drawer"><b id="t"></b></div>`)).toBe(
      "hidden",
    );
    expect(
      verdict(`${external}${wordpress}<style>.drawer{display:none}</style><div class="drawer"><b id="t"></b></div>`),
    ).toBe("unknown");
  });

  test("a :root display or visibility the reader cannot settle still reaches the page", () => {
    expect(verdict('<style>:root{display:var(--d)}</style><b id="t">x</b>')).toBe("unknown");
    expect(verdict('<style>:root{visibility:var(--v)}</style><b id="t">x</b>')).toBe("unknown");
  });

  test(":root reaches <html> alone: a child that sets visibility itself is settled", () => {
    // `:root` is a pseudo-class, so the rule is not decided; before pub#938 it
    // reached every element, `#t` included.
    const html = '<style>:root{visibility:hidden}</style><div style="visibility:visible"><b id="t">x</b></div>';
    expect(verdict(html)).toBe("shown");
    expect(verdict('<style>:root{visibility:hidden}</style><div><b id="t">x</b></div>')).toBe("unknown");
    expect(parseSelector(":root")).toEqual({
      kind: "complex",
      subject: { tag: "html", id: null, classes: [], attrs: [] },
    });
    expect(parseSelector(":root.dark")).toEqual({
      kind: "complex",
      subject: { tag: "html", id: null, classes: ["dark"], attrs: [] },
    });
    // Not the subject: `:root .x` styles `.x`, wherever it sits.
    expect(parseSelector(":root .x")).toEqual({
      kind: "complex",
      subject: { tag: null, id: null, classes: ["x"], attrs: [] },
    });
    expect(parseSelector(":not(:root)")).toEqual({
      kind: "complex",
      subject: { tag: null, id: null, classes: [], attrs: [] },
    });
  });

  test("a <style> show over the user-agent hide is unconfirmed while a sheet is unread", () => {
    const show = "<style>button{display:inline-flex}dialog{display:block}[popover]{display:block}</style>";
    expect(verdict(`${external}${show}<button id="t" hidden></button>`)).toBe("unknown");
    expect(verdict(`${external}${show}<dialog id="t"></dialog>`)).toBe("unknown");
    expect(verdict(`${external}${show}<div id="t" popover></div>`)).toBe("unknown");
    // An inline show that is not `!important` loses to an external `!important` too.
    expect(verdict(`${external}<button id="t" hidden style="display:inline-flex"></button>`)).toBe("unknown");
    // An inline `!important` show outranks every stylesheet rule.
    expect(verdict(`${external}<button id="t" hidden style="display:inline-flex !important"></button>`)).toBe(
      "shown",
    );
    // With every sheet read, the show is settled (Chromium shows it).
    expect(verdict(`${show}<button id="t" hidden></button>`)).toBe("shown");
    expect(verdict('<button id="t" hidden style="display:inline-flex"></button>')).toBe("shown");
    // Nothing the user agent hides: a show changes nothing.
    expect(verdict(`${external}${show}<button id="t"></button>`)).toBe("shown");
  });

  test("a custom property naming animation does not make <html> animated", () => {
    const keyframes = "<style>@keyframes in{from{visibility:hidden}}:root{--wp--preset--animation:fade 1s}</style>";
    expect(verdict(`${keyframes}<b id="t">x</b>`)).toBe("shown");
    expect(verdict('<style>@keyframes in{from{visibility:hidden}}.a{animation:in 1s}</style><b id="t" class="a">x</b>')).toBe(
      "unknown",
    );
  });
});
