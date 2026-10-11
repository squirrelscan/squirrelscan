// shared/static-hidden: markup plus a strict inline-style reader (pub#664,
// pub#665). `<style>` blocks and stylesheets are not read at all. The
// CHROMIUM table pins the one invariant that matters: wherever Chromium shows
// the element, the check never answers "hidden" (that would silently drop a
// real failure). It may be more cautious ("unknown") or miss a hide.

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

  test("<style> blocks are not read", () => {
    expect(verdict('<style>.x{display:none}</style><b id="t" class="x"></b>')).toBe("shown");
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
 * `stylesheetOverride` marks a stylesheet rule this check does not read
 * showing the element again: a documented limitation.
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
  stylesheetOverride?: boolean;
}> = await Bun.file(new URL("fixtures/static-hidden-chromium.json", import.meta.url)).json();

describe("static-hidden: never hidden where Chromium shows the element", () => {
  for (const row of CHROMIUM) {
    test(`${row.name} (Chromium: ${row.chromium})`, () => {
      const seen = verdict(row.html);
      if (row.stylesheetOverride) {
        // Documented limitation: stylesheets are not read, so a stylesheet
        // rule that shows the element again is not seen.
        expect(seen).toBe("hidden");
      } else if (row.chromium === "shown") {
        expect(seen).not.toBe("hidden");
      }
    });
  }
});
