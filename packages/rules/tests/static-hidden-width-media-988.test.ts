// pub#988: an element hidden only inside width-only media queries that do not
// cover every width is shown at the other widths. The a11y style reader keeps
// it unconfirmed, with its own reason (`hidden-only-at-some-widths`) and the
// widths where it shows. Two queries that together cover every width leave it
// hidden everywhere. Anything that is not a plain width test keeps "unknown".

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parseHTML } from "@squirrelscan/parser/dom";
import { parsePage } from "@squirrelscan/parser";

import { buttonNameRule } from "../src/a11y/button-name";
import {
  coversAllWidths,
  describeShownWidths,
  readMediaWidths,
} from "../src/shared/media-widths";
import {
  createStaticVisibility,
  type StaticVisibility,
  WIDTH_REASON,
} from "../src/shared/static-hidden";
import type { ParsedPage, RuleContext } from "../src/types";

function seen(body: string, head = ""): StaticVisibility {
  const { document } = parseHTML(
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
  );
  const target = document.querySelector("#t");
  if (!target) throw new Error("fixture has no #t");
  return createStaticVisibility({ ariaHidden: false }).visibility(target as unknown as Element);
}

const drawer = (css: string, el = '<b id="t"></b>', wrap = "menu-drawer") =>
  seen(`<${wrap}>${el}</${wrap}>`, `<style>${css}</style>`);

const widthOf = (v: StaticVisibility): string | undefined =>
  v.state === "unknown" && v.reason === "width" ? v.shown : undefined;

describe("readMediaWidths", () => {
  const covers = (q: string) => {
    const w = readMediaWidths(q);
    return w === null ? null : coversAllWidths(w);
  };
  const shown = (q: string) => {
    const w = readMediaWidths(q);
    return w === null ? null : describeShownWidths(w);
  };

  test("plain width tests", () => {
    expect(shown("screen and (min-width: 990px)")).toBe("below 990px");
    expect(shown("(max-width: 989px)")).toBe("above 989px");
    expect(shown("(max-width: 989.98px)")).toBe("above 989.98px");
    expect(shown("only screen and (min-width: 62em)")).toBe("below 992px");
    expect(shown("(min-width: 61.875rem)")).toBe("below 990px");
    expect(shown("(width >= 990px)")).toBe("below 990px");
    expect(shown("(width > 990px)")).toBe("at 990px and below");
    expect(shown("(990px <= width)")).toBe("below 990px");
    expect(shown("(width < 990px)")).toBe("at 990px and above");
    expect(shown("(400px <= width <= 990px)")).toBe("below 400px and above 990px");
    expect(shown("(min-width: 400px) and (max-width: 990px)")).toBe("below 400px and above 990px");
    expect(shown("(max-width: 400px), (min-width: 990px)")).toBe("between 400px and 990px");
  });

  test("complementary ranges cover every width, a real gap does not", () => {
    expect(covers("(min-width: 990px), (max-width: 989.98px)")).toBe(true);
    expect(covers("(min-width: 990px), (max-width: 989.99px)")).toBe(true);
    expect(covers("(min-width: 990px), (max-width: 989px)")).toBe(false);
    expect(covers("(width >= 990px), (width < 990px)")).toBe(true);
    expect(covers("(width > 990px), (width < 990px)")).toBe(false);
    expect(covers("(min-width: 62em), (max-width: 61.99875em)")).toBe(true);
    expect(covers("screen")).toBe(true);
    expect(covers("(min-width: 0)")).toBe(true);
  });

  test("anything but a plain width test is not read", () => {
    for (const q of [
      "print",
      "not screen and (min-width: 990px)",
      "(min-width: 990px) and (orientation: landscape)",
      "(min-width: 990px) and (min-height: 600px)",
      "(prefers-reduced-motion: reduce)",
      "(hover: hover)",
      "(min-resolution: 2dppx)",
      "(min-width: calc(990px))",
      "(min-width: 50vw)",
      "(min-width: var(--bp))",
      "(min-width: 990)",
      "screen and(min-width: 990px)",
      "(min-width: 990px) or (max-width: 100px)",
      "((min-width: 990px))",
      "(min-width: 990px",
      "",
      "speech and (min-width: 990px)",
      "(min-width: 990px) and",
    ]) {
      expect(readMediaWidths(q)).toBeNull();
    }
  });
});

