// shared/static-hidden: markup, a strict inline-style reader and the narrow
// subset of `<style>` rules shared/page-styles.ts decides (pub#664, pub#665,
// pub#678). External stylesheets are not read. The CHROMIUM table pins the one
// invariant that matters: wherever Chromium shows the element, the check never
// answers "hidden" (that would silently drop a real failure). It may be more
// cautious ("unknown") or miss a hide.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "@squirrelscan/parser/dom";

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
    // And a <style> rule that shows the element still counts.
    expect(verdict(`${external}<style>.f{display:flex}</style><div hidden class="f"><b id="t"></b></div>`)).toBe(
      "shown",
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
      "content:'x';display:none",
    ]) {
      expect(readInlineStyle(style)).toEqual(unknown);
    }
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
}> = await Bun.file(new URL("fixtures/static-hidden-chromium.json", import.meta.url)).json();

describe("static-hidden: never hidden where Chromium shows the element", () => {
  for (const row of CHROMIUM) {
    test(`${row.name} (Chromium: ${row.chromium})`, () => {
      if (row.chromium === "shown") expect(verdict(row.html)).not.toBe("hidden");
    });
  }
});

// pub#678: the <style> reader is bounded on hostile input. Past a bound it
// stops reading, and stylesheet-based hiding is no longer settled.
describe("static-hidden: <style> reading is bounded", () => {
  const timed = (body: string) => {
    const started = performance.now();
    const seen = verdict(body);
    return { seen, ms: performance.now() - started };
  };

  test("a stylesheet past the size bound is not read", () => {
    const big = `.pad{color:red}`.repeat(20_000);
    const { seen, ms } = timed(`<style>${big}.x{display:none}</style><b id="t" class="x"></b>`);
    expect(seen).toBe("shown");
    expect(ms).toBeLessThan(2000);
  });

  test("more rules than the bound: not read", () => {
    const rules = Array.from({ length: 6000 }, (_, i) => `.r${i}{display:none}`).join("");
    const { seen, ms } = timed(`<style>${rules}.x{display:none}</style><b id="t" class="x"></b>`);
    expect(seen).toBe("shown");
    expect(ms).toBeLessThan(2000);
  });

  test("an 11 KB nested stylesheet is dropped at the first nested rule", () => {
    const nested = `${".a{display:block;".repeat(700)}${"}".repeat(700)}`;
    expect(nested.length).toBeGreaterThan(11_000);
    const { seen, ms } = timed(`<style>${nested}.x{display:none}</style><b id="t" class="x"></b>`);
    expect(seen).not.toBe("hidden");
    expect(ms).toBeLessThan(2000);
  });

  test("an over-long selector is not read", () => {
    const long = `.x${".y".repeat(600)}`;
    expect(verdict(`<style>${long}{display:none}</style><b id="t" class="x"></b>`)).not.toBe("hidden");
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
