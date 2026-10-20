// pub#940: a `<style>` rule the reader cannot decide (a combinator around the
// subject) whose declarations can only SHOW an element leaves an element
// nothing else hides shown. It matters only where something else hides the
// element (`hidden`, a closed dialog, a decided `display:none`, inherited
// `visibility:hidden`), and there the answer stays "unknown", never "hidden".
// Chromium verdicts for these shapes are rows in static-hidden-chromium.json.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { buttonNameRule } from "../src/a11y/button-name";
import { createStaticVisibility } from "../src/shared/static-hidden";
import type { ParsedPage, RuleContext } from "../src/types";

function statuses(html: string): Record<string, string> {
  const url = "https://example.com/";
  const ctx: RuleContext = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url) as ParsedPage,
    options: {},
  };
  const checks = buttonNameRule.run(ctx).checks as CheckResult[];
  return Object.fromEntries(checks.map((c) => [c.name, c.status]));
}

function state(body: string): string {
  const { document } = parsePage(
    `<!doctype html><html><head></head><body>${body}</body></html>`,
    "https://example.com/",
  ) as unknown as { document: Document };
  const el = document.getElementById("t") as Element;
  return createStaticVisibility({ ariaHidden: true }).visibility(el).state;
}

const LIGHTBOX = ".wp-lightbox-container button{align-items:center;display:flex;height:20px}";
const IMAGE = ".wp-block-image>a,.wp-block-image>figure>a{display:inline-block}";

describe("a show-only rule on an element nothing else hides", () => {
  test("WordPress lightbox button: an unnamed button fails, not unconfirmed", () => {
    expect(
      statuses(
        `<!doctype html><html lang="en"><head><title>t</title><style>${LIGHTBOX}</style></head><body><main><div class="wp-lightbox-container"><button></button></div></main></body></html>`,
      ),
    ).toEqual({ "button-name": "fail" });
  });

  test("WordPress image link rule and a plain link are shown", () => {
    expect(
      state(
        `<style>${IMAGE}</style><figure class="wp-block-image"><a id="t" href="#">x</a></figure>`,
      ),
    ).toBe("shown");
  });

  test("an unrelated button on a page that carries both WP rules is shown", () => {
    expect(state(`<style>${IMAGE}${LIGHTBOX}</style><button id="t"></button>`)).toBe("shown");
  });
});

describe("a show-only rule where something else hides the element stays unknown", () => {
  const cases: Record<string, string> = {
    "hidden attribute": `<style>${LIGHTBOX}</style><div class="wp-lightbox-container"><button id="t" hidden></button></div>`,
    "closed dialog":
      '<style>.a>dialog{display:block}</style><div class="a"><dialog id="t"></dialog></div>',
    "decided display:none":
      '<style>.x{display:none}.a>b{display:flex}</style><div class="a"><b id="t" class="x"></b></div>',
    "inherited visibility:hidden":
      '<style>.a>b{visibility:visible}</style><div class="a" style="visibility:hidden"><b id="t"></b></div>',
  };
  for (const [name, body] of Object.entries(cases)) {
    test(name, () => expect(state(body)).toBe("unknown"));
  }

  test("a hidden unnamed button is unconfirmed, not a pass or a failure", () => {
    expect(
      statuses(
        `<!doctype html><html lang="en"><head><title>t</title><style>${LIGHTBOX}</style></head><body><main><div class="wp-lightbox-container"><button hidden></button></div></main></body></html>`,
      ),
    ).toEqual({ "button-name-unconfirmed": "warn" });
  });
});

describe("controls: what a show-only rule cannot undo", () => {
  test("inline display:none beats it", () => {
    expect(
      state(
        '<style>.a>b{display:flex}</style><div class="a"><b id="t" style="display:none"></b></div>',
      ),
    ).toBe("hidden");
  });

  test("inline visibility:hidden beats it", () => {
    expect(
      state(
        '<style>.a>b{visibility:visible}</style><div class="a"><b id="t" style="visibility:hidden"></b></div>',
      ),
    ).toBe("hidden");
  });

  test("a display rule does not show a visibility:hidden element", () => {
    expect(
      state(
        '<style>.a>b{display:flex}</style><div class="a" style="visibility:hidden"><b id="t"></b></div>',
      ),
    ).toBe("hidden");
  });

  test("a rule on a descendant does not show it inside a display:none ancestor", () => {
    expect(
      state(
        '<style>.a>b{display:flex}</style><div class="a" style="display:none"><b id="t"></b></div>',
      ),
    ).toBe("hidden");
  });
});

describe("a rule that could hide keeps its elements unknown", () => {
  for (const [name, css] of Object.entries({
    "display:none": ".a>b{display:none}",
    "visibility:hidden": ".a>b{visibility:hidden}",
    "an unreadable value": ".a>b{display:var(--d)}",
    "a show and an animation": ".a>b{display:flex;animation:x 1s}",
  })) {
    test(name, () => {
      expect(state(`<style>${css}</style><div class="a"><b id="t"></b></div>`)).toBe("unknown");
    });
  }

  test("display:flex beside visibility:hidden still hides-possibly for visibility", () => {
    expect(
      state(
        '<style>.a>b{display:flex;visibility:hidden}</style><div class="a"><b id="t"></b></div>',
      ),
    ).toBe("unknown");
  });
});

describe("display values that can hide (Chromium: contents hides an input) are not show-only", () => {
  for (const value of ["contents", "inherit", "unset"]) {
    test(`display:${value}`, () => {
      expect(
        state(`<style>.a>input{display:${value}}</style><div class="a"><input id="t"></div>`),
      ).toBe("unknown");
    });
  }
});

describe("an !important show rule against a non-important inline display:none", () => {
  test("stays unknown (Chromium shows it)", () => {
    expect(
      state(
        '<style>.a>b{display:flex!important}</style><div class="a"><b id="t" style="display:none"></b></div>',
      ),
    ).toBe("unknown");
  });
});