describe("a width-only hide that leaves some widths shown is unconfirmed with its own reason", () => {
  test("the theme drawer from the issue: hidden from 990px up", () => {
    const v = drawer("@media screen and (min-width: 990px) { menu-drawer { display: none } }");
    expect(v).toEqual({ state: "unknown", reason: "width", shown: "below 990px" });
  });

  test("max-width, range syntax, em units, comma lists", () => {
    expect(widthOf(drawer("@media (max-width: 749px){menu-drawer{display:none}}"))).toBe("above 749px");
    expect(widthOf(drawer("@media (width >= 990px){menu-drawer{display:none}}"))).toBe("below 990px");
    expect(widthOf(drawer("@media (min-width: 62em){menu-drawer{display:none}}"))).toBe("below 992px");
    expect(
      widthOf(drawer("@media (max-width: 400px), (min-width: 990px){menu-drawer{display:none}}")),
    ).toBe("between 400px and 990px");
  });

  test("the element itself, or an ancestor, a class, an id, a !important rule", () => {
    const css = "@media (min-width: 990px){.x{display:none}}";
    expect(widthOf(seen('<b id="t" class="x"></b>', `<style>${css}</style>`))).toBe("below 990px");
    expect(widthOf(seen('<div class="x"><p><b id="t"></b></p></div>', `<style>${css}</style>`))).toBe(
      "below 990px",
    );
    expect(widthOf(seen('<b id="t"></b>', "<style>@media (min-width:990px){#t{display:none !important}}</style>"))).toBe(
      "below 990px",
    );
  });

  test("two width rules that leave a gap: shown in the gap only", () => {
    const css =
      "@media (min-width: 990px){menu-drawer{display:none}} @media (max-width: 600px){menu-drawer{display:none}}";
    expect(widthOf(drawer(css))).toBe("between 600px and 990px");
  });

  test("nested @media inside @media intersects the widths", () => {
    const css = "@media (min-width: 400px){@media (max-width: 990px){menu-drawer{display:none}}}";
    expect(widthOf(drawer(css))).toBe("below 400px and above 990px");
  });

  test("the shown-at rule of the issue's last row does not change the answer", () => {
    const css =
      "@media (max-width: 989px){menu-drawer{display:block}} @media (min-width: 990px){menu-drawer{display:none}}";
    expect(widthOf(drawer(css))).toBe("below 990px");
  });
});

describe("hidden at every width: no new reason, treated as hidden", () => {
  test("min-width N and max-width N-0.02px, in every syntax", () => {
    for (const css of [
      "@media (min-width: 990px){menu-drawer{display:none}} @media (max-width: 989.98px){menu-drawer{display:none}}",
      "@media (min-width: 990px), (max-width: 989.98px){menu-drawer{display:none}}",
      "@media (width >= 990px){menu-drawer{display:none}} @media (width < 990px){menu-drawer{display:none}}",
      "@media (min-width: 62em){menu-drawer{display:none}} @media (max-width: 61.99875em){menu-drawer{display:none}}",
      "@media (min-width: 61.875rem){menu-drawer{display:none}} @media (max-width: 61.87375rem){menu-drawer{display:none}}",
      "@media screen{menu-drawer{display:none}}",
    ]) {
      expect(drawer(css)).toEqual({ state: "hidden" });
    }
  });

  test("a hide an ancestor and the element split between them", () => {
    const css = "@media (min-width: 990px){.a{display:none}} @media (max-width: 989.98px){.b{display:none}}";
    expect(seen('<div class="a"><span class="b"><b id="t"></b></span></div>', `<style>${css}</style>`)).toEqual({
      state: "hidden",
    });
  });

  test("a gap of a pixel is a width where it shows", () => {
    const css =
      "@media (min-width: 990px){menu-drawer{display:none}} @media (max-width: 989px){menu-drawer{display:none}}";
    expect(widthOf(drawer(css))).toBe("between 989px and 990px");
  });

  test("a point gap (> and <) is a width where it shows", () => {
    const css =
      "@media (width > 990px){menu-drawer{display:none}} @media (width < 990px){menu-drawer{display:none}}";
    expect(drawer(css).state).toBe("unknown");
  });
});

describe("anything else keeps today's unknown, with no width reason", () => {
  const generic = (v: StaticVisibility) => {
    expect(v).toEqual({ state: "unknown" });
  };

  test("non-width features, container queries, not, @supports, @layer", () => {
    for (const wrapper of [
      "@media print",
      "@media (orientation: landscape)",
      "@media (prefers-reduced-motion: reduce)",
      "@media (hover: hover)",
      "@media (min-height: 600px)",
      "@media (min-width: 990px) and (orientation: landscape)",
      "@media not screen and (min-width: 990px)",
      "@container (min-width: 990px)",
      "@supports (display: grid)",
      "@layer base",
      "@media (min-width: calc(990px))",
    ]) {
      generic(drawer(`${wrapper}{menu-drawer{display:none}}`));
    }
    generic(drawer("@supports (display:grid){@media (min-width: 990px){menu-drawer{display:none}}}"));
    generic(drawer("@media (min-width: 990px){@supports (display:grid){menu-drawer{display:none}}}"));
  });

  test("a <style media>, a titled sheet and an unread stylesheet", () => {
    const rule = "menu-drawer{display:none}";
    generic(seen('<menu-drawer><b id="t"></b></menu-drawer>', `<style media="(min-width: 990px)">${rule}</style>`));
    generic(
      drawer("@media (min-width: 990px){menu-drawer{display:none}}", '<b id="t"></b>').state === "unknown"
        ? seen(
            '<menu-drawer><b id="t"></b></menu-drawer>',
            '<link rel="stylesheet" href="/site.css"><style>@media (min-width: 990px){menu-drawer{display:none}}</style>',
          )
        : { state: "shown" },
    );
    generic(
      seen(
        '<menu-drawer><b id="t"></b></menu-drawer>',
        '<style title="alt">@media (min-width: 990px){menu-drawer{display:none}}</style>',
      ),
    );
  });

  test("a complex selector, a pseudo-class, a visibility hide", () => {
    generic(drawer("@media (min-width: 990px){div menu-drawer{display:none}}", '<b id="t"></b>'));
    generic(drawer("@media (min-width: 990px){menu-drawer:hover{display:none}}"));
    generic(drawer("@media (min-width: 990px){menu-drawer{visibility:hidden}}"));
  });

  test("a decided hide outside the media query", () => {
    generic(drawer("menu-drawer{display:none} @media (min-width: 990px){menu-drawer{display:none}}"));
  });

  test("a rule that shows a hidden element at some widths is not settled", () => {
    // `hidden` plus a width-only hide: the user-agent hide holds at every width.
    expect(
      seen('<menu-drawer hidden><b id="t"></b></menu-drawer>', "<style>@media (min-width:990px){menu-drawer{display:none}}</style>")
        .state,
    ).toBe("hidden");
  });

  test("another undecided rule beside the width rule", () => {
    generic(drawer("@media (min-width: 990px){menu-drawer{display:none}} menu-drawer:hover{display:none}"));
  });
});

describe("where a browser may rebuild the tree, a width hide is not settled for the subtree", () => {
  test("a width hide on a formatting element (<i>) leaves its descendants generic unknown", () => {
    const css = "@media (min-width: 990px){i{display:none}}";
    expect(seen('<i><b id="t"></b></i>', `<style>${css}</style>`)).toEqual({ state: "unknown" });
  });

  test("the same on a plain element reports the width reason", () => {
    const css = "@media (min-width: 990px){span{display:none}}";
    expect(widthOf(seen('<span><b id="t"></b></span>', `<style>${css}</style>`))).toBe("below 990px");
  });

  test("a hostile sheet of width rules stays fast", () => {
    const rules = Array.from({ length: 3000 }, (_, i) => `@media (min-width:${i}px){.c${i}{display:none}}`).join("");
    const buttons = Array.from({ length: 500 }, (_, i) => `<b class="c${i}"></b>`).join("");
    const { document } = parseHTML(
      `<!doctype html><html><head><style>${rules}</style></head><body>${buttons}</body></html>`,
    );
    const resolver = createStaticVisibility({ ariaHidden: false });
    const started = performance.now();
    for (const el of document.querySelectorAll("b")) resolver.visibility(el as unknown as Element);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("a decidable rule that outranks the width hide keeps the element shown there", () => {
  test("a more specific display:block wins everywhere: shown", () => {
    const css = "@media (min-width: 990px){b{display:none}} b#t{display:block}";
    expect(seen('<b id="t"></b>', `<style>${css}</style>`)).toEqual({ state: "shown" });
  });

  test("a less specific display:block loses where the media query applies", () => {
    const css = "@media (min-width: 990px){b#t{display:none}} b{display:block}";
    expect(widthOf(seen('<b id="t"></b>', `<style>${css}</style>`))).toBe("below 990px");
  });

  test("an inline display:none is a decided hide", () => {
    const css = "@media (min-width: 990px){b{display:none}}";
    expect(seen('<b id="t" style="display:none"></b>', `<style>${css}</style>`)).toEqual({ state: "hidden" });
  });

  test("an inline display:block outranks the media rule: shown", () => {
    const css = "@media (min-width: 990px){b{display:none}}";
    expect(seen('<b id="t" style="display:block"></b>', `<style>${css}</style>`)).toEqual({ state: "shown" });
  });
});

describe("the naming rule reports it unconfirmed, with the reason and widths", () => {
  function run(html: string): CheckResult[] {
    const url = "https://example.com/";
    return buttonNameRule.run({
      page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, url) as ParsedPage,
      options: {},
    } as RuleContext).checks as CheckResult[];
  }
  const page = (css: string, body: string) =>
    `<!doctype html><html lang="en"><head><title>t</title><style>${css}</style></head><body>${body}</body></html>`;

  test("button-name: the drawer button is unconfirmed, not failed", () => {
    const out = run(
      page(
        "@media screen and (min-width: 990px){menu-drawer{display:none}}",
        '<menu-drawer><button type="button"></button></menu-drawer>',
      ),
    );
    expect(out.map((c) => [c.name, c.status])).toEqual([["button-name-unconfirmed", "warn"]]);
    expect(out[0]?.message).toBe(
      "1 button(s) without accessible names hidden only at some widths by a media query (unconfirmed)",
    );
    const item = out[0]?.items?.[0];
    expect(item?.label).toContain(WIDTH_REASON);
    expect(item?.label).toContain("shown below 990px");
    expect(item?.meta).toEqual({ reason: WIDTH_REASON, shown: "below 990px" });
  });

  test("button-name: complementary ranges leave the button hidden, not reported", () => {
    const out = run(
      page(
        "@media (min-width: 990px){menu-drawer{display:none}} @media (max-width: 989.98px){menu-drawer{display:none}}",
        '<menu-drawer><button type="button"></button></menu-drawer>',
      ),
    );
    expect(out.map((c) => [c.name, c.status])).toEqual([["button-name", "pass"]]);
  });

  test("button-name: another reason keeps the generic message", () => {
    const out = run(
      page(
        "@media print{menu-drawer{display:none}}",
        '<menu-drawer><button type="button"></button></menu-drawer>',
      ),
    );
    expect(out[0]?.message).toBe("1 button(s) without accessible names may be hidden by a style (unconfirmed)");
    expect(out[0]?.items?.[0]?.meta).toBeUndefined();
  });

  test("button-name: a visible unnamed button still fails", () => {
    const out = run(
      page(
        "@media (min-width: 990px){menu-drawer{display:none}}",
        '<div><button type="button"></button></div>',
      ),
    );
    expect(out.map((c) => [c.name, c.status])).toEqual([["button-name", "fail"]]);
  });
});

// The `width: …` rows of the CHROMIUM table, rendered at several viewport widths
// (tests/fixtures/static-hidden-chromium.json). Two more invariants than the
// one in static-hidden.test.ts: an element Chromium hides at every sampled
// width is never answered "shown" (that would be a failure that is not real),
// and "hidden only at some widths" is claimed only where Chromium shows it at
// a sampled width. The rows below leave a sub-pixel or single-point gap that
// whole-pixel viewports never land in, so Chromium shows it at no sampled
// width: they keep the width reason on purpose.
const WIDTH_ROWS: Array<{
  name: string;
  html: string;
  chromium: "hidden" | "shown";
  widths?: Record<string, "hidden" | "shown">;
}> = (await Bun.file(new URL("fixtures/static-hidden-chromium.json", import.meta.url)).json()).filter(
  (row: { widths?: unknown }) => row.widths !== undefined,
);

const SUBPIXEL_GAP_ROWS = new Set(["width: min-width 990px and max-width 989px leave a gap"]);

/** What the table's complementary rows must answer: hidden at every width. */
const EXPECT_HIDDEN = new Set([
  "width: complementary min-width 990px and max-width 989.98px",
  "width: complementary comma list 990px and 989.98px",
  "width: complementary range syntax >= and <",
  "width: complementary em units 62em and 61.99875em",
  "width: an ancestor and the element split the widths",
  "width: the hidden attribute holds at every width",
]);

describe("the CHROMIUM width rows", () => {
  for (const row of WIDTH_ROWS) {
    const everyWidthHidden = Object.values(row.widths ?? {}).every((v) => v === "hidden");
    test(`${row.name}`, () => {
      const v = (() => {
        const { document } = parseHTML(
          `<!doctype html><html><head></head><body>${row.html}</body></html>`,
        );
        const target = document.querySelector("#t");
        return createStaticVisibility({ ariaHidden: false }).visibility(target as unknown as Element);
      })();
      if (row.chromium === "shown") expect(v.state).not.toBe("hidden");
      if (everyWidthHidden) expect(v.state).not.toBe("shown");
      if (v.state === "unknown" && v.reason === "width" && !SUBPIXEL_GAP_ROWS.has(row.name)) {
        expect(row.chromium).toBe("shown");
      }
      if (EXPECT_HIDDEN.has(row.name)) expect(v).toEqual({ state: "hidden" });
    });
  }

  test("the table holds the width cases", () => {
    expect(WIDTH_ROWS.length).toBeGreaterThanOrEqual(20);
  });
});

describe("impossible queries and hostile nesting (pub#988 review)", () => {
  test("a query pair that can never both match hides nothing: shown", () => {
    const css = "@media (min-width: 990px) and (max-width: 989px){menu-drawer{display:none}}";
    expect(drawer(css)).toEqual({ state: "shown" });
  });

  test("describeShownWidths of no hidden widths is safe", () => {
    expect(describeShownWidths([])).toBe("at every width");
  });

  test("deep @media nesting is capped: generic unknown, and fast", () => {
    for (const [depth, count] of [[3000, 1000], [14000, 4900]] as const) {
      const css = `${"@media all{".repeat(depth)}${".a{display:none}".repeat(count)}${"}".repeat(depth)}`;
      const started = performance.now();
      const v = seen('<b id="t" class="a"></b>', `<style>${css}</style>`);
      expect(performance.now() - started).toBeLessThan(500);
      expect(v).toEqual({ state: "unknown" });
    }
  });

  test("nesting within the cap is still read", () => {
    const css = `${"@media all{".repeat(7)}@media (min-width: 990px){menu-drawer{display:none}}${"}".repeat(7)}`;
    expect(widthOf(drawer(css))).toBe("below 990px");
    const deeper = `${"@media all{".repeat(8)}@media (min-width: 990px){menu-drawer{display:none}}${"}".repeat(8)}`;
    expect(drawer(deeper)).toEqual({ state: "unknown" });
  });
});
